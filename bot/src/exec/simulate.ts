import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { Welded } from "./weld";

// Run a welded trade against live chain state WITHOUT sending it. simulateTransaction executes both swaps on a
// validator's copy of the world and reports what would have happened. No signature, no wallet, nothing moves.
//
// One catch worth understanding: a simulation executes for real against that copy, so the payer must actually HOLD
// the SOL being swapped. An empty address fails at the very first step and teaches us nothing about the swaps. So a
// funded PUBLIC address stands in as the payer. Nothing is ever signed or sent, so that address cannot be affected;
// this is a read-only calculation against public state, the same as asking "what would this trade do".
const SLIPPAGE_MARKERS = ["SlippageToleranceExceeded", "Slippage", "slippage", "0x1771", "ExceededSlippage", "MinimumOut", "min_out"];
const FUNDS_MARKERS = ["insufficient lamports", "InsufficientFunds", "Insufficient Funds", "0x1", "debit an account"];

export type SimResult = {
  ok: boolean;
  err: string | null;
  slot: number;
  unitsConsumed: number | null;
  /** The payer's SOL before and after, and the difference. This is the truth: it is measured, not quoted. */
  lamportsBefore: number | null;
  lamportsAfter: number | null;
  lamportsDelta: number | null;
  netPctSimulated: number | null;
  /** The profit check firing: a swap refused to pay out less than its quoted minimum, so the whole trade cancelled. */
  slippageRejected: boolean;
  /** The stand-in payer did not hold enough SOL. Nothing is learnt about the swaps themselves. */
  underfunded: boolean;
  logTail: string[];
};

export async function simulateWelded(conn: Connection, w: Welded, payer: PublicKey): Promise<SimResult> {
  const before = await conn.getBalance(payer, "processed");
  const res = await conn.simulateTransaction(new VersionedTransaction(w.message), {
    sigVerify: false,            // no signature exists, and none is needed for a dry run
    replaceRecentBlockhash: true, // the placeholder blockhash is swapped for a live one
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  const v = res.value as any;
  const logs: string[] = v.logs ?? [];
  const err = v.err ? JSON.stringify(v.err) : null;
  const haystack = [err ?? "", ...logs].join("\n");
  const after: number | null = v.accounts?.[0]?.lamports ?? null;
  const delta = after === null ? null : after - before;
  return {
    ok: !v.err,
    err,
    slot: res.context.slot,
    unitsConsumed: v.unitsConsumed ?? null,
    lamportsBefore: before,
    lamportsAfter: after,
    lamportsDelta: delta,
    netPctSimulated: delta === null ? null : (delta / w.sizeLamports) * 100,
    slippageRejected: !!err && SLIPPAGE_MARKERS.some((m) => haystack.includes(m)),
    underfunded: !!err && FUNDS_MARKERS.some((m) => haystack.includes(m)),
    logTail: logs.slice(-8),
  };
}
