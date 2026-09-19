import BN from "bn.js";
import {
  ActivationType,
  TradeDirection,
  getFeeMode,
  getSwapResultFromExactInput,
  isSwapEnabled,
  type PoolState,
} from "@meteora-ag/cp-amm-sdk";
import { WSOL } from "../config/watchlist";
import type { Clock, LegQuote, Side } from "./types";

/**
 * A DAMM v2 pool counts time either in slots or in unix seconds (its activationType). Fees that change
 * over time and the "is swapping open yet" check both use that clock, so the quote must use the same one.
 * Passing a slot to a timestamp pool makes the SDK answer "Swap is disabled".
 */
export function currentPoint(pool: PoolState, clock: Clock): BN {
  return new BN(pool.activationType === ActivationType.Slot ? clock.slot : clock.unixTime);
}

/**
 * Depth-aware quote for one swap through a DAMM v2 pool, computed by the SDK's own swap math from the
 * pool account alone. Only for pools with SOL on one side and classic SPL Token mints on both
 * (Token-2022 transfer fees are not modelled).
 */
export function quoteDammV2(pool: PoolState, side: Side, amountIn: BN, clock: Clock): LegQuote {
  const solIsA = pool.tokenAMint.toBase58() === WSOL;
  const solIsB = pool.tokenBMint.toBase58() === WSOL;
  if (solIsA === solIsB) throw new Error("pool must have SOL on exactly one side");
  if (amountIn.lten(0)) throw new Error("amountIn must be greater than 0");

  const point = currentPoint(pool, clock);
  if (!isSwapEnabled(pool, point)) throw new Error("swap disabled (pool status or activation point)");

  // The input token decides the direction: a buy puts SOL in, a sell puts the token in.
  const aToB = side === "buy" ? solIsA : solIsB;
  const direction = aToB ? TradeDirection.AtoB : TradeDirection.BtoA;
  const feeMode = getFeeMode(pool.collectFeeMode, direction, false);
  const r = getSwapResultFromExactInput(pool, amountIn, feeMode, direction, point);

  const fee = r.claimingFee.add(r.protocolFee).add(r.compoundingFee).add(r.referralFee);
  // The fee comes off the input before the swap, or off the output after it, depending on the pool's mode.
  const feeBase = feeMode.feesOnInput ? amountIn : r.outputAmount.add(fee);
  const feeBps = feeBase.isZero() ? 0 : (Number(fee.toString()) / Number(feeBase.toString())) * 10_000;
  return { side, amountIn, amountOut: r.outputAmount, fee, feeBps };
}
