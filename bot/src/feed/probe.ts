import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { getBinArrayLowerUpperBinId, type LbPair } from "@meteora-ag/dlmm";
import { MAX_FEE_BPS, WATCHLIST } from "../config/watchlist";
import { decodeBinArray, decodeDlmmRaw } from "../decoders/meteora_dlmm";
import { decodeDammV2Raw } from "../decoders/meteora_damm_v2";
import { bestPair, type BestPair, type PoolSnap } from "../scanner/best_pair";
import type { DlmmQuoteState } from "../quoter/dlmm";
import { binArrayAddress, binArrayIndexesBothWays, binArrayIndexesForSwap } from "../quoter/dlmm_accounts";
import { allRoundTrips, bestPerSize, dammQuotable, dlmmQuotable, type QuotablePool } from "../quoter/pair";

// Depth probes. Streaming every bin array would cost about 1 M Helius credits a month (WebSocket data is metered at
// 2 credits per 0.1 MB and a bin array is 10 KB per swap). Instead, when the headline prices of a token's pools
// look close to a trade, we read its pools and bin arrays once over HTTP (1 credit, whatever the size) and quote the
// real round trips. The read lands a few hundred milliseconds after the update that triggered it, which is about
// how long we would need to react anyway: a gap that is gone by then was never ours.
export const PROBE_SIZES_SOL = [0.001, 0.1, 0.5, 2]; // 0.001 = dust: what the prices promise before size costs anything
const EDGE_BINS = 15;            // also read the neighbouring bin array when the active bin is this close to the edge it would walk to
const PROBE_TIMEOUT_MS = 15_000; // a slow read is still a measurement (its duration is recorded); a hung one must not block the token for long

/**
 * The bin arrays a probe reads for one pool: the array holding the active bin, plus the next array with liquidity on a
 * side only when the active bin sits within EDGE_BINS of that edge. Keeps the read small (a bin array is 10 KB).
 */
export function probeArrayIndexes(lb: LbPair): number[] {
  const out = new Set<number>();
  const active = Number(lb.activeId);
  for (const swapForY of [true, false]) {
    const [first, second] = binArrayIndexesForSwap(lb, null, swapForY, 2);
    if (first === undefined) continue;
    out.add(first);
    if (second === undefined) continue;
    const [lower, upper] = getBinArrayLowerUpperBinId(new BN(first)).map((b) => b.toNumber());
    if ((swapForY ? active - lower : upper - active) < EDGE_BINS) out.add(second);
  }
  return [...out].sort((a, b) => a - b);
}

export type GateConfig = { thresholdPct: number; minIntervalMs: number; maxPerHour: number };

/** Decides when a probe may start: above the threshold, one at a time per token, not too often, within an hourly budget. */
export class ProbeGate {
  private lastAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private hourStart = 0;
  private usedThisHour = 0;
  started = 0;
  skippedByBudget = 0;
  constructor(private cfg: GateConfig) {}

  /** True when a probe for this token should start now; it is then marked in flight until done() is called. */
  tryStart(token: string, netPct: number, now: number): boolean {
    if (!(netPct > this.cfg.thresholdPct)) return false;
    if (this.inFlight.has(token)) return false;
    if (now - (this.lastAt.get(token) ?? -Infinity) < this.cfg.minIntervalMs) return false;
    if (now - this.hourStart >= 3_600_000) { this.hourStart = now; this.usedThisHour = 0; }
    if (this.usedThisHour >= this.cfg.maxPerHour) { this.skippedByBudget++; return false; }
    this.usedThisHour++; this.started++;
    this.inFlight.add(token); this.lastAt.set(token, now);
    return true;
  }
  done(token: string) { this.inFlight.delete(token); }
}

/**
 * The quote-level best pair, judged with each pool's BASE fee. A DLMM pool stores the variable fee of its last swap;
 * after a quiet spell a new swap pays less, so the stored fee can hide a gap. Pools stay excluded by their stored
 * (worst-case) fee, so a launch-fee trap cannot sneak back in through a low base fee.
 */
export function bestPairAtBaseFees(snaps: Map<string, PoolSnap & { baseFeeBps: number }>, maxFeeBps: number): BestPair | null {
  const eligible = new Map<string, PoolSnap>();
  for (const [label, s] of snaps) if (s.feeBps <= maxFeeBps) eligible.set(label, { ...s, feeBps: s.baseFeeBps });
  return bestPair(eligible, maxFeeBps);
}

export type ProbeResult = {
  /** Slot of the HTTP read, how long the read took, how many accounts and how many KB of account data came back. */
  slot: number;
  ms: number;
  accounts: number;
  kb: number;
  /** Best executable round trip at each size: net in percent (null = nothing could be filled), where to buy, where to sell. */
  best: Record<string, { net: number | null; buy?: string; sell?: string }>;
  /** Round trips that could not be quoted (usually a size that would walk beyond the bin arrays read): treat that size with care. */
  unfilled?: number;
  note?: string;
};
export type ProbeOptions = { nowMs?: number; commitment?: Commitment; timeoutMs?: number };

type Reader = Pick<Connection, "getMultipleAccountsInfoAndContext">;

/**
 * One consistent read of a token's eligible pools and the bin arrays around their active bins, then every round trip
 * at every size. latestPoolData holds the newest account bytes we have per pool label (from the WebSocket feed); it is
 * only used to work out WHICH bin arrays to ask for. The quotes use the fresh bytes from the read itself.
 */
export async function probeToken(conn: Reader, token: string, latestPoolData: Map<string, Buffer>, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const clockOf = (slot: number) => ({ slot, unixTime: Math.floor(nowMs / 1000) });
  const wants: { label: string; venue: "dlmm" | "damm"; address: string; index?: number }[] = [];
  for (const p of WATCHLIST.filter((w) => w.token === token)) {
    const data = latestPoolData.get(p.label);
    if (!data) continue;
    if (p.venue === "dlmm") {
      const lb = decodeDlmmRaw(data);
      if (dlmmQuotable(p.label, { address: p.address, lbPair: lb, bitmapExtension: null, binArrays: new Map() }, clockOf(0)).feeBps > MAX_FEE_BPS) continue;
      wants.push({ label: p.label, venue: "dlmm", address: p.address });
      for (const index of probeArrayIndexes(lb))
        wants.push({ label: p.label, venue: "dlmm", address: binArrayAddress(new PublicKey(p.address), index).toBase58(), index });
    } else {
      if (dammQuotable(p.label, p.address, decodeDammV2Raw(data), clockOf(0)).feeBps > MAX_FEE_BPS) continue;
      wants.push({ label: p.label, venue: "damm", address: p.address });
    }
  }

  const started = Date.now();
  const read = conn.getMultipleAccountsInfoAndContext(wants.map((w) => new PublicKey(w.address)), opts.commitment ?? "processed");
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`probe read of ${wants.length} accounts timed out after ${timeoutMs} ms`)), timeoutMs).unref());
  const { context, value } = await Promise.race([read, timeout]);
  const ms = Date.now() - started;

  const clock = clockOf(context.slot);
  const dlmm = new Map<string, DlmmQuoteState>();
  const pools: QuotablePool[] = [];
  let moved = 0, bytes = 0;
  wants.forEach((w, i) => {
    const info = value[i];
    if (!info) return;
    const data = Buffer.from(info.data);
    bytes += data.length;
    if (w.venue === "damm") pools.push(dammQuotable(w.label, w.address, decodeDammV2Raw(data), clock));
    else if (w.index === undefined) dlmm.set(w.label, { address: w.address, lbPair: decodeDlmmRaw(data), bitmapExtension: null, binArrays: new Map() });
    else dlmm.get(w.label)?.binArrays.set(w.index, decodeBinArray(data));
  });
  for (const [label, state] of dlmm) {
    // If the pool moved into a bin array we did not ask for, its quote would be wrong: leave it out of this probe.
    if (binArrayIndexesBothWays(state.lbPair, null, 1).some((index) => !state.binArrays.has(index))) { moved++; continue; }
    pools.push(dlmmQuotable(label, state, clock));
  }

  const trips = allRoundTrips(pools, PROBE_SIZES_SOL, MAX_FEE_BPS);
  const unfilled = trips.filter((t) => t.netPct === null).length;
  const best: ProbeResult["best"] = {};
  for (const [size, trip] of bestPerSize(trips))
    best[String(size)] = trip ? { net: Number(trip.netPct!.toFixed(4)), buy: trip.buyOn, sell: trip.sellOn } : { net: null };
  return {
    slot: context.slot, ms, accounts: wants.length, kb: Math.round(bytes / 1024), best,
    ...(unfilled ? { unfilled } : {}),
    ...(moved ? { note: `${moved} pool(s) moved out of the fetched bin arrays` } : {}),
  };
}
