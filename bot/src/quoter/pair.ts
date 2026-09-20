import BN from "bn.js";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { summarizeDlmm } from "../decoders/meteora_dlmm";
import { summarizeDammV2 } from "../decoders/meteora_damm_v2";
import { quoteDlmm, type DlmmQuoteState } from "./dlmm";
import { quoteDammV2 } from "./damm_v2";
import { solToLamports, type Clock, type LegQuote, type Side } from "./types";

/** One pool, ready to quote: a name, its worst-case fee, and a function that quotes a buy or a sell through its real liquidity. */
export type QuotablePool = {
  label: string;
  /** Worst-case fee in basis points, from the decoder. Pools above the cap are left out of pairing (launch-fee traps). */
  feeBps: number;
  quote: (side: Side, amountIn: BN) => LegQuote;
};

export function dlmmQuotable(label: string, state: DlmmQuoteState, clock: Clock): QuotablePool {
  return { label, feeBps: summarizeDlmm(state.address, state.lbPair, 0, 0).totalFeeBps, quote: (side, amountIn) => quoteDlmm(state, side, amountIn, clock) };
}

export function dammQuotable(label: string, address: string, state: PoolState, clock: Clock): QuotablePool {
  return { label, feeBps: summarizeDammV2(address, state, 0, 0).totalFeeBps, quote: (side, amountIn) => quoteDammV2(state, side, amountIn, clock) };
}

/** The atomic trade we would send: spend sizeSol on one pool, sell every token received on the other. */
export type RoundTrip = {
  buyOn: string;
  sellOn: string;
  sizeSol: number;
  /** What comes back, as a percent of what went in: fees and depth of both pools included. null when a pool cannot fill the trade. */
  netPct: number | null;
  /** Why there is no number (for example, not enough liquidity in the bin arrays we hold). */
  error?: string;
};

export function roundTrip(buyOn: QuotablePool, sellOn: QuotablePool, sizeSol: number, bought?: LegQuote): RoundTrip {
  const base = { buyOn: buyOn.label, sellOn: sellOn.label, sizeSol };
  try {
    const buy = bought ?? buyOn.quote("buy", solToLamports(sizeSol));
    const sell = sellOn.quote("sell", buy.amountOut);
    return { ...base, netPct: (Number(sell.amountOut.toString()) / Number(buy.amountIn.toString()) - 1) * 100 };
  } catch (e) {
    return { ...base, netPct: null, error: (e as Error).message };
  }
}

/** Every direction between every two eligible pools of one token, at every size. The buy leg is quoted once per pool and size. */
export function allRoundTrips(pools: QuotablePool[], sizesSol: number[], maxFeeBps: number): RoundTrip[] {
  const eligible = pools.filter((p) => p.feeBps <= maxFeeBps);
  const out: RoundTrip[] = [];
  for (const sizeSol of sizesSol) for (const a of eligible) {
    let bought: LegQuote | undefined;
    try { bought = a.quote("buy", solToLamports(sizeSol)); } catch { /* roundTrip below reports the reason */ }
    for (const b of eligible) if (b !== a) out.push(roundTrip(a, b, sizeSol, bought));
  }
  return out;
}

/** The best executable round trip at each size (the number the logger will record), or null when nothing could be quoted. */
export function bestPerSize(trips: RoundTrip[]): Map<number, RoundTrip | null> {
  const best = new Map<number, RoundTrip | null>();
  for (const t of trips) {
    if (!best.has(t.sizeSol)) best.set(t.sizeSol, null);
    const cur = best.get(t.sizeSol);
    if (t.netPct !== null && (!cur || t.netPct > cur.netPct!)) best.set(t.sizeSol, t);
  }
  return best;
}
