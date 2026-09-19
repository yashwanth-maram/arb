import BN from "bn.js";

/** "Now" in both clocks a pool may use: some pools count in slots, others in unix seconds. */
export type Clock = { slot: number; unixTime: number };

/** buy = SOL in, token out.  sell = token in, SOL out. */
export type Side = "buy" | "sell";

/** One swap through one pool, quoted through its real liquidity, fee included. */
export type LegQuote = {
  side: Side;
  /** Raw units in: lamports for a buy, token base units for a sell. */
  amountIn: BN;
  /** Raw units out after the pool's fee: token base units for a buy, lamports for a sell. */
  amountOut: BN;
  /** Fee the pool kept, in raw units of whichever token it charges the fee in. */
  fee: BN;
  /** Fee rate this swap actually paid, in basis points. */
  feeBps: number;
};

const LAMPORTS_PER_SOL = 1e9;

/** SOL per token actually paid (buy) or received (sell), adjusted for decimals. */
export function effectivePrice(q: LegQuote, tokenDecimals: number): number {
  const lamports = q.side === "buy" ? q.amountIn : q.amountOut;
  const tokenUnits = q.side === "buy" ? q.amountOut : q.amountIn;
  return Number(lamports.toString()) / LAMPORTS_PER_SOL / (Number(tokenUnits.toString()) / 10 ** tokenDecimals);
}

/** SOL to lamports, rounded to a whole lamport (0.1 SOL = exactly 100,000,000). */
export function solToLamports(sol: number): BN {
  return new BN(Math.round(sol * LAMPORTS_PER_SOL));
}
