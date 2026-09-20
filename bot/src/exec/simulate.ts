import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { WSOL } from "../config/watchlist";
import type { Welded } from "./weld";

// Run a welded trade against live chain state WITHOUT sending it. simulateTransaction executes both swaps on a
// validator's copy of the world and reports what would have happened. No signature, no wallet, nothing moves.
//
// Two things a simulation forces on us:
//  1. It executes for real, so the payer must EXIST and hold the SOL. We have no wallet, so a funded PUBLIC address
//     stands in. Nothing is signed or sent, so that address cannot be affected: this is a read-only calculation.
//  2. A busy payer's own traffic moves its balance between the read and the run, swamping a 0.5 SOL trade. So the
//     measurement comes from the WRAPPED-SOL account instead: the buy pays out of it and the sell pays back into it,
//     so its balance belongs to this trade alone.
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLIPPAGE_MARKERS = ["SlippageToleranceExceeded", "Slippage", "slippage", "0x1771", "ExceededSlippage", "MinimumOut", "min_out"];
const FUNDS_MARKERS = ["insufficient lamports", "InsufficientFunds", "Insufficient Funds", "debit an account", "AccountNotFound"];

export type SimResult = {
  ok: boolean;
  err: string | null;
  slot: number;
  unitsConsumed: number | null;
  /** The trade's own wrapped-SOL account: tokens held before, after, and the difference. The honest measure. */
  wsolAccount: string;
  wsolBefore: number | null;
  wsolAfter: number | null;
  wsolDelta: number | null;
  netPctSimulated: number | null;
  /** The profit check firing: a swap refused to pay out less than its quoted minimum, so the whole trade cancelled. */
  slippageRejected: boolean;
  /** The stand-in payer does not exist or cannot cover the trade; nothing is learnt about the swaps themselves. */
  underfunded: boolean;
  logTail: string[];
};

/** The associated token account of a mint for an owner: the standard address a wallet's tokens live at. */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}
/** An SPL token account is 165 bytes: mint (32), owner (32), then the amount as a little-endian u64 at offset 64. */
function tokenAmount(data: Buffer | null): number | null {
  return data && data.length >= 72 ? Number(data.readBigUInt64LE(64)) : null;
}

export async function simulateWelded(conn: Connection, w: Welded, payer: PublicKey): Promise<SimResult> {
  const wsolAta = associatedTokenAddress(new PublicKey(WSOL), payer);
  // Read at the same commitment the simulation runs at, so "before" and "after" describe one world.
  const pre = await conn.getAccountInfo(wsolAta, "processed");
  const before = pre ? tokenAmount(Buffer.from(pre.data)) : 0;

  const res = await conn.simulateTransaction(new VersionedTransaction(w.message), {
    sigVerify: false,             // no signature exists, and none is needed for a dry run
    replaceRecentBlockhash: true, // the placeholder blockhash is swapped for a live one
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [wsolAta.toBase58()] },
  });
  const v = res.value as any;
  const logs: string[] = v.logs ?? [];
  const err = v.err ? JSON.stringify(v.err) : null;
  const haystack = [err ?? "", ...logs].join("\n");
  const raw: string | undefined = v.accounts?.[0]?.data?.[0];
  const after = raw === undefined ? null : tokenAmount(Buffer.from(raw, "base64"));
  // The trade WRAPS its input into this account, swaps twice, then leaves the proceeds here. So the balance grows by
  // the whole trade size plus whatever the round trip made or lost. Subtract the size to get the result itself.
  const delta = after === null || before === null ? null : after - before - w.sizeLamports;
  return {
    ok: !v.err,
    err,
    slot: res.context.slot,
    unitsConsumed: v.unitsConsumed ?? null,
    wsolAccount: wsolAta.toBase58(),
    wsolBefore: before,
    wsolAfter: after,
    wsolDelta: delta,
    netPctSimulated: delta === null ? null : (delta / w.sizeLamports) * 100,
    slippageRejected: !!err && SLIPPAGE_MARKERS.some((m) => haystack.includes(m)),
    underfunded: !!err && FUNDS_MARKERS.some((m) => haystack.includes(m)),
    logTail: logs.slice(-8),
  };
}
