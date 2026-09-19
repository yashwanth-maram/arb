import { gapNetOfFees, type GapResult } from "./gap";

export type PoolSnap = { price: number; feeBps: number; slot: number; ts: number };
export type BestPair = GapResult & { a: string; b: string };

/**
 * Among all pools of one token, find the pair with the highest gap net of both fees.
 * Pools above maxFeeBps are ignored. Returns null with fewer than two eligible pools.
 */
export function bestPair(snaps: Map<string, PoolSnap>, maxFeeBps: number): BestPair | null {
  const labels = [...snaps.keys()].filter((l) => snaps.get(l)!.feeBps <= maxFeeBps && snaps.get(l)!.price > 0);
  let best: BestPair | null = null;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = snaps.get(labels[i])!, b = snaps.get(labels[j])!;
      const g = gapNetOfFees(a.price, a.feeBps, b.price, b.feeBps);
      if (!best || g.netPct > best.netPct) best = { ...g, a: labels[i], b: labels[j] };
    }
  }
  return best;
}