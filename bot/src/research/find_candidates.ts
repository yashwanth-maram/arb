import http from "node:http";
import https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";

// Usage: npm run candidates        (no Helius credits: Meteora's public pool lists only)
// Coverage test, step 1: find tokens that have at least TWO live SOL pools on Meteora (DLMM and/or DAMM v2), outside the
// crowd of top tokens, and show how far apart their pool prices are right now. A gap that stays open in a public list
// that is minutes old is either a phantom (one-sided bin, fee trap) or a pair nobody arbitrages: later steps tell which.
// Tunables (env): MIN_TVL 5000, MIN_VOL 1000, MAX_VOL 300000 (token's 24 h volume, USD), MAX_FEE_PCT 3 (both pools summed),
//                 MAX_PAGES 40 (1,000 pools per page, lists are read by 24 h volume, highest first), TOP 40 rows printed.
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const MIN_TVL = num("MIN_TVL", 5000), MIN_VOL = num("MIN_VOL", 1000), MAX_VOL = num("MAX_VOL", 300_000);
const MAX_FEE_PCT = num("MAX_FEE_PCT", 3), MAX_PAGES = num("MAX_PAGES", 40), TOP = num("TOP", 40), PAGE_SIZE = num("PAGE_SIZE", 1000);
const DLMM_API = process.env.DLMM_API ?? "https://dlmm.datapi.meteora.ag";
const DAMM_API = process.env.DAMM_API ?? "https://damm-v2.datapi.meteora.ag";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a JSON document over IPv4 (IPv6 is dead inside this WSL), with a time limit and a few retries. */
async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = (url.startsWith("https:") ? https : http).get(url, { family: 4, timeout: 60_000, headers: { accept: "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            try { resolve(JSON.parse(body)); } catch { reject(new Error(`not JSON: ${body.slice(0, 200)}`)); }
          });
        });
        req.on("timeout", () => req.destroy(new Error("timed out after 60 s")));
        req.on("error", reject);
      });
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  retry ${attempt} for ${url.slice(0, 90)}: ${(e as Error).message}`);
      await sleep(1500 * attempt);
    }
  }
}

type Pool = {
  venue: "dlmm" | "damm"; address: string; name: string; mint: string; symbol: string; holders: number; verified: boolean;
  freezeDisabled: boolean; tvl: number; vol24h: number; feePct: number; detail: string; priceSol: number; createdAt: number;
};

/** One pool from either list, reduced to what we need; null unless it is a live SOL pool of a freeze-disabled token. */
function normalise(venue: "dlmm" | "damm", p: any): Pool | null {
  const solIsX = p.token_x?.address === WSOL, solIsY = p.token_y?.address === WSOL;
  if (solIsX === solIsY || p.is_blacklisted) return null;
  const token = solIsX ? p.token_y : p.token_x;
  const price = Number(p.current_price); // token Y per token X
  if (!(price > 0) || !token?.freeze_authority_disabled) return null;
  const cfg = p.pool_config ?? {};
  const feePct = Number(cfg.base_fee_pct ?? 0) + (venue === "dlmm" ? Number(p.dynamic_fee_pct ?? 0) : 0);
  const detail = venue === "dlmm" ? `bin ${cfg.bin_step}` : `${cfg.concentrated_liquidity ? "conc" : "full"}${cfg.is_fee_scheduler_active ? " sched!" : ""}`;
  return {
    venue, address: p.address, name: p.name, mint: token.address, symbol: token.symbol, holders: Number(token.holders ?? 0),
    verified: !!token.is_verified, freezeDisabled: true, tvl: Number(p.tvl ?? 0), vol24h: Number(p.volume?.["24h"] ?? 0),
    feePct, detail, priceSol: solIsX ? 1 / price : price, createdAt: Number(p.created_at ?? 0),
  };
}

/** Read one venue's list by 24 h volume, highest first, until the pages run out of volume worth looking at. */
async function readList(venue: "dlmm" | "damm", base: string): Promise<Pool[]> {
  const out: Pool[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await getJson(`${base}/pools?page=${page}&page_size=${PAGE_SIZE}&sort_by=volume_24h:desc`);
    const rows: any[] = d.data ?? [];
    if (page === 1) console.log(`${venue}: ${d.total} pools listed, ${d.pages} pages of ${d.page_size}`);
    for (const r of rows) { const p = normalise(venue, r); if (p) out.push(p); }
    const lastVol = Number(rows[rows.length - 1]?.volume?.["24h"] ?? 0);
    const sorted = rows.length < 2 || Number(rows[0]?.volume?.["24h"] ?? 0) >= lastVol;
    if (page === 1 && !sorted) console.log(`  WARNING: ${venue} page 1 is not sorted by volume; reading ${MAX_PAGES} pages anyway`);
    if (rows.length < PAGE_SIZE || (sorted && lastVol < MIN_VOL / 10) || page >= Number(d.pages ?? MAX_PAGES)) { console.log(`  ${venue}: read ${page} page(s), kept ${out.length} live SOL pools`); break; }
    if (page === MAX_PAGES) console.log(`  ${venue}: stopped at MAX_PAGES=${MAX_PAGES}, kept ${out.length} live SOL pools`);
    await sleep(200);
  }
  return out;
}

async function main() {
  const pools = [...await readList("dlmm", DLMM_API), ...await readList("damm", DAMM_API)];
  const byMint = new Map<string, Pool[]>();
  for (const p of pools) if (p.tvl >= MIN_TVL) (byMint.get(p.mint) ?? byMint.set(p.mint, []).get(p.mint)!).push(p);

  type Row = { a: Pool; b: Pool; pools: number; tokenVol: number; gapPct: number; feePct: number; netPct: number };
  const rows: Row[] = [];
  for (const list of byMint.values()) {
    if (list.length < 2) continue;
    const tokenVol = list.reduce((s, p) => s + p.vol24h, 0);
    if (tokenVol < MIN_VOL || tokenVol > MAX_VOL) continue;
    let best: Row | null = null;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [lo, hi] = list[i].priceSol <= list[j].priceSol ? [list[i], list[j]] : [list[j], list[i]]; // buy on a (cheaper), sell on b
      const feePct = lo.feePct + hi.feePct;
      if (feePct > MAX_FEE_PCT) continue;
      const gapPct = (hi.priceSol / lo.priceSol - 1) * 100;
      if (!best || gapPct - feePct > best.netPct) best = { a: lo, b: hi, pools: list.length, tokenVol, gapPct, feePct, netPct: gapPct - feePct };
    }
    if (best) rows.push(best);
  }
  rows.sort((x, y) => y.netPct - x.netPct);

  const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : x.toFixed(0));
  const label = (p: Pool) => `${p.venue} ${p.detail} ${p.feePct.toFixed(2)}% tvl ${k(p.tvl)} vol ${k(p.vol24h)}`;
  console.log(`\ntokens with 2+ live SOL pools (each TVL >= $${MIN_TVL}), token 24 h volume $${MIN_VOL}-$${MAX_VOL}, fees summed <= ${MAX_FEE_PCT}%: ${rows.length}`);
  console.log(`headline gap between their two best-placed pools right now (list prices, minutes old, NOT executable numbers):\n`);
  console.log(`${"token".padEnd(12)} ${"holders".padStart(7)} ${"pools".padStart(5)}  ${"buy on (cheaper)".padEnd(44)} ${"sell on".padEnd(44)} ${"gap%".padStart(7)} ${"fees%".padStart(6)} ${"net%".padStart(7)}`);
  for (const r of rows.slice(0, TOP))
    console.log(`${r.a.symbol.slice(0, 12).padEnd(12)} ${String(r.a.holders).padStart(7)} ${String(r.pools).padStart(5)}  ${label(r.a).padEnd(44)} ${label(r.b).padEnd(44)} ${r.gapPct.toFixed(2).padStart(7)} ${r.feePct.toFixed(2).padStart(6)} ${r.netPct.toFixed(2).padStart(7)}`);

  const outDir = join(__dirname, "..", "..", "..", "research");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "coverage_candidates.tsv");
  const head = ["symbol", "mint", "holders", "verified", "pools", "token_vol24h", "buy_venue", "buy_pool", "buy_detail", "buy_fee_pct", "buy_tvl", "buy_vol24h", "sell_venue", "sell_pool", "sell_detail", "sell_fee_pct", "sell_tvl", "sell_vol24h", "gap_pct", "fees_pct", "net_pct"];
  const line = (r: Row) => [r.a.symbol, r.a.mint, r.a.holders, r.a.verified, r.pools, r.tokenVol.toFixed(0), r.a.venue, r.a.address, r.a.detail, r.a.feePct.toFixed(3), r.a.tvl.toFixed(0), r.a.vol24h.toFixed(0), r.b.venue, r.b.address, r.b.detail, r.b.feePct.toFixed(3), r.b.tvl.toFixed(0), r.b.vol24h.toFixed(0), r.gapPct.toFixed(3), r.feePct.toFixed(3), r.netPct.toFixed(3)].join("\t");
  writeFileSync(file, [head.join("\t"), ...rows.map(line)].join("\n") + "\n");
  console.log(`\nwrote ${rows.length} rows to research/coverage_candidates.tsv   (positive net: ${rows.filter((r) => r.netPct > 0).length}, above -0.5%: ${rows.filter((r) => r.netPct > -0.5).length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
