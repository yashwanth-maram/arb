import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { WSOL } from "../config/watchlist";
import { decodeDlmmRaw, summarizeDlmm } from "../decoders/meteora_dlmm";

// Usage: npm run diverge                    (free: Meteora's public lists; a few Helius credits only for the staleness check)
//        THRESHOLD=20 POLL_SECONDS=30 npm run diverge
//
// The ANB detector, generalised. That event was one token with two pools: a huge sell crashed one while the other
// held its price, and the gap between them was the prize. Our old watcher followed six pools by name. This one
// follows EVERY live SOL pool on Meteora (about 2,700) by polling the public lists, and alarms on any token whose
// two pools disagree by more than THRESHOLD percent after fees. No pool list to choose, no Helius credits to stream.
//
// Before watching anything it measures how STALE those list prices are, by reading a few pools straight from the
// chain and comparing. That number decides what this tool can be: a live detector, or only a forensic one.
const DLMM_API = process.env.DLMM_API ?? "https://dlmm.datapi.meteora.ag";
const DAMM_API = process.env.DAMM_API ?? "https://damm-v2.datapi.meteora.ag";
const THRESHOLD = Number(process.env.THRESHOLD ?? 20);        // percent, after fees: crash-scale, not everyday noise
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 30);
const PAGES = Number(process.env.PAGES ?? 3);                 // 1,000 pools a page, per venue
const MIN_TVL = Number(process.env.MIN_TVL ?? 500);           // a pool below this cannot hold a real trade
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 0);     // 0 = run until stopped
const LOG_DIR = process.env.LOG_DIR ?? "logs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logPath = () => join(LOG_DIR, `divergence_all-${new Date().toISOString().slice(0, 10)}.jsonl`);
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(logPath(), line + "\n");
  return line;
}

function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { family: 4, timeout: 60_000, headers: { accept: "application/json" } }, (res) => {
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

type Pool = { venue: "dlmm" | "damm"; address: string; mint: string; symbol: string; decimals: number;
  priceSol: number; feePct: number; tvl: number; vol24h: number };

/** Every live SOL pool on both venues, reduced to price and fee. One call per page, no credits. */
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
        const price = Number(p.current_price);
        const tvl = Number(p.tvl ?? 0);
        if (!(price > 0) || tvl < MIN_TVL) continue;
        const cfg = p.pool_config ?? {};
        out.push({
          venue, address: p.address, mint: t.address, symbol: t.symbol ?? "?", decimals: Number(t.decimals ?? 0),
          priceSol: solIsX ? 1 / price : price,
          feePct: Number(cfg.base_fee_pct ?? 0) + (venue === "dlmm" ? Number(p.dynamic_fee_pct ?? 0) : 0),
          tvl, vol24h: Number(p.volume?.["24h"] ?? 0),
        });
      }
      if ((body.data ?? []).length < 1000) break;
      await sleep(150);
    }
  }
  return out;
}

/** How old are the list prices? Read the same DLMM pools from the chain and compare. A few credits, once. */
async function staleness(pools: Pool[]) {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.log("staleness check skipped: no HELIUS_API_KEY\n"); return; }
  const conn = new Connection(HTTP, "processed");
  // Busy pools move most, so they show staleness most clearly.
  const sample = pools.filter((p) => p.venue === "dlmm").sort((a, b) => b.vol24h - a.vol24h).slice(0, 5);
  const infos = await conn.getMultipleAccountsInfo(sample.map((p) => new PublicKey(p.address)), "processed");
  console.log("how stale are the list prices? (list price against a live read of the same pool)");
  const diffs: number[] = [];
  sample.forEach((p, i) => {
    const info = infos[i];
    if (!info) return;
    const lb = decodeDlmmRaw(Buffer.from(info.data));
    const xIsSol = lb.tokenXMint.toBase58() === WSOL;
    const s = summarizeDlmm(p.address, lb, xIsSol ? 9 : p.decimals, xIsSol ? p.decimals : 9);
    const live = xIsSol ? 1 / s.price : s.price;
    const diff = (p.priceSol / live - 1) * 100;
    diffs.push(Math.abs(diff));
    const age = Math.floor(Date.now() / 1000) - s.lastUpdatedAt;
    console.log(`   ${p.symbol.padEnd(10)} list ${p.priceSol.toExponential(4)}  live ${live.toExponential(4)}  differ ${diff >= 0 ? "+" : ""}${diff.toFixed(4)}%   (pool last traded ${age}s ago)`);
  });
  if (diffs.length) {
    const worst = Math.max(...diffs);
    console.log(`   worst disagreement ${worst.toFixed(4)}%. ${worst < 0.5 ? "The lists are fresh enough to detect a crash-scale gap live." : "The lists lag: useful for finding events, not for racing them."}\n`);
  }
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`reading every live SOL pool on Meteora, ${PAGES} page(s) a venue, TVL >= $${MIN_TVL}\n`);
  const first = await snapshot();
  console.log(`${first.length} live SOL pools\n`);
  await staleness(first);

  console.log(writeLine({ t: "start", pid: process.pid, pools: first.length, thresholdPct: THRESHOLD, pollSeconds: POLL_SECONDS }));
  console.log(`watching for any token whose two pools disagree by more than ${THRESHOLD}% after fees, every ${POLL_SECONDS}s.`);
  console.log(`(the ANB event was a 99% disagreement; everyday noise is under 1%)\n`);

  const open = new Map<string, { since: number; polls: number; peak: number }>();
  const startedAt = Date.now();
  for (let poll = 1; ; poll++) {
    const pools = poll === 1 ? first : await snapshot();
    const byMint = new Map<string, Pool[]>();
    for (const p of pools) (byMint.get(p.mint) ?? byMint.set(p.mint, []).get(p.mint)!).push(p);

    const alarms: { mint: string; symbol: string; netPct: number; cheap: Pool; dear: Pool }[] = [];
    for (const list of byMint.values()) {
      if (list.length < 2) continue;
      let best: (typeof alarms)[number] | null = null;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [cheap, dear] = list[i].priceSol <= list[j].priceSol ? [list[i], list[j]] : [list[j], list[i]];
        const netPct = (dear.priceSol / cheap.priceSol - 1) * 100 - (cheap.feePct + dear.feePct);
        if (!best || netPct > best.netPct) best = { mint: cheap.mint, symbol: cheap.symbol, netPct, cheap, dear };
      }
      if (best && best.netPct > THRESHOLD) alarms.push(best);
    }
    alarms.sort((a, b) => b.netPct - a.netPct);

    const now = Date.now();
    for (const a of alarms) {
      const prev = open.get(a.mint);
      if (prev) { prev.polls++; prev.peak = Math.max(prev.peak, a.netPct); }
      else {
        open.set(a.mint, { since: now, polls: 1, peak: a.netPct });
        console.log(writeLine({ t: "alarm", token: a.symbol, mint: a.mint, netPct: +a.netPct.toFixed(3),
          buy: { venue: a.cheap.venue, address: a.cheap.address, tvl: Math.round(a.cheap.tvl), feePct: a.cheap.feePct },
          sell: { venue: a.dear.venue, address: a.dear.address, tvl: Math.round(a.dear.tvl), feePct: a.dear.feePct } }));
        console.log(`ALARM ${a.symbol} ${a.netPct.toFixed(1)}%  buy ${a.cheap.venue} ($${Math.round(a.cheap.tvl)}) -> sell ${a.dear.venue} ($${Math.round(a.dear.tvl)})`);
      }
    }
    // A gap that is gone by the next poll never survived long enough for anyone slow to take it.
    for (const [mint, info] of [...open]) {
      if (alarms.some((a) => a.mint === mint)) continue;
      const lastedSec = Math.round((now - info.since) / 1000);
      writeLine({ t: "closed", mint, lastedSec, polls: info.polls, peakPct: +info.peak.toFixed(3) });
      console.log(`  closed ${mint.slice(0, 6)}...  lasted ${lastedSec}s across ${info.polls} poll(s), peak ${info.peak.toFixed(1)}%`);
      open.delete(mint);
    }

    const tokens = [...byMint.values()].filter((l) => l.length >= 2).length;
    console.log(writeLine({ t: "poll", poll, pools: pools.length, tokensWithTwoPools: tokens, alarms: alarms.length, stillOpen: open.size }));
    if (RUN_MINUTES > 0 && (now - startedAt) / 60_000 >= RUN_MINUTES) break;
    await sleep(POLL_SECONDS * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
