import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import BN from "bn.js";
import { summarizeDlmm } from "../src/decoders/meteora_dlmm";
import { loadDepthSnapshot } from "../src/quoter/snapshot";
import { quoteDlmm } from "../src/quoter/dlmm";
import { effectivePrice, solToLamports } from "../src/quoter/types";

// Real mainnet bytes, all six watchlist pools at slot 448478047 (npm run snapshot, 2026-09-19 17:41Z).
const snap = loadDepthSnapshot(resolve("test/fixtures/depth_snapshot.json"));
const clock = snap.clock;
const dlmm20 = snap.dlmm.get("PEPE dlmm20")!;   // deep: about 48 SOL of PEPE for sale in the active bin
const dlmm80 = snap.dlmm.get("PEPE dlmm80")!;   // thin: about 0.06 SOL of PEPE for sale in the active bin
const perpspad = snap.dlmm.get("PERPSPAD dlmm80")!;
const PEPE_DECIMALS = 4;
const spot = (s: typeof dlmm20) => summarizeDlmm(s.address, s.lbPair, PEPE_DECIMALS, 9).price;
const vsSpotPct = (s: typeof dlmm20, sol: number) =>
  (effectivePrice(quoteDlmm(s, "buy", solToLamports(sol), clock), PEPE_DECIMALS) / spot(s) - 1) * 100;

describe("depth snapshot loader (slot 448478047)", () => {
  it("decodes every pool with its bin arrays and the mint decimals", () => {
    expect(snap.slot).toBe(448478047);
    expect([...snap.dlmm.keys()]).toEqual(["PERPSPAD dlmm80", "PEPE dlmm80", "PEPE dlmm20"]);
    expect([...snap.damm.keys()]).toEqual(["PERPSPAD damm", "PEPE damm1", "PEPE damm2"]);
    expect([...perpspad.binArrays.keys()]).toEqual([-8, -7, -6, -5, -4]);
    expect([...dlmm80.binArrays.keys()]).toEqual([-12, -11, -10]);
    expect([...dlmm20.binArrays.keys()]).toEqual([-42, -41, -40, -39]);
    expect([...snap.decimals.values()].sort()).toEqual([4, 6, 9]);
  });
});

describe("DLMM depth-aware quote (slot 448478047)", () => {
  it("inside one deep bin the price is the bin price plus the fee, whatever the size", () => {
    const q = quoteDlmm(dlmm20, "buy", solToLamports(0.1), clock);
    expect(q.amountOut.toString()).toBe("26307138631"); // 2,630,713.8631 PEPE
    expect(q.feeBps).toBeCloseTo(20, 6);
    // Independent check: a DLMM bin trades at one fixed price, so tokens = SOL after the 0.2% fee / bin price.
    const expected = (0.1 * (1 - 0.002)) / spot(dlmm20);
    expect(Number(q.amountOut.toString()) / 10 ** PEPE_DECIMALS / expected).toBeCloseTo(1, 6);
    const big = quoteDlmm(dlmm20, "buy", solToLamports(2), clock);
    expect(Number(big.amountOut.toString()) / Number(q.amountOut.toString())).toBeCloseTo(20, 6); // 20x the SOL, 20x the tokens
  });

  it("a thin pool gets expensive fast: the quote walks up through the bins", () => {
    expect(vsSpotPct(dlmm80, 0.1)).toBeCloseTo(1.479, 2);
    expect(vsSpotPct(dlmm80, 0.5)).toBeCloseTo(3.401, 2);
    expect(vsSpotPct(dlmm80, 2)).toBeCloseTo(10.722, 2);
    // Crossing bins also raises the pool's variable fee during the swap.
    expect(quoteDlmm(dlmm80, "buy", solToLamports(0.1), clock).feeBps).toBeCloseTo(114.13, 1);
    expect(quoteDlmm(dlmm80, "buy", solToLamports(2), clock).feeBps).toBeCloseTo(181.68, 1);
    // Ten SOL is more than all the PEPE on sale in the arrays we hold.
    expect(() => quoteDlmm(dlmm80, "buy", solToLamports(10), clock)).toThrow(/Insufficient liquidity/);
  });

  it("depth is one-sided: selling into the same thin pool is flat while its active bin's SOL lasts", () => {
    const sell = (tokens: string) => effectivePrice(quoteDlmm(dlmm80, "sell", new BN(tokens), clock), PEPE_DECIMALS);
    expect(sell("25854594055") / spot(dlmm80)).toBeCloseTo(1 - 0.0112, 4);  // about 0.1 SOL's worth
    expect(sell("126869516057") / spot(dlmm80)).toBeCloseTo(1 - 0.0112, 4); // about 0.5 SOL's worth, same price
  });

  it("a round trip inside the deep 0.2% pool costs the two fees and nothing more", () => {
    const buy = quoteDlmm(dlmm20, "buy", solToLamports(2), clock);
    const sell = quoteDlmm(dlmm20, "sell", buy.amountOut, clock);
    expect((Number(sell.amountOut.toString()) / 2e9 - 1) * 100).toBeCloseTo(-0.3996, 4);
  });

  it("the variable fee fades with time since the last swap, so the quote depends on the clock", () => {
    expect(quoteDlmm(perpspad, "buy", solToLamports(0.1), clock).feeBps).toBeCloseTo(97.4602, 3);
    const anHourLater = { slot: clock.slot + 9000, unixTime: clock.unixTime + 3600 };
    expect(quoteDlmm(perpspad, "buy", solToLamports(0.1), anHourLater).feeBps).toBeCloseTo(80, 6);
  });

  it("is repeatable and leaves the real clock alone", () => {
    const a = quoteDlmm(dlmm80, "buy", solToLamports(2), clock);
    const b = quoteDlmm(dlmm80, "buy", solToLamports(2), clock);
    expect(a.amountOut.eq(b.amountOut)).toBe(true);
    expect(Math.abs(Date.now() / 1000 - clock.unixTime)).toBeGreaterThan(60); // Date.now() is the real time again
  });

  it("rejects an empty trade and a pool without SOL", () => {
    expect(() => quoteDlmm(dlmm20, "buy", new BN(0), clock)).toThrow("greater than 0");
    const noSol = { ...dlmm20, lbPair: { ...dlmm20.lbPair, tokenYMint: dlmm20.lbPair.tokenXMint } };
    expect(() => quoteDlmm(noSol, "buy", solToLamports(0.1), clock)).toThrow("SOL on exactly one side");
  });
});
