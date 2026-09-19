import { describe, it, expect } from "vitest";
import { bestPair, type PoolSnap } from "../src/scanner/best_pair";

const snap = (price: number, feeBps: number): PoolSnap => ({ price, feeBps, slot: 1, ts: 0 });

describe("bestPair", () => {
  it("picks the pair with the highest net gap and ignores punitive-fee pools", () => {
    const snaps = new Map<string, PoolSnap>([
      ["dlmm80", snap(3.4091e-8, 100.48)],
      ["dlmm20", snap(3.3921e-8, 20.125)],
      ["damm1", snap(2.1190e-8, 4500)],   // 45% fee launch pool: must be excluded even though its "gap" is huge
      ["damm2", snap(3.3717e-8, 100)],
    ]);
    const b = bestPair(snaps, 500)!;
    expect(b).not.toBeNull();
    // dlmm20 vs damm2: gap 0.605% minus floor 1.201% beats dlmm80 vs damm2 (1.109% minus 2.005%)
    expect([b.a, b.b].sort()).toEqual(["damm2", "dlmm20"]);
    expect(b.netPct).toBeCloseTo(0.60504 - 1.20125, 3);
    expect(b.direction).toBe("buy_b_sell_a");
  });
  it("returns null with fewer than two eligible pools", () => {
    expect(bestPair(new Map([["only", snap(1, 10)]]), 500)).toBeNull();
    expect(bestPair(new Map([["a", snap(1, 10)], ["b", snap(1.5, 4500)]]), 500)).toBeNull();
  });
});