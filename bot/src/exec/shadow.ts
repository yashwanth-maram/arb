import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { simulateWelded } from "./simulate";

// Shadow execution as a FREE BET. After both swaps, OUR OWN instruction moves stake+floor of wrapped SOL out of the
// trade's account. The token program refuses to move more than is there, and one failed instruction reverts the whole
// transaction. So the trade either pays the floor or costs the base fee. Nothing is ever signed or sent.
//
// Jupiter's own minimum cannot be trusted for this: it honours a raised floor on some routes and silently ignores it
// on others. Ours is enforced by the token program, so it always bites.
//
// The payer must have NO wrapped-SOL account of its own, or an old balance would pay for the transfer and the check
// would pass regardless. Use `npm run exec:clean` to find one.
export type ShadowConfig = { payer: PublicKey; maxPerHour: number; minIntervalMs: number; sizeCapSol: number;
  floorLamports: number; bareFloorLamports: number;
  /** How many times to double the demand on a win, to find how big the win really was. 0 disables the ladder. */
  ladderSteps: number };
export type ShadowOutcome = {
  verdict: "won" | "reverted" | "underfunded" | "failed" | "not_built";
  /** The floor the trade had to clear, and whether the bare floor would have been met instead. */
  floorLamports: number | null; bareVerdict: "won" | "reverted" | "skipped" | null;
  /** On a win, the most the trade could be made to pay before it reverted: the true size of the win, in lamports
   * above the stake. Found by demanding progressively more, because our check moves the proceeds out of the account
   * we would otherwise read. Null when the trade did not win. */
  profitLamports: number | null; laddered: number | null;
  /** The stake actually used, after the size cap. The requested size may have been larger. */
  stakeLamports: number | null;
  quotedPct: number | null; sizeBytes: number | null; maxAccountsUsed: number | null;
  computeUnits: number | null; slot: number | null;
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

/** Build the welded trade with our profit check, simulate it, and size any win. Never throws: every outcome is a verdict. */
export async function shadowRun(conn: Connection, mint: string, sizeSol: number, cfg: ShadowConfig): Promise<ShadowOutcome> {
  const startedAt = Date.now();
  const empty = { quotedPct: null, sizeBytes: null, maxAccountsUsed: null, computeUnits: null, slot: null,
    buyVia: [], sellVia: [], floorLamports: null, bareVerdict: null, profitLamports: null, laddered: null, stakeLamports: null };
  // A huge size makes every route too wide to fit and teaches nothing, so cap what is worth attempting.
  const size = Math.min(sizeSol, cfg.sizeCapSol);
  const lamports = Math.round(size * 1e9);
  const build = (demand: number) =>
    buildWeldedTrade(mint, lamports, cfg.payer, { connection: conn, keepWsolAccount: true, requireLamportsOut: lamports + demand });
  try {
    const w = await build(cfg.floorLamports);
    const built = { quotedPct: w.netPct, sizeBytes: w.sizeBytes, maxAccountsUsed: w.maxAccountsUsed,
      buyVia: w.buyVia, sellVia: w.sellVia, floorLamports: lamports + cfg.floorLamports, stakeLamports: lamports };
    try {
      const s = await simulateWelded(conn, w, cfg.payer);
      // With our own check in place, any revert means the floor was not met: a loss, not a malfunction.
      const verdict: ShadowOutcome["verdict"] = s.ok ? "won" : s.underfunded ? "underfunded" : "reverted";

      // A revert at the honest floor may still clear the bare one: that gap is what a cheaper tip would unlock.
      let bareVerdict: ShadowOutcome["bareVerdict"] = "skipped";
      if (verdict === "reverted" && cfg.bareFloorLamports < cfg.floorLamports) {
        try {
          const sb = await simulateWelded(conn, await build(cfg.bareFloorLamports), cfg.payer);
          bareVerdict = sb.ok ? "won" : "reverted";
        } catch { bareVerdict = "skipped"; }
      }

      // On a win, find how big it really was: demand more and more until the trade refuses. The last demand it met is the win.
      let profitLamports: number | null = null, laddered: number | null = null;
      if (verdict === "won" && cfg.ladderSteps > 0) {
        profitLamports = cfg.floorLamports;
        laddered = 0;
        let demand = cfg.floorLamports;
        for (let step = 0; step < cfg.ladderSteps; step++) {
          demand = Math.max(demand * 2, demand + 10_000);
          try {
            const sm = await simulateWelded(conn, await build(demand), cfg.payer);
            laddered++;
            if (!sm.ok) break;
            profitLamports = demand;
          } catch { break; }
        }
      }
      return { ...empty, ...built, verdict, bareVerdict, profitLamports, laddered,
        computeUnits: s.unitsConsumed, slot: s.slot, err: s.err, ms: Date.now() - startedAt };
    } catch (e) {
      return { ...empty, ...built, verdict: "failed", err: `simulate: ${(e as Error).message.slice(0, 160)}`, ms: Date.now() - startedAt };
    }
  } catch (e) {
    return { ...empty, verdict: "not_built", err: (e as Error).message.slice(0, 160), ms: Date.now() - startedAt };
  }
}
