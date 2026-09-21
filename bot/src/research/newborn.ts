import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";

// Usage: npm run newborn                   (free: Meteora's lists and Jupiter's public endpoint, no Helius credits)
//        MAX_AGE_MIN=90 RUN_MINUTES=60 npm run newborn
//
// Price agreement between two pools of the same token is not natural: arbitrage bots CREATE it by trading until the
// difference is gone. A token whose pools were born minutes ago has not had that work done to it yet. Every earlier
// test looked for a gap that had OPENED in a settled market and found it already closed; this looks for one that was
// never closed, because the market is too young to have been arbitraged at all.
//
// Two measurements per newborn token:
//   1. LIST GAP: the difference between its pools, from Meteora's own prices.
//   2. REAL ROUND TRIP: Jupiter quoting SOL -> token -> SOL. Jupiter routes each leg through the best venue it knows,
//      so a positive answer means the gap is executable across the whole market, not just on paper.
// The pool addresses are written out so the depth checker can read them directly, which works even when Jupiter has
// not indexed the pool yet.
const DLMM_API = process.env.DLMM_API ?? "https://dlmm.datapi.meteora.ag";
const DAMM_API = process.env.DAMM_API ?? "https://damm-v2.datapi.meteora.ag";
const JUP = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN ?? 90);
const MIN_TVL = Number(process.env.MIN_TVL ?? 200);      // below this a pool holds nothing worth trading
const MIN_VOL = Number(process.env.MIN_VOL ?? 500);      // and it must actually be trading
const SIZES_SOL = (process.env.SIZES_SOL ?? "0.05,0.2").split(",").map(Number);
const PAGES = Number(process.env.PAGES ?? 3);
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 120);
const MAX_CHECKS = Number(process.env.MAX_CHECKS ?? 8);  // Jupiter round trips per poll, inside the keyless rate
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 0);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 100); // young pools move; this is a quote, not an order
const COST_LAMPORTS = Number(process.env.COST_LAMPORTS ?? 5_000);
const LOG_DIR = process.env.LOG_DIR ?? "logs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `newborn-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
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
let lastReason = "";
async function out(inputMint: string, outputMint: string, amount: string): Promise<number | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, body } = await getJson(`${JUP}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`);
    if (status === 200 && body?.outAmount) return Number(body.outAmount);
    if (status === 429) { lastReason = "rate limited"; await sleep(4000 * attempt); continue; }
    lastReason = status === 400 ? (body?.errorCode ?? "no route") : `HTTP ${status}`;
    return null;
  }
  return null;
}

type Pool = { venue: "dlmm" | "damm"; address: string; mint: string; symbol: string; decimals: number;
  priceSol: number; feePct: number; tvl: number; vol24h: number; ageMin: number; bornToday: boolean };

async function snapshot(): Promise<Pool[]> {
  const now = Date.now();
  const out: Pool[] = [];
  for (const [venue, base] of [["dlmm", DLMM_API], ["damm", DAMM_API]] as const) {
    for (let page = 1; page <= PAGES; page++) {
      const { status, body } = await getJson(`${base}/pools?page=${page}&page_size=1000&sort_by=volume_24h:desc`);
      if (status !== 200) break;
      for (const p of body.data ?? []) {
        const solIsX = p.token_x?.address === WSOL, solIsY = p.token_y?.address === WSOL;
        if (solIsX === solIsY || p.is_blacklisted) continue;
        const created = Number(p.created_at ?? 0);
        if (!created) continue;
        const ageMin = (now - created) / 60_000;
        if (ageMin > MAX_AGE_MIN || ageMin < 0) continue;
        const t = solIsX ? p.token_y : p.token_x;
        const price = Number(p.current_price);
        if (!(price > 0)) continue;
        const cfg = p.pool_config ?? {};
        const vol = Number(p.volume?.["24h"] ?? 0);
        const cum = Number(p.cumulative_metrics?.volume ?? 0);
        out.push({ venue, address: p.address, mint: t.address, symbol: t.symbol ?? "?", decimals: Number(t.decimals ?? 0),
          priceSol: solIsX ? 1 / price : price,
          feePct: Number(cfg.base_fee_pct ?? 0) + (venue === "dlmm" ? Number(p.dynamic_fee_pct ?? 0) : 0),
          tvl: Number(p.tvl ?? 0), vol24h: vol, ageMin,
          // A pool whose lifetime volume equals its 24 h volume has never seen a day pass: it really is new.
          bornToday: cum > 0 && Math.abs(cum - vol) / Math.max(cum, 1) < 0.02 });
      }
      if ((body.data ?? []).length < 1000) break;
      await sleep(150);
    }
  }
  return out;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(writeLine({ t: "start", maxAgeMin: MAX_AGE_MIN, minTvl: MIN_TVL, minVol: MIN_VOL, sizes: SIZES_SOL }));
  console.log(`looking for tokens whose pools are all younger than ${MAX_AGE_MIN} min: too young to have been arbitraged\n`);
  const seen = new Set<string>();
  let best = { pct: -Infinity, label: "" };
  const startedAt = Date.now();

  for (let poll = 1; ; poll++) {
    const fresh = await snapshot();
    const byMint = new Map<string, Pool[]>();
    for (const p of fresh) (byMint.get(p.mint) ?? byMint.set(p.mint, []).get(p.mint)!).push(p);

    // A token needs two young pools that both hold something and both trade: one live pool and one husk is no market.
    const candidates: { symbol: string; mint: string; pools: Pool[]; listGapPct: number; cheap: Pool; dear: Pool }[] = [];
    for (const [mint, all] of byMint) {
      const usable = all.filter((p) => p.tvl >= MIN_TVL && p.vol24h >= MIN_VOL);
      if (usable.length < 2) continue;
      let cheap = usable[0], dear = usable[0];
      for (const p of usable) { if (p.priceSol < cheap.priceSol) cheap = p; if (p.priceSol > dear.priceSol) dear = p; }
      const listGapPct = (dear.priceSol / cheap.priceSol - 1) * 100 - (cheap.feePct + dear.feePct);
      candidates.push({ symbol: cheap.symbol, mint, pools: usable, listGapPct, cheap, dear });
    }
    candidates.sort((a, b) => b.listGapPct - a.listGapPct);
    console.log(`poll ${poll}: ${fresh.length} pools under ${MAX_AGE_MIN} min; ${byMint.size} tokens; ${candidates.length} with two tradeable young pools`);

    for (const c of candidates.slice(0, MAX_CHECKS)) {
      const ages = c.pools.map((p) => p.ageMin.toFixed(0)).join("/");
      const line: Record<string, unknown> = { t: "newborn", token: c.symbol, mint: c.mint, poolCount: c.pools.length,
        agesMin: c.pools.map((p) => +p.ageMin.toFixed(1)), listGapPct: +c.listGapPct.toFixed(3),
        pools: c.pools.map((p) => ({ venue: p.venue, address: p.address, tvl: Math.round(p.tvl), vol24h: Math.round(p.vol24h), feePct: +p.feePct.toFixed(3), bornToday: p.bornToday })) };

      // The real test: Jupiter buying and selling back. Each leg goes through the best venue it knows.
      const trips: string[] = [];
      for (const sizeSol of SIZES_SOL) {
        const lamports = Math.round(sizeSol * 1e9);
        const bought = await out(WSOL, c.mint, String(lamports));
        if (bought === null) { trips.push(`${sizeSol} SOL: buy failed (${lastReason})`); await sleep(60_000 / 25); continue; }
        const backSol = await out(c.mint, WSOL, String(bought));
        if (backSol === null) { trips.push(`${sizeSol} SOL: sell failed (${lastReason})`); await sleep(60_000 / 25); continue; }
        const netPct = (backSol / lamports - 1) * 100;
        const profit = (backSol - lamports - COST_LAMPORTS) / 1e9;
        line[`net_${sizeSol}`] = +netPct.toFixed(4);
        line[`profitSol_${sizeSol}`] = +profit.toFixed(9);
        trips.push(`${sizeSol} SOL ${pct(netPct)}`);
        if (netPct > best.pct) best = { pct: netPct, label: `${c.symbol} at ${sizeSol} SOL, pools aged ${ages} min` };
        if (profit > 0) console.log(`   *** PROFIT  ${c.symbol} ${sizeSol} SOL ${pct(netPct)} = ${profit.toFixed(6)} SOL after the base fee`);
        await sleep(60_000 / 25);
      }
      writeLine(line);
      const key = `${c.mint}|${Math.round(c.listGapPct)}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`   ${c.symbol.padEnd(12)} ${c.pools.length} pools aged ${ages} min, list gap ${pct(c.listGapPct).padStart(10)}  ->  ${trips.join("   ")}`);
        console.log(`      ${c.pools.map((p) => `${p.venue} ${p.address.slice(0, 6)} $${Math.round(p.tvl)}`).join("  |  ")}`);
      }
    }

    // Hand the pool addresses to the depth checker, which reads named pools directly even when Jupiter cannot route them.
    if (candidates.length) {
      const head = ["symbol", "mint", "holders", "verified", "pools", "token_vol24h", "buy_venue", "buy_pool", "buy_detail", "buy_fee_pct", "buy_tvl", "buy_vol24h", "sell_venue", "sell_pool", "sell_detail", "sell_fee_pct", "sell_tvl", "sell_vol24h", "gap_pct", "fees_pct", "net_pct"];
      const rows = candidates.slice(0, 10).map((c) => {
        const fees = c.cheap.feePct + c.dear.feePct;
        return [c.symbol, c.mint, 0, false, c.pools.length, Math.round(c.pools.reduce((s, p) => s + p.vol24h, 0)),
          c.cheap.venue, c.cheap.address, c.cheap.venue, c.cheap.feePct.toFixed(3), Math.round(c.cheap.tvl), Math.round(c.cheap.vol24h),
          c.dear.venue, c.dear.address, c.dear.venue, c.dear.feePct.toFixed(3), Math.round(c.dear.tvl), Math.round(c.dear.vol24h),
          (c.listGapPct + fees).toFixed(3), fees.toFixed(3), c.listGapPct.toFixed(3)].join("\t");
      });
      writeFileSync(join("..", "research", "coverage_candidates.tsv"), [head.join("\t"), ...rows].join("\n") + "\n");
    }

    if (RUN_MINUTES > 0 && (Date.now() - startedAt) / 60_000 >= RUN_MINUTES) break;
    await sleep(POLL_SECONDS * 1000);
  }
  console.log(`\nbest round trip on a newborn token: ${pct(best.pct)}  (${best.label || "none"})`);
  console.log(`pool addresses written to research/coverage_candidates.tsv: run \`ROWS=10 npm run candidates:depth\` to read their real liquidity`);
}

main().catch((e) => { console.error(e); process.exit(1); });
