import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeDlmmPool } from "../src/decoders/meteora_dlmm";
import { decodeDammV2Pool } from "../src/decoders/meteora_damm_v2";
import { gapNetOfFees } from "../src/scanner/gap";

const fx = (label: string) => {
  const f = JSON.parse(readFileSync(resolve("test/fixtures", `${label}.json`), "utf8"));
  return { address: f.address as string, slot: f.slot as number, data: Buffer.from(f.dataBase64, "base64") };
};
const PERPSPAD = "PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL";
const WSOL = "So11111111111111111111111111111111111111112";

describe("Meteora DLMM decoder (fixture slot 448334506)", () => {
  const f = fx("dlmm_pool");
  const s = decodeDlmmPool(f.address, f.data, 6, 9);

  it("identifies the pool and its accounts", () => {
    expect(s.tokenXMint).toBe(PERPSPAD);
    expect(s.tokenYMint).toBe(WSOL);
    expect(s.reserveX).toBe("Gj7XhZqxg5CVbdpsMfKHjCVihbBLVoLcv7VUrShLHQ7v");
    expect(s.reserveY).toBe("3DbxfpKznPLs2AP6BRuLHofGXz1UuRQN1Vo2fpYBz4JH");
  });
  it("reads bin step, active bin and fees", () => {
    expect(s.binStep).toBe(80);
    expect(s.activeId).toBe(-375);
    expect(s.baseFeeBps).toBe(80);
    expect(s.totalFeeBps).toBeGreaterThanOrEqual(80);
    expect(s.totalFeeBps).toBeLessThan(81);
  });
  it("derives the price from the active bin", () => {
    const expected = Math.pow(1 + 80 / 10_000, -375) * Math.pow(10, 6 - 9);
    expect(s.price).toBeCloseTo(expected, 12);
    expect(s.price).toBeCloseTo(0.0000503849067, 12);
  });
  it("rejects bytes from a different account type", () => {
    const other = fx("damm_pool");
    expect(() => decodeDlmmPool(other.address, other.data, 6, 9)).toThrow();
  });
});

describe("Meteora DAMM v2 decoder (fixture slot 448334506)", () => {
  const f = fx("damm_pool");
  const s = decodeDammV2Pool(f.address, f.data, 6, 9);

  it("identifies the pool and its vaults", () => {
    expect(s.tokenAMint).toBe(PERPSPAD);
    expect(s.tokenBMint).toBe(WSOL);
    expect(s.tokenAVault).toBe("5H7CRcneLziuJkxKkmjW8PVhJd3pHR4U7eujNd7LbQtP");
    expect(s.tokenBVault).toBe("HsMgCJjkmR6SZFe8sCr4ZU2WcRBsDvg6HRmyQYj22nk4");
  });
  it("reads a fixed 1% base fee with dynamic fee enabled", () => {
    expect(s.baseFeeBpsMin).toBe(100);
    expect(s.baseFeeBpsMax).toBe(100);
    expect(s.dynamicFeeBps).toBeGreaterThanOrEqual(0);
    expect(s.totalFeeBps).toBeGreaterThanOrEqual(100);
  });
  it("derives the price from sqrtPrice", () => {
    const sqrt = Number(s.sqrtPrice) / 2 ** 64;
    const expected = sqrt * sqrt * Math.pow(10, 6 - 9);
    expect(s.price).toBeCloseTo(expected, 12);
    expect(s.price).toBeCloseTo(0.0000505281976, 12);
  });
  it("rejects bytes from a different account type", () => {
    const other = fx("dlmm_pool");
    expect(() => decodeDammV2Pool(other.address, other.data, 6, 9)).toThrow();
  });
});

describe("gap net of fees", () => {
  it("matches the hand calculation for the fixture slot", () => {
    const g = gapNetOfFees(0.00005038490672779977, 80.00003, 0.00005052819762217463, 100.00219);
    expect(g.gapPct).toBeCloseTo(-0.284, 3);
    expect(g.feeFloorPct).toBeCloseTo(1.8, 3);
    expect(g.netPct).toBeCloseTo(-1.516, 3);
    expect(g.direction).toBe("buy_a_sell_b");
  });
  it("is positive only when the gap exceeds both fees", () => {
    expect(gapNetOfFees(1.03, 80, 1.0, 100).netPct).toBeCloseTo(1.2, 6);
    expect(gapNetOfFees(1.01, 80, 1.0, 100).netPct).toBeLessThan(0);
  });
});