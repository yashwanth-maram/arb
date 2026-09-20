import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { MAX_FEE_BPS, WATCHLIST } from "../src/config/watchlist";
import { ProbeGate, bestPairAtBaseFees, probeToken } from "../src/feed/probe";

describe("probe gate", () => {
  const gate = () => new ProbeGate({ thresholdPct: -0.25, minIntervalMs: 2000, maxPerHour: 3 });

  it("opens only above the threshold", () => {
    const g = gate();
    expect(g.tryStart("PEPE", -0.3, 1_000_000)).toBe(false);
    expect(g.tryStart("PEPE", -0.2, 1_000_000)).toBe(true);
  });

  it("runs one probe at a time per token and waits between probes", () => {
    const g = gate();
    expect(g.tryStart("PEPE", 1, 1_000_000)).toBe(true);
    expect(g.tryStart("PEPE", 1, 1_000_100)).toBe(false);     // still in flight
    expect(g.tryStart("PERPSPAD", 1, 1_000_100)).toBe(true);  // another token is independent
    g.done("PEPE");
    expect(g.tryStart("PEPE", 1, 1_001_000)).toBe(false);     // finished, but only 1 s since it started
    expect(g.tryStart("PEPE", 1, 1_002_000)).toBe(true);
  });

  it("stops at the hourly budget and starts again in the next hour", () => {
    const g = gate();
    for (let i = 0; i < 3; i++) { expect(g.tryStart("PEPE", 1, 1_000_000 + i * 2000)).toBe(true); g.done("PEPE"); }
    expect(g.tryStart("PEPE", 1, 1_010_000)).toBe(false);
    expect(g.skippedByBudget).toBe(1);
    expect(g.tryStart("PEPE", 1, 1_000_000 + 3_600_000)).toBe(true);
    expect(g.started).toBe(4);
  });
});

describe("quote-level trigger at base fees", () => {
  const snap = (price: number, feeBps: number, baseFeeBps: number) => ({ price, feeBps, baseFeeBps, slot: 1, ts: 0 });

  it("uses the base fee for the net, so a stale variable fee cannot hide a gap", () => {
    const snaps = new Map([["a", snap(1.015, 20, 20)], ["b", snap(1, 160, 100)]]); // b stores 60 bps of old variable fee
    expect(bestPairAtBaseFees(snaps, MAX_FEE_BPS)!.netPct).toBeCloseTo(1.5 - 1.2, 6); // with the stored fee it would be -0.3
  });

  it("keeps a launch-fee pool out even when its base fee is low", () => {
    const snaps = new Map([["a", snap(1, 20, 20)], ["b", snap(1.01, 100, 100)], ["trap", snap(0.6, 4500, 100)]]);
    const best = bestPairAtBaseFees(snaps, MAX_FEE_BPS)!;
    expect([best.a, best.b]).toEqual(["a", "b"]);
  });
});

describe("probe on the snapshot (slot 448478047)", () => {
  // A stand-in for the RPC: answers getMultipleAccounts from the snapshot file, like the real node would at that slot.
  const file = JSON.parse(readFileSync(resolve("test/fixtures/depth_snapshot.json"), "utf8"));
  const byAddress = new Map<string, any>(file.accounts.filter((a: any) => !a.missing).map((a: any) => [a.address, a]));
  let asked: string[] = [];
  const conn = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      asked = keys.map((k) => k.toBase58());
      return {
        context: { slot: file.slot },
        value: asked.map((k) => (byAddress.has(k) ? { data: Buffer.from(byAddress.get(k).dataBase64, "base64"), owner: new PublicKey(byAddress.get(k).owner), lamports: 1, executable: false } : null)),
      };
    },
  } as any;
  const latest = new Map<string, Buffer>(WATCHLIST.map((p) => [p.label, Buffer.from(byAddress.get(p.address).dataBase64, "base64")]));

  it("reads the eligible pools and their nearby bin arrays in one request, and reports the best round trip per size", async () => {
    const r = await probeToken(conn, "PEPE", latest, Date.parse(file.fetchedAt));
    expect(r.slot).toBe(448478047);
    expect(r.accounts).toBe(8); // 3 eligible pools (damm1 left out) + bin arrays -11,-10 (dlmm80) and -41,-40,-39 (dlmm20)
    expect(asked).not.toContain("GRNVafZv78DndVua7phP9BFGmmFxJ9r58wBEakDyfsCg");
    expect(r.best["0.001"]).toEqual({ net: -0.8552, buy: "PEPE dlmm20", sell: "PEPE dlmm80" });
    expect(r.best["2"]).toEqual({ net: -0.9295, buy: "PEPE dlmm20", sell: "PEPE dlmm80" });
    expect(r.note).toBeUndefined();
  });

  it("leaves a pool out when it has moved beyond the bin arrays that were fetched", async () => {
    const holey = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      const res = await conn.getMultipleAccountsInfoAndContext(keys);
      res.value = res.value.map((v: any, i: number) => (asked[i] === "GRS6QUuzCiSQjRS33ZDcTKR27nz9chuUduVc917dfAno" ? null : v)); // dlmm20's active bin array -40
      return res;
    } } as any;
    const r = await probeToken(holey, "PEPE", latest, Date.parse(file.fetchedAt));
    expect(r.note).toMatch(/1 pool\(s\) moved/);
    expect(r.best["0.1"].buy).not.toBe("PEPE dlmm20");
    expect(r.best["0.1"].sell).not.toBe("PEPE dlmm20");
  });
});
