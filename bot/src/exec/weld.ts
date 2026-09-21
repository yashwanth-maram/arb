import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage,
  type Connection, type MessageV0,
} from "@solana/web3.js";
import { associatedTokenAddress } from "./simulate";
import { WSOL } from "../config/watchlist";
import { requestJson } from "./http";

// The welded trade: buy a token with SOL and sell every unit straight back, as ONE Solana transaction built from
// Jupiter's raw swap instructions. A transaction is all-or-nothing, so a single failing instruction reverts it all.
// That is what makes a profit check possible without a program of our own. Nothing here signs or sends: it only builds.
export const TX_SIZE_LIMIT = 1232;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DUMMY_BLOCKHASH = "11111111111111111111111111111111"; // size does not depend on the value; a simulation replaces it

export type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type SwapIxResponse = {
  setupInstructions?: JupIx[]; swapInstruction: JupIx; cleanupInstruction?: JupIx | null; otherInstructions?: JupIx[];
  addressLookupTableAddresses?: string[]; addressesByLookupTableAddress?: Record<string, string[]> | null;
};
export type WeldOptions = { base?: string; maxAccounts?: number; slippageBps?: number; computeUnitPriceMicroLamports?: number; connection?: Connection;
  /** Leave the final unwrap out. The wrapped-SOL account then survives, so a simulation can read what came back. */
  keepWsolAccount?: boolean;
  /** Demand this many lamports back from the sell leg, whatever the quote says. Jupiter honours this on some routes
   * and silently ignores it on others, so it is a hint, not a guarantee. */
  minOutLamports?: number;
  /** OUR OWN profit check, which nothing can ignore: after both swaps, move exactly this many lamports of wrapped
   * SOL out of the trade's account. Too little came back -> the transfer fails -> the whole transaction reverts.
   * Requires a payer whose wrapped-SOL account does not already exist, or an old balance would pay for it. */
  requireLamportsOut?: number };
// Without a lookup table every account costs 32 bytes, so two legs fit only up to about 30 accounts in total.
// Routes differ per token, so try progressively narrower routes rather than guessing one width for all of them.
export const MAX_ACCOUNTS_LADDER = [14, 12, 10, 8];
export type Welded = {
  sizeLamports: number; tokensQuoted: string; lamportsBackQuoted: number; netPct: number;
  buyVia: string[]; sellVia: string[]; buySlot: number; sellSlot: number;
  instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[]; message: MessageV0;
  sizeBytes: number; fits: boolean; staticAccounts: number; lookedUpAccounts: number; droppedDuplicates: number;
  maxAccountsUsed: number; attempts: string[];
  /** The floor our own transfer enforces, if any. */
  requiredOut: number | null;
  /** What the sell leg was told to accept as a minimum, and the raw instruction data, so a caller can prove it changed. */
  minOutDemanded: number; sellSwapData: string;
};

const toIx = (ix: JupIx) => new TransactionInstruction({
  programId: new PublicKey(ix.programId),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(ix.data, "base64"),
});
const ixKey = (ix: JupIx) => `${ix.programId}|${ix.accounts.map((a) => a.pubkey).join(",")}|${ix.data}`;
const venues = (q: any): string[] => [...new Set<string>((q.routePlan ?? []).map((s: any) => s.swapInfo.label))];

async function quote(base: string, inputMint: string, outputMint: string, amount: string, o: Required<Pick<WeldOptions, "maxAccounts" | "slippageBps">>) {
  const r = await requestJson("GET", `${base}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${o.slippageBps}&restrictIntermediateTokens=true&maxAccounts=${o.maxAccounts}`);
  if (r.status !== 200 || !r.body?.outAmount) throw new Error(`quote ${inputMint.slice(0, 4)}->${outputMint.slice(0, 4)}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.body;
}
async function swapInstructions(base: string, quoteResponse: unknown, user: string): Promise<SwapIxResponse> {
  const r = await requestJson("POST", `${base}/swap/v1/swap-instructions`, { quoteResponse, userPublicKey: user, wrapAndUnwrapSol: true });
  if (r.status !== 200 || !r.body?.swapInstruction) throw new Error(`swap-instructions: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.body;
}

/** Lookup tables let a transaction name an account with 1 byte instead of 32. Jupiter returns their contents; if it does not, read them from the chain. */
async function lookupTables(parts: SwapIxResponse[], connection?: Connection): Promise<AddressLookupTableAccount[]> {
  const out = new Map<string, AddressLookupTableAccount>();
  for (const p of parts) for (const key of p.addressLookupTableAddresses ?? []) {
    if (out.has(key)) continue;
    const listed = p.addressesByLookupTableAddress?.[key];
    if (listed?.length) {
      out.set(key, new AddressLookupTableAccount({ key: new PublicKey(key), state: {
        addresses: listed.map((a) => new PublicKey(a)), authority: undefined,
        deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 } }));
    } else if (connection) {
      const got = (await connection.getAddressLookupTable(new PublicKey(key))).value;
      if (got) out.set(key, got);
    }
  }
  return [...out.values()];
}

/** One attempt at a given route width. Narrower routes touch fewer pools, so the message is smaller. */
async function buildAt(tokenMint: string, sizeLamports: number, user: PublicKey, opts: WeldOptions, maxAccounts: number): Promise<Welded> {
  const base = opts.base ?? process.env.JUP_BASE ?? "https://lite-api.jup.ag";
  const o = { maxAccounts, slippageBps: opts.slippageBps ?? 0 };
  const buy = await quote(base, WSOL, tokenMint, String(sizeLamports), o);
  const sell = await quote(base, tokenMint, WSOL, buy.outAmount, o); // sell exactly what the buy is quoted to deliver
  // Raise the sell leg's floor. Jupiter encodes otherAmountThreshold into the swap instruction on some routes and
  // ignores it on others, so this is a hint; requireLamportsOut below is the check that actually binds.
  const minOutDemanded = opts.minOutLamports ?? Number(sell.otherAmountThreshold ?? sell.outAmount);
  if (opts.minOutLamports !== undefined) sell.otherAmountThreshold = String(opts.minOutLamports);
  const [a, b] = await Promise.all([swapInstructions(base, buy, user.toBase58()), swapInstructions(base, sell, user.toBase58())]);

  // Order: wrap SOL and open token accounts, buy, sell, our profit check, then optionally unwrap back to SOL.
  const cleanup = opts.keepWsolAccount ? [] : (b.cleanupInstruction ? [b.cleanupInstruction] : []);
  // Our own profit check: a plain SPL token transfer of the demanded amount out of the trade's wrapped-SOL account.
  // The token program refuses to move more than the account holds, and one failed instruction reverts everything.
  const proof: JupIx[] = [];
  if (opts.requireLamportsOut !== undefined) {
    const wsol = new PublicKey(WSOL);
    const from = associatedTokenAddress(wsol, user);
    // The destination is irrelevant: nothing is ever sent in a simulation, and the test is whether the transfer CAN be made.
    const sink = new PublicKey(WSOL);
    const to = associatedTokenAddress(wsol, sink);
    const acc = (pubkey: string, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
    proof.push({ // create the destination if it does not exist (idempotent: instruction 1 of the ATA program)
      programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      accounts: [acc(user.toBase58(), true, true), acc(to.toBase58(), false, true), acc(sink.toBase58(), false, false),
        acc(WSOL, false, false), acc("11111111111111111111111111111111", false, false), acc(TOKEN_PROGRAM, false, false)],
      data: Buffer.from([1]).toString("base64"),
    });
    const amount = Buffer.alloc(9); amount.writeUInt8(3, 0); amount.writeBigUInt64LE(BigInt(opts.requireLamportsOut), 1);
    proof.push({ // SPL Token Transfer (instruction 3): from, to, owner
      programId: TOKEN_PROGRAM,
      accounts: [acc(from.toBase58(), false, true), acc(to.toBase58(), false, true), acc(user.toBase58(), true, false)],
      data: amount.toString("base64"),
    });
  }
  // De-duplicate only Jupiter's own steps (both legs ask to open the same accounts). OUR proof instructions must
  // never be dropped: the account-creation step is byte-identical to one of Jupiter's, and when that matched, the
  // transfer after it was removed too and the profit check silently vanished from the transaction.
  const jupiterSteps: JupIx[] = [...(a.setupInstructions ?? []), a.swapInstruction, ...(b.setupInstructions ?? []), b.swapInstruction];
  const seen = new Set<string>();
  const kept = [...jupiterSteps.filter((ix) => (seen.has(ixKey(ix)) ? false : (seen.add(ixKey(ix)), true))), ...proof, ...cleanup];
  const wanted: JupIx[] = [...jupiterSteps, ...proof, ...cleanup];
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports ?? 0 }),
    ...kept.map(toIx),
  ];

  const tables = await lookupTables([a, b], opts.connection);
  // A route with no lookup table must spell out every account at 32 bytes, and web3.js throws while encoding once
  // that overruns the limit. Report it as an oversized build instead, so the caller learns which routes are too wide.
  let message: MessageV0, sizeBytes: number;
  try {
    message = new TransactionMessage({ payerKey: user, recentBlockhash: DUMMY_BLOCKHASH, instructions }).compileToV0Message(tables);
    sizeBytes = 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
  } catch (e) {
    const accounts = new Set<string>();
    for (const ix of instructions) { accounts.add(ix.programId.toBase58()); ix.keys.forEach((k) => accounts.add(k.pubkey.toBase58())); }
    throw new Error(`too big to encode: ${accounts.size} accounts across ${instructions.length} instructions, ${tables.length} lookup table(s) (${(e as Error).message})`);
  }
  const back = Number(sell.outAmount);
  return {
    sizeLamports, tokensQuoted: buy.outAmount, lamportsBackQuoted: back, netPct: (back / sizeLamports - 1) * 100,
    buyVia: venues(buy), sellVia: venues(sell), buySlot: buy.contextSlot ?? 0, sellSlot: sell.contextSlot ?? 0,
    instructions, lookupTables: tables, message, sizeBytes, fits: sizeBytes <= TX_SIZE_LIMIT, maxAccountsUsed: maxAccounts, attempts: [],
    minOutDemanded, sellSwapData: b.swapInstruction.data, requiredOut: opts.requireLamportsOut ?? null,
    staticAccounts: message.staticAccountKeys.length,
    lookedUpAccounts: message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0),
    droppedDuplicates: wanted.length - kept.length,
  };
}

/** Build the welded trade, narrowing the route until the message encodes and fits with a real margin. */
export async function buildWeldedTrade(tokenMint: string, sizeLamports: number, user: PublicKey, opts: WeldOptions = {}): Promise<Welded> {
  const ladder = opts.maxAccounts ? [opts.maxAccounts] : MAX_ACCOUNTS_LADDER;
  const attempts: string[] = [];
  let lastError = "";
  for (const maxAccounts of ladder) {
    try {
      const w = await buildAt(tokenMint, sizeLamports, user, opts, maxAccounts);
      attempts.push(`${maxAccounts}:${w.sizeBytes}b`);
      if (w.fits) return { ...w, attempts };
      lastError = `${w.sizeBytes} bytes, over by ${w.sizeBytes - TX_SIZE_LIMIT}`;
    } catch (e) {
      lastError = (e as Error).message;
      attempts.push(`${maxAccounts}:${lastError.startsWith("too big") ? "too big" : "error"}`);
      if (!lastError.startsWith("too big")) throw e; // a quote or network failure is not a size problem
    }
  }
  throw new Error(`no route fits in one transaction (tried ${attempts.join(", ")}): ${lastError}`);
}
