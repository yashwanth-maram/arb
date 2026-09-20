import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage,
  type Connection, type MessageV0,
} from "@solana/web3.js";
import { WSOL } from "../config/watchlist";
import { requestJson } from "./http";

// The welded trade: buy a token with SOL and sell every unit straight back, as ONE Solana transaction built from
// Jupiter's raw swap instructions. A transaction is all-or-nothing, and each swap carries its own minimum output,
// so with slippage 0 the second swap refuses to pay out less than its quote and the whole trade cancels. That is
// the profit check, and it needs no program of our own. Nothing here signs or sends: it only builds.
export const TX_SIZE_LIMIT = 1232;
const DUMMY_BLOCKHASH = "11111111111111111111111111111111"; // size does not depend on the value; a simulation replaces it

export type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type SwapIxResponse = {
  setupInstructions?: JupIx[]; swapInstruction: JupIx; cleanupInstruction?: JupIx | null; otherInstructions?: JupIx[];
  addressLookupTableAddresses?: string[]; addressesByLookupTableAddress?: Record<string, string[]> | null;
};
export type WeldOptions = { base?: string; maxAccounts?: number; slippageBps?: number; computeUnitPriceMicroLamports?: number; connection?: Connection };
export type Welded = {
  sizeLamports: number; tokensQuoted: string; lamportsBackQuoted: number; netPct: number;
  buyVia: string[]; sellVia: string[]; buySlot: number; sellSlot: number;
  instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[]; message: MessageV0;
  sizeBytes: number; fits: boolean; staticAccounts: number; lookedUpAccounts: number; droppedDuplicates: number;
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

export async function buildWeldedTrade(tokenMint: string, sizeLamports: number, user: PublicKey, opts: WeldOptions = {}): Promise<Welded> {
  const base = opts.base ?? process.env.JUP_BASE ?? "https://lite-api.jup.ag";
  const o = { maxAccounts: opts.maxAccounts ?? 20, slippageBps: opts.slippageBps ?? 0 };
  const buy = await quote(base, WSOL, tokenMint, String(sizeLamports), o);
  const sell = await quote(base, tokenMint, WSOL, buy.outAmount, o); // sell exactly what the buy is quoted to deliver
  const [a, b] = await Promise.all([swapInstructions(base, buy, user.toBase58()), swapInstructions(base, sell, user.toBase58())]);

  // Order: wrap SOL and open token accounts, buy, sell, then unwrap everything back to SOL. The first leg's own
  // clean-up is left out (it would close the wrapped-SOL account the second leg pays into), and steps both legs ask
  // for, such as opening the same token account, are kept once.
  const wanted: JupIx[] = [...(a.setupInstructions ?? []), a.swapInstruction, ...(b.setupInstructions ?? []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : [])];
  const seen = new Set<string>();
  const kept = wanted.filter((ix) => (seen.has(ixKey(ix)) ? false : (seen.add(ixKey(ix)), true)));
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports ?? 0 }),
    ...kept.map(toIx),
  ];

  const tables = await lookupTables([a, b], opts.connection);
  const message = new TransactionMessage({ payerKey: user, recentBlockhash: DUMMY_BLOCKHASH, instructions }).compileToV0Message(tables);
  const sizeBytes = 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
  const back = Number(sell.outAmount);
  return {
    sizeLamports, tokensQuoted: buy.outAmount, lamportsBackQuoted: back, netPct: (back / sizeLamports - 1) * 100,
    buyVia: venues(buy), sellVia: venues(sell), buySlot: buy.contextSlot ?? 0, sellSlot: sell.contextSlot ?? 0,
    instructions, lookupTables: tables, message, sizeBytes, fits: sizeBytes <= TX_SIZE_LIMIT,
    staticAccounts: message.staticAccountKeys.length,
    lookedUpAccounts: message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0),
    droppedDuplicates: wanted.length - kept.length,
  };
}
