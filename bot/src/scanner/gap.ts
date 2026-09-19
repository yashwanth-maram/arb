export type GapResult = {
  /** (priceA - priceB) / priceB, in percent. Positive means A is more expensive. */
  gapPct: number;
  /** Sum of both pools' current fees, in percent: the cost of a round trip. */
  feeFloorPct: number;
  /** |gap| minus fee floor. Only a positive value can ever be a trade. */
  netPct: number;
  direction: "buy_b_sell_a" | "buy_a_sell_b" | "flat";
};

export function gapNetOfFees(priceA: number, feeBpsA: number, priceB: number, feeBpsB: number): GapResult {
  const gapPct = ((priceA - priceB) / priceB) * 100;
  const feeFloorPct = (feeBpsA + feeBpsB) / 100;
  const netPct = Math.abs(gapPct) - feeFloorPct;
  const direction = gapPct > 0 ? "buy_b_sell_a" : gapPct < 0 ? "buy_a_sell_b" : "flat";
  return { gapPct, feeFloorPct, netPct, direction };
}