import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import { swapQuoteExactInput } from "@meteora-ag/cp-amm-sdk";
import { decodeDammV2Raw, summarizeDammV2 } from "../src/decoders/meteora_damm_v2";
import { quoteDammV2, currentPoint } from "../src/quoter/damm_v2";
import { effectivePrice, solToLamports } from "../src/quoter/types";

// PERPSPAD DAMM v2 pool at slot 448334506: token A = PERPSPAD (6 decimals), token B = SOL.
const f = JSON.parse(readFileSync(resolve("test/fixtures/damm_pool.json"), "utf8"));
const pool = decodeDammV2Raw(Buffer.from(f.dataBase64, "base64"));
const summary = summarizeDammV2(f.address, pool, 6, 9);
const clock = { slot: f.slot as number, unixTime: Math.floor(Date.parse(f.fetchedAt) / 1000) };

const roundTripPct = (sol: number) => {
  const buy = quoteDammV2(pool, "buy", solToLamports(sol), clock);
  const sell = quoteDammV2(pool, "sell", buy.amountOut, clock);
  return (Number(sell.amountOut.toString()) / Number(buy.amountIn.toString()) - 1) * 100;
};

describe("DAMM v2 depth-aware quote (fixture slot 448334506)", () => {
  it("uses the pool's own clock: this pool counts in unix seconds, not slots", () => {
    expect(pool.activationType).toBe(1);
    expect(currentPoint(pool, clock).toNumber()).toBe(clock.unixTime);
    // The trap this guards against: handing the SDK a slot number for a timestamp pool.
    expect(() => swapQuoteExactInput(pool, new BN(clock.slot), solToLamports(0.1), 0, false, false, 6, 9)).toThrow();
    expect(() => quoteDammV2(pool, "buy", solToLamports(0.1), clock)).not.toThrow();
  });

  it("buying with 0.1 SOL matches the constant-product formula", () => {
    const q = quoteDammV2(pool, "buy", solToLamports(0.1), clock);
    expect(q.amountOut.toString()).toBe("1959134821"); // 1,959.134821 PERPSPAD
    expect(q.feeBps).toBeCloseTo(summary.totalFeeBps, 3);

    // Independent check with plain numbers. A full-range pool behaves like x * y = k with
    // virtual reserves x = L / sqrtP (token) and y = L * sqrtP (lamports); L and sqrtP are stored times 2^64.
    const Q64 = 2 ** 64;
    const L = Number(pool.liquidity.toString()) / Q64;
    const sqrtP = Number(pool.sqrtPrice.toString()) / Q64;
    const x = L / sqrtP, y = L * sqrtP;
    const dy = 0.1e9 * (1 - summary.totalFeeBps / 10_000); // the fee comes off the SOL going in
    const expected = (x * dy) / (y + dy);
    expect(Number(q.amountOut.toString()) / expected).toBeCloseTo(1, 6);
  });

  it("agrees with the SDK's own quote wrapper in both directions", () => {
    const point = currentPoint(pool, clock);
    const buy = quoteDammV2(pool, "buy", solToLamports(2), clock);
    expect(buy.amountOut.eq(swapQuoteExactInput(pool, point, solToLamports(2), 0, false, false, 6, 9).outputAmount)).toBe(true);
    const sell = quoteDammV2(pool, "sell", buy.amountOut, clock);
    expect(sell.amountOut.eq(swapQuoteExactInput(pool, point, buy.amountOut, 0, true, false, 6, 9).outputAmount)).toBe(true);
  });

  it("a round trip inside one pool loses both fees, and more as size grows", () => {
    expect(roundTripPct(0.1)).toBeCloseTo(-2.0067, 3);
    expect(roundTripPct(2)).toBeCloseTo(-2.3226, 3);
    expect(roundTripPct(10)).toBeLessThan(roundTripPct(2));
  });

  it("the executable price gets worse with size: that is depth", () => {
    const buy = (sol: number) => effectivePrice(quoteDammV2(pool, "buy", solToLamports(sol), clock), 6);
    expect(buy(0.1)).toBeGreaterThan(summary.price * 1.01); // spot plus the 1% fee
    expect(buy(0.5)).toBeGreaterThan(buy(0.1));
    expect(buy(2)).toBeGreaterThan(buy(0.5));
    const sell = (tokens: number) => effectivePrice(quoteDammV2(pool, "sell", new BN(Math.round(tokens * 1e6)), clock), 6);
    expect(sell(2_000)).toBeLessThan(summary.price * 0.99);
    expect(sell(40_000)).toBeLessThan(sell(2_000));
  });

  it("finds SOL on either side of the pool", () => {
    // The same pool with its two mints swapped: SOL becomes token A, so a buy must now run A to B.
    const flipped = { ...pool, tokenAMint: pool.tokenBMint, tokenBMint: pool.tokenAMint };
    const amount = new BN(1_000_000_000);
    expect(quoteDammV2(flipped, "buy", amount, clock).amountOut.eq(quoteDammV2(pool, "sell", amount, clock).amountOut)).toBe(true);
    expect(quoteDammV2(flipped, "sell", amount, clock).amountOut.eq(quoteDammV2(pool, "buy", amount, clock).amountOut)).toBe(true);
  });

  it("rejects an empty trade and a pool without SOL", () => {
    expect(() => quoteDammV2(pool, "buy", new BN(0), clock)).toThrow("greater than 0");
    const noSol = { ...pool, tokenBMint: pool.tokenAMint };
    expect(() => quoteDammV2(noSol, "buy", solToLamports(0.1), clock)).toThrow("SOL on exactly one side");
  });
});
