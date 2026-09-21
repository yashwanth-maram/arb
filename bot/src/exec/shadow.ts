import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { simulateWelded } from "./simulate";

// Shadow execution as a FREE BET. The sell leg is made to demand the stake back plus a floor, so the trade can only
// end two ways: it pays a profit, or it refuses and the whole transaction reverts. Nothing is ever signed or sent.
//
// A reverted transaction pays the base fee only: no priority fee, no tip, no pool fees. So a losing bet costs about
// 5,000 lamports (a twentieth of a cent) and a winning one must clear the fee it WOULD pay to land. Two floors are
// tried on each attempt: the honest one (stake + what it costs to land) and a bare one (stake + base fee), which
// shows how much of the gap sits between those two, i.e. what a cheaper tip would unlock.
export type ShadowConfig = { payer: PublicKey; maxPerHour: number; minIntervalMs: number; sizeCapSol: number;
  floorLamports: number; bareFloorLamports: number };
export type ShadowOutcome = {
  verdict: "won" | "reverted" | "underfunded" | "failed" | "not_built";
  /** What the sell leg was made to demand, and whether the bare floor would have been met instead. */
  floorLamports: number | null; bareVerdict: "won" | "reverted" | "skipped" | null;
  quotedPct: number | null; simulatedPct: number | null; deltaLamports: number | null;
  sizeBytes: number | null; maxAccountsUsed: number | null; computeUnits: number | null; slot: number | null;
  buyVia: string[]; sellVia: string[]; err: string | null; ms: number;
};

/** Decides when a shadow run may start: not too often, and within an hourly budget of Helius credits. */
export class ShadowGate {
  private lastAt = 0;
  private hourStart = 0;
  private usedThisHour = 0;
  started = 0;
  skipped = 0;
  constructor(private cfg: Pick<ShadowConfig, "maxPerHour" | "minIntervalMs">) {}
  tryStart(now = Date.now()): boolean {
    if (now - this.lastAt < this.cfg.minIntervalMs) { this.skipped++; return false; }
    if (now - this.hourStart >= 3_600_000) { this.hourStart = now; this.usedThisHour = 0; }
    if (this.usedThisHour >= this.cfg.maxPerHour) { this.skipped++; return false; }
    this.usedThisHour++; this.started++; this.lastAt = now;
    return true;
  }
}

/** Build the welded trade with a profit floor, then simulate it. Never throws: every outcome is a verdict. */
export async function shadowRun(conn: Connection, mint: string, sizeSol: number, cfg: ShadowConfig): Promise<ShadowOutcome> {
  const startedAt = Date.now();
  const empty = { quotedPct: null, simulatedPct: null, deltaLamports: null, sizeBytes: null, maxAccountsUsed: null, computeUnits: null, slot: null, buyVia: [], sellVia: [], floorLamports: null, bareVerdict: null };
  // A huge size makes every route too wide to fit and teaches nothing, so cap what is worth attempting.
  const size = Math.min(sizeSol, cfg.sizeCapSol);
  try {
    // Demand the stake back plus what it costs to land: the trade can then only pay a profit or revert for the base fee.
    const lamports = Math.round(size * 1e9);
    const floor = lamports + cfg.floorLamports;
    // keepWsolAccount: without it the clean-up closes the very account we measure.
    // requireLamportsOut is OUR check: a token transfer the trade must be able to make, which nothing can ignore.
    const w = await buildWeldedTrade(mint, lamports, cfg.payer, { connection: conn, keepWsolAccount: true, requireLamportsOut: floor });
    const built = { quotedPct: w.netPct, sizeBytes: w.sizeBytes, maxAccountsUsed: w.maxAccountsUsed, buyVia: w.buyVia, sellVia: w.sellVia, floorLamports: floor };
    try {
      const s = await simulateWelded(conn, w, cfg.payer);
      // With our own check in place, any revert means the floor was not met: that is a loss, not a malfunction.
      const verdict: ShadowOutcome["verdict"] = s.ok ? "won" : s.underfunded ? "underfunded" : "reverted";
      // A revert at the honest floor may still have cleared the bare one: that gap is what a cheaper tip would unlock.
      let bareVerdict: ShadowOutcome["bareVerdict"] = "skipped";
      if (verdict === "reverted" && cfg.bareFloorLamports < cfg.floorLamports) {
        try {
          const bare = await buildWeldedTrade(mint, lamports, cfg.payer, { connection: conn, keepWsolAccount: true, requireLamportsOut: lamports + cfg.bareFloorLamports });
          const sb = await simulateWelded(conn, bare, cfg.payer);
          bareVerdict = sb.ok ? "won" : "reverted";
        } catch { bareVerdict = "skipped"; }
      }
      return { ...empty, ...built, verdict, bareVerdict, simulatedPct: s.netPctSimulated, deltaLamports: s.wsolDelta, computeUnits: s.unitsConsumed, slot: s.slot, err: s.err, ms: Date.now() - startedAt };
    } catch (e) {
      return { ...empty, ...built, verdict: "failed", err: `simulate: ${(e as Error).message.slice(0, 160)}`, ms: Date.now() - startedAt };
    }
  } catch (e) {
    return { ...empty, verdict: "not_built", err: (e as Error).message.slice(0, 160), ms: Date.now() - startedAt };
  }
}
