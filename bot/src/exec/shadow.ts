import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { simulateWelded } from "./simulate";

// Shadow execution: when the scanner sees a round trip above zero, actually BUILD the two-swap transaction and run
// it against live chain state. Nothing is ever signed or sent, so this is a read-only calculation that answers the
// only question a quote cannot: would it have worked? Costs about 2 Helius credits a shot, so it is rate-limited.
//
// The payer is a funded PUBLIC address standing in for a wallet we do not have. Its own traffic never pollutes the
// result, because the measurement comes from the trade's wrapped-SOL account before and after the run.
export type ShadowConfig = { payer: PublicKey; maxPerHour: number; minIntervalMs: number; sizeCapSol: number };
export type ShadowOutcome = {
  verdict: "executed" | "cancelled_by_profit_check" | "underfunded" | "failed" | "not_built";
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

/** Build the welded trade for this token and size, then simulate it. Never throws: every outcome is a verdict. */
export async function shadowRun(conn: Connection, mint: string, sizeSol: number, cfg: ShadowConfig): Promise<ShadowOutcome> {
  const startedAt = Date.now();
  const empty = { quotedPct: null, simulatedPct: null, deltaLamports: null, sizeBytes: null, maxAccountsUsed: null, computeUnits: null, slot: null, buyVia: [], sellVia: [] };
  // A huge size makes every route too wide to fit and teaches nothing, so cap what is worth attempting.
  const size = Math.min(sizeSol, cfg.sizeCapSol);
  try {
    // keepWsolAccount: without it the clean-up closes the very account we measure.
    const w = await buildWeldedTrade(mint, Math.round(size * 1e9), cfg.payer, { connection: conn, keepWsolAccount: true });
    const built = { quotedPct: w.netPct, sizeBytes: w.sizeBytes, maxAccountsUsed: w.maxAccountsUsed, buyVia: w.buyVia, sellVia: w.sellVia };
    try {
      const s = await simulateWelded(conn, w, cfg.payer);
      const verdict: ShadowOutcome["verdict"] = s.ok ? "executed" : s.slippageRejected ? "cancelled_by_profit_check" : s.underfunded ? "underfunded" : "failed";
      return { ...empty, ...built, verdict, simulatedPct: s.netPctSimulated, deltaLamports: s.wsolDelta, computeUnits: s.unitsConsumed, slot: s.slot, err: s.err, ms: Date.now() - startedAt };
    } catch (e) {
      return { ...empty, ...built, verdict: "failed", err: `simulate: ${(e as Error).message.slice(0, 160)}`, ms: Date.now() - startedAt };
    }
  } catch (e) {
    return { ...empty, verdict: "not_built", err: (e as Error).message.slice(0, 160), ms: Date.now() - startedAt };
  }
}
