import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { MAX_FEE_BPS, WATCHLIST } from "../src/config/watchlist";
import { summarizeDlmm } from "../src/decoders/meteora_dlmm";
import { loadDepthSnapshot } from "../src/quoter/snapshot";
import { allRoundTrips, bestPerSize, dammQuotable, dlmmQuotable, roundTrip, type RoundTrip } from "../src/quoter/pair";

// Real mainnet bytes, all six watchlist pools at slot 448478047.
const snap = loadDepthSnapshot(resolve("test/fixtures/depth_snapshot.json"));
const poolsOf = (token: string) => WATCHLIST.filter((p) => p.token === token).map((p) =>
  p.venue === "dlmm"
    ? dlmmQuotable(p.label, snap.dlmm.get(p.label)!, snap.clock)
    : dammQuotable(p.label, snap.damm.get(p.label)!.address, snap.damm.get(p.label)!.state, snap.clock));
const SIZES = [0.1, 0.5, 2];
const pepe = allRoundTrips(poolsOf("PEPE"), SIZES, MAX_FEE_BPS);
const perpspad = allRoundTrips(poolsOf("PERPSPAD"), SIZES, MAX_FEE_BPS);
const nets = (trips: RoundTrip[], buyOn: string, sellOn: string) =>
  SIZES.map((size) => trips.find((t) => t.buyOn === buyOn && t.sellOn === sellOn && t.sizeSol === size)!.netPct!);

describe("executable round trips between pools (slot 448478047)", () => {
  it("direction decides: the same two pools, opposite directions, at 0.1 / 0.5 / 2 SOL", () => {
    const deepWay = nets(pepe, "PEPE dlmm20", "PEPE dlmm80"); // buy where PEPE is plentiful, sell into dlmm80's SOL
    const thinWay = nets(pepe, "PEPE dlmm80", "PEPE dlmm20"); // buy from dlmm80's thin asks
    [-0.8552, -0.8552, -0.9295].forEach((v, i) => expect(deepWay[i]).toBeCloseTo(v, 3));
    [-2.113, -3.9329, -10.2848].forEach((v, i) => expect(thinWay[i]).toBeCloseTo(v, 3));
  });

  it("leaves the 45% launch-fee pool out and quotes every direction of the rest", () => {
    expect(poolsOf("PEPE").find((p) => p.label === "PEPE damm1")!.feeBps).toBeGreaterThan(MAX_FEE_BPS);
    expect(pepe.length).toBe(3 * 2 * SIZES.length); // 3 eligible pools, 2 partners each, 3 sizes
    expect(pepe.some((t) => t.buyOn === "PEPE damm1" || t.sellOn === "PEPE damm1")).toBe(false);
    expect(perpspad.length).toBe(2 * 1 * SIZES.length);
  });

  it("picks the best direction at each size: the number the logger will record", () => {
    const bestPepe = bestPerSize(pepe), bestPerpspad = bestPerSize(perpspad);
    for (const size of SIZES) {
      expect(bestPepe.get(size)!.buyOn).toBe("PEPE dlmm20");
      expect(bestPepe.get(size)!.sellOn).toBe("PEPE dlmm80");
      expect(bestPerpspad.get(size)!.buyOn).toBe("PERPSPAD damm");
    }
    expect(bestPepe.get(2)!.netPct).toBeCloseTo(-0.9295, 3);
    [-1.9463, -1.9825, -2.1179].forEach((v, i) => expect(bestPerpspad.get(SIZES[i])!.netPct).toBeCloseTo(v, 3));
  });

  it("never beats the spot price: equal to it where both sides are deep, far below it on the thin side", () => {
    const spotAndFee = (label: string) => {
      const s = summarizeDlmm(snap.dlmm.get(label)!.address, snap.dlmm.get(label)!.lbPair, 4, 9);
      return { price: s.price, fee: s.totalFeeBps / 10_000 };
    };
    const a = spotAndFee("PEPE dlmm20"), b = spotAndFee("PEPE dlmm80");
    const spotNet = (buy: typeof a, sell: typeof a) => ((sell.price / buy.price) * (1 - buy.fee) * (1 - sell.fee) - 1) * 100;
    expect(nets(pepe, "PEPE dlmm20", "PEPE dlmm80")[0]).toBeCloseTo(spotNet(a, b), 3);
    expect(nets(pepe, "PEPE dlmm80", "PEPE dlmm20")[0]).toBeLessThan(spotNet(b, a) - 0.3);
  });

  it("gives no number, and says why, when a pool cannot fill the size", () => {
    const [dlmm80, dlmm20] = [poolsOf("PEPE")[0], poolsOf("PEPE")[1]];
    const t = roundTrip(dlmm80, dlmm20, 10);
    expect(t.netPct).toBeNull();
    expect(t.error).toMatch(/Insufficient liquidity/);
  });
});
