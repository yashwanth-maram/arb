import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";

// Usage: npm run newpool                    (free: Meteora's lists and Jupiter's public endpoint, no credits)
//        LOOKBACK_MINUTES=30 RUN_MINUTES=60 npm run newpool
//
// The only idea left where being slow does not matter. When a pool is created, nothing knows about it: Jupiter has
// to index it and every bot's route table has to refresh. That lag is measured in MINUTES, not milliseconds, and it
// affects everyone equally. So this measures two things about brand-new pools:
//   1. INDEXING LAG: how long until Jupiter's chosen route actually goes through the new pool. Its route plan names
//      the pool it uses (ammKey), so this is directly observable rather than inferred.
//   2. PRICE GAP: while a new pool is unrouted, does its price differ from the token's existing pools? A gap that
//      nobody's router can see is the one kind a slow machine could reach.
const DLMM_API = process.env.DLMM_API ?? "https://dlmm.datapi.meteora.ag";
const DAMM_API = process.env.DAMM_API ?? "https://damm-v2.datapi.meteora.ag";
const JUP = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const LOOKBACK_MINUTES = Number(process.env.LOOKBACK_MINUTES ?? 30); // a pool younger than this counts as new
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 60);
const PAGES = Number(process.env.PAGES ?? 3);
const MIN_TVL = Number(process.env.MIN_TVL ?? 300);
const MAX_CHECKS = Number(process.env.MAX_CHECKS ?? 12);   // Jupiter quotes per poll, to stay inside the rate limit
const PROBE_SOL = Number(process.env.PROBE_SOL ?? 0.05);   // small: we are asking WHICH pool is used, not how much
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 0);
const LOG_DIR = process.env.LOG_DIR ?? "logs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `newpool-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  return line;
}
function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { family: 4, timeout: 45_000, headers: { accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: { raw: text.slice(0, 200) } }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

type Pool = { venue: "dlmm" | "damm"; address: string; mint: string; symbol: string;
  priceSol: number; feePct: number; tvl: number; createdAt: number };

async function snapshot(): Promise<Pool[]> {
  const out: Pool[] = [];
  for (const [venue, base] of [["dlmm", DLMM_API], ["damm", DAMM_API]] as const) {
    for (let page = 1; page <= PAGES; page++) {
      const { status, body } = await getJson(`${base}/pools?page=${page}&page_size=1000&sort_by=volume_24h:desc`);
      if (status !== 200) break;
      for (const p of body.data ?? []) {
        const solIsX = p.token_x?.address === WSOL, solIsY = p.token_y?.address === WSOL;
        if (solIsX === solIsY || p.is_blacklisted) continue;
        const t = solIsX ? p.token_y : p.token_x;
        const price = Number(p.current_price), tvl = Number(p.tvl ?? 0);
        if (!(price > 0) || tvl < MIN_TVL) continue;
        const cfg = p.pool_config ?? {};
        out.push({ venue, address: p.address, mint: t.address, symbol: t.symbol ?? "?",
          priceSol: solIsX ? 1 / price : price,
          feePct: Number(cfg.base_fee_pct ?? 0) + (venue === "dlmm" ? Number(p.dynamic_fee_pct ?? 0) : 0),
          tvl, createdAt: Number(p.created_at ?? 0) });
      }
      if ((body.data ?? []).length < 1000) break;
      await sleep(150);
    }
  }
  return out;
}

/** Does Jupiter's chosen route go through this exact pool? Its route plan names each pool it uses. */
async function routedThrough(mint: string, poolAddress: string): Promise<{ routed: boolean; via: string[]; ok: boolean }> {
  const amount = Math.round(PROBE_SOL * 1e9);
  const { status, body } = await getJson(`${JUP}/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${amount}&slippageBps=200`);
  if (status !== 200 || !body?.routePlan) return { routed: false, via: [], ok: false };
  const keys = body.routePlan.map((s: any) => s.swapInfo?.ammKey).filter(Boolean);
  const labels = [...new Set<string>(body.routePlan.map((s: any) => s.swapInfo?.label).filter(Boolean))];
  return { routed: keys.includes(poolAddress), via: labels, ok: true };
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const watching = new Map<string, { pool: Pool; firstSeen: number; checks: number; routedAt: number | null }>();
  console.log(writeLine({ t: "start", lookbackMinutes: LOOKBACK_MINUTES, pollSeconds: POLL_SECONDS, probeSol: PROBE_SOL }));
  console.log(`watching for pools younger than ${LOOKBACK_MINUTES} min, checking whether Jupiter routes through them yet\n`);

  const startedAt = Date.now();
  for (let poll = 1; ; poll++) {
    const pools = await snapshot();
    const now = Date.now();
    const byMint = new Map<string, Pool[]>();
    for (const p of pools) (byMint.get(p.mint) ?? byMint.set(p.mint, []).get(p.mint)!).push(p);

    const fresh = pools.filter((p) => p.createdAt > 0 && (now - p.createdAt) / 60_000 < LOOKBACK_MINUTES);
    for (const p of fresh) if (!watching.has(p.address)) watching.set(p.address, { pool: p, firstSeen: now, checks: 0, routedAt: null });
    if (poll === 1) console.log(`${pools.length} pools, ${fresh.length} of them younger than ${LOOKBACK_MINUTES} min\n`);

    // Check the youngest unrouted pools first: that is where the lag, if any, still exists.
    const queue = [...watching.values()].filter((w) => w.routedAt === null)
      .sort((a, b) => b.pool.createdAt - a.pool.createdAt).slice(0, MAX_CHECKS);
    for (const w of queue) {
      const ageMin = (now - w.pool.createdAt) / 60_000;
      const r = await routedThrough(w.pool.mint, w.pool.address);
      w.checks++;
      // The other pools of the same token: the gap a router cannot yet see is the interesting one.
      const siblings = (byMint.get(w.pool.mint) ?? []).filter((s) => s.address !== w.pool.address);
      let gapPct: number | null = null, against: string | null = null;
      for (const s of siblings) {
        const [lo, hi] = w.pool.priceSol <= s.priceSol ? [w.pool, s] : [s, w.pool];
        const net = (hi.priceSol / lo.priceSol - 1) * 100 - (lo.feePct + hi.feePct);
        if (gapPct === null || net > gapPct) { gapPct = net; against = s.address; }
      }
      if (r.routed && w.routedAt === null) {
        w.routedAt = now;
        const lagMin = (now - w.pool.createdAt) / 60_000;
        console.log(writeLine({ t: "routed", pool: w.pool.address, token: w.pool.symbol, venue: w.pool.venue, ageAtRouteMin: +lagMin.toFixed(2), tvl: Math.round(w.pool.tvl), checks: w.checks }));
        console.log(`ROUTED  ${w.pool.symbol.padEnd(12)} ${w.pool.venue} pool is in Jupiter's route ${lagMin.toFixed(1)} min after creation`);
      } else {
        console.log(writeLine({ t: "check", pool: w.pool.address, token: w.pool.symbol, venue: w.pool.venue, ageMin: +ageMin.toFixed(2),
          routed: r.routed, quoteOk: r.ok, via: r.via, tvl: Math.round(w.pool.tvl), siblings: siblings.length,
          gapPct: gapPct === null ? null : +gapPct.toFixed(3), against }));
        if (gapPct !== null && gapPct > 2)
          console.log(`  UNROUTED GAP  ${w.pool.symbol.padEnd(12)} age ${ageMin.toFixed(1)} min, ${gapPct.toFixed(1)}% against a sibling pool, Jupiter routes via ${r.via.join("+") || "nothing"}`);
      }
      await sleep(60_000 / 25); // stay inside Jupiter's keyless rate
    }

    const routed = [...watching.values()].filter((w) => w.routedAt !== null);
    console.log(writeLine({ t: "poll", poll, pools: pools.length, watching: watching.size, routed: routed.length, checkedThisPoll: queue.length }));
    console.log(`poll ${poll}: watching ${watching.size} new pools, ${routed.length} now routed by Jupiter`);
    if (RUN_MINUTES > 0 && (now - startedAt) / 60_000 >= RUN_MINUTES) break;
    await sleep(POLL_SECONDS * 1000);
  }

  const lags = [...watching.values()].filter((w) => w.routedAt !== null).map((w) => (w.routedAt! - w.pool.createdAt) / 60_000);
  if (lags.length) {
    lags.sort((a, b) => a - b);
    console.log(`\nindexing lag, minutes from pool creation to Jupiter routing through it:`);
    console.log(`   n=${lags.length}  fastest ${lags[0].toFixed(1)}  median ${lags[Math.floor(lags.length / 2)].toFixed(1)}  slowest ${lags[lags.length - 1].toFixed(1)}`);
  } else console.log(`\nno pool was seen becoming routed during this run.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
