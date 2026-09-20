import http from "node:http";
import https from "node:https";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { WSOL } from "../config/watchlist";
import { ShadowGate, shadowRun, type ShadowConfig } from "../exec/shadow";

// Usage: npm run jup            (free: Jupiter's public endpoint, no key, no Helius credits)
// The whole-market test. Jupiter routes across every Solana venue and its quote returns the REAL output amount,
// fees and depth included. So "spend S SOL on a token, sell every unit straight back" is a two-leg arbitrage across
// the entire market, priced in two requests. Runs forever; one JSON line per round trip in logs/jupiter-YYYY-MM-DD.jsonl.
const BASE = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const KEY = process.env.JUP_API_KEY ?? "";             // optional: a free key doubles the rate to 60/min
const REQ_PER_MIN = Number(process.env.REQ_PER_MIN ?? (KEY ? 55 : 25)); // stay under the published ceiling
const BASE_SIZE = Number(process.env.BASE_SIZE_SOL ?? 0.5);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
// Jupiter quotes exclude what it costs to LAND the trade. A two-swap arbitrage needs one signature (5,000 lamports)
// and, to beat other bots to the slot, a tip. A measured winner paid 7.48M lamports for one trade; 100,000 is a floor.
const BASE_FEE_LAMPORTS = Number(process.env.BASE_FEE_LAMPORTS ?? 5_000);
const TIP_LAMPORTS = Number(process.env.TIP_LAMPORTS ?? 100_000);
// Those costs are FIXED per trade, so what matters is profit in SOL, not percent: a 0.02% gap pays nothing on 0.5 SOL
// and about half a dollar on 50 SOL. Flash loans make size independent of the wallet, so the ladder runs well past it.
const FOLLOWUP_SIZES = (process.env.FOLLOWUP_SIZES ?? "0.1,2,10,50").split(",").map(Number);
const FOLLOWUP_PCT = Number(process.env.FOLLOWUP_PCT ?? -0.05); // only a real near miss earns the extra requests
const TOKENS = Number(process.env.TOKENS ?? 200);
const MIN_VOL = Number(process.env.MIN_VOL ?? 20_000);  // a token needs this much 24 h volume to be worth sweeping
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const TOKENS_FILE = join(LOG_DIR, "jup", "tokens.json");
const TOKENS_MAX_AGE_H = Number(process.env.TOKENS_MAX_AGE_H ?? 12);
const DLMM_API = process.env.DLMM_API ?? "https://dlmm.datapi.meteora.ag";
const DAMM_API = process.env.DAMM_API ?? "https://damm-v2.datapi.meteora.ag";
// Shadow execution: when a round trip comes back above zero, build the real two-swap transaction and run it against
// live chain state. Nothing is signed or sent. About 2 Helius credits a shot, so it is capped per hour.
const SHADOW = process.env.SHADOW !== "0";
const SHADOW_PAYER = process.env.SIM_PAYER ?? "";           // a funded PUBLIC address standing in for a wallet
const SHADOW_MAX_PER_HOUR = Number(process.env.SHADOW_MAX_PER_HOUR ?? 60);
const SHADOW_MIN_INTERVAL_MS = Number(process.env.SHADOW_MIN_INTERVAL_MS ?? 5_000);
const SHADOW_SIZE_CAP_SOL = Number(process.env.SHADOW_SIZE_CAP_SOL ?? 2);  // wider routes will not fit one transaction

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logPath = () => join(LOG_DIR, `jupiter-${new Date().toISOString().slice(0, 10)}.jsonl`);
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(logPath(), line + "\n");
  return line;
}

/** GET a JSON document over IPv4 (IPv6 is dead inside this WSL), with a time limit. Returns the status too. */
function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { family: 4, timeout: 30_000, headers: { accept: "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: { raw: text.slice(0, 200) } }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out after 30 s")));
    req.on("error", reject);
  });
}

// ---- rate limiter -------------------------------------------------------------------------------
let nextSlot = 0;
/** Wait for this caller's turn and reserve n request slots. Reserving both legs at once keeps them milliseconds
 * apart instead of seconds: two quotes taken seconds apart measure price drift, not an arbitrage. */
async function reserve(n: number): Promise<void> {
  const gap = 60_000 / REQ_PER_MIN;
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + gap * n;
  if (wait > 0) await sleep(wait);
}

type Token = { symbol: string; mint: string; decimals: number; vol24h: number };

/** Tokens to sweep, from Meteora's public pool lists (a verified source of live Solana tokens with real volume).
 * Their venue does not matter here: Jupiter quotes each of them across every DEX on Solana. */
async function loadTokens(): Promise<Token[]> {
  if (existsSync(TOKENS_FILE) && (Date.now() - statSync(TOKENS_FILE).mtimeMs) / 3.6e6 < TOKENS_MAX_AGE_H) {
    const cached = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Token[];
    console.log(`${cached.length} tokens from ${TOKENS_FILE} (cached)`);
    return cached;
  }
  const byMint = new Map<string, Token>();
  for (const base of [DLMM_API, DAMM_API]) {
    for (let page = 1; page <= 3; page++) {
      const { status, body } = await getJson(`${base}/pools?page=${page}&page_size=1000&sort_by=volume_24h:desc`);
      if (status !== 200) { console.log(`  ${base} page ${page}: HTTP ${status}`); break; }
      for (const p of body.data ?? []) {
        const solIsX = p.token_x?.address === WSOL, solIsY = p.token_y?.address === WSOL;
        if (solIsX === solIsY || p.is_blacklisted) continue;
        const t = solIsX ? p.token_y : p.token_x;
        if (!t?.freeze_authority_disabled) continue;
        const vol = Number(p.volume?.["24h"] ?? 0);
        const prev = byMint.get(t.address);
        byMint.set(t.address, { symbol: t.symbol, mint: t.address, decimals: Number(t.decimals), vol24h: (prev?.vol24h ?? 0) + vol });
      }
      if ((body.data ?? []).length < 1000) break;
      await sleep(200);
    }
  }
  const tokens = [...byMint.values()].filter((t) => t.vol24h >= MIN_VOL && t.decimals >= 0).sort((a, b) => b.vol24h - a.vol24h).slice(0, TOKENS);
  mkdirSync(join(LOG_DIR, "jup"), { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 1) + "\n");
  console.log(`${tokens.length} tokens with 24 h volume >= $${MIN_VOL}, written to ${TOKENS_FILE}`);
  return tokens;
}

type Quote = { outAmount: string; priceImpactPct: string; routePlan?: { swapInfo: { label: string } }[]; contextSlot?: number };

async function quote(inputMint: string, outputMint: string, amount: string): Promise<Quote> {
  const url = `${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
  const { status, body } = await getJson(url, KEY ? { "x-api-key": KEY } : {});
  if (status === 429) throw Object.assign(new Error("rate limited (429)"), { rateLimited: true });
  if (status !== 200 || !body?.outAmount) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0, 120)}`);
  return body as Quote;
}

const venues = (q: Quote) => [...new Set((q.routePlan ?? []).map((s) => s.swapInfo.label))];

/** Spend sizeSol on the token, then sell every unit straight back. Both legs are quoted back to back. */
async function roundTrip(t: Token, sizeSol: number) {
  const lamports = Math.round(sizeSol * 1e9);
  await reserve(2);
  const startedAt = Date.now();
  const buy = await quote(WSOL, t.mint, String(lamports));
  const sell = await quote(t.mint, WSOL, buy.outAmount);
  const back = Number(sell.outAmount);
  const [buySlot, sellSlot] = [buy.contextSlot ?? 0, sell.contextSlot ?? 0];
  return {
    netPct: (back / lamports - 1) * 100,
    netAfterFeesPct: ((back - BASE_FEE_LAMPORTS - TIP_LAMPORTS) / lamports - 1) * 100,
    profitSol: (back - lamports) / 1e9,
    profitAfterFeesSol: (back - lamports - BASE_FEE_LAMPORTS - TIP_LAMPORTS) / 1e9,
    outSol: back / 1e9,
    tokens: Number(buy.outAmount) / 10 ** t.decimals,
    buyVia: venues(buy), sellVia: venues(sell),
    impact: [Number(buy.priceImpactPct), Number(sell.priceImpactPct)],
    // Same slot on both legs means one consistent picture of the market; different slots may be drift.
    buySlot, sellSlot, slotGap: buySlot && sellSlot ? sellSlot - buySlot : null,
    legGapMs: Date.now() - startedAt,
  };
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const tokens = await loadTokens();
  if (tokens.length === 0) { console.error("no tokens to sweep"); process.exit(1); }
  let shadowCfg: ShadowConfig | null = null;
  let conn: Connection | null = null;
  const shadowGate = new ShadowGate({ maxPerHour: SHADOW_MAX_PER_HOUR, minIntervalMs: SHADOW_MIN_INTERVAL_MS });
  if (SHADOW) {
    try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
    const rpc = process.env.RPC_HTTP ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
    if (!rpc) console.log("shadow off: no RPC (set HELIUS_API_KEY in bot/.env, or SHADOW=0 to silence this)");
    else if (!SHADOW_PAYER) console.log("shadow off: no SIM_PAYER (run `npm run exec:payer` to find one)");
    else { conn = new Connection(rpc, "processed"); shadowCfg = { payer: new PublicKey(SHADOW_PAYER), maxPerHour: SHADOW_MAX_PER_HOUR, minIntervalMs: SHADOW_MIN_INTERVAL_MS, sizeCapSol: SHADOW_SIZE_CAP_SOL }; }
  }
  console.log(writeLine({ t: "start", pid: process.pid, base: BASE, keyed: !!KEY, reqPerMin: REQ_PER_MIN, tokens: tokens.length, baseSizeSol: BASE_SIZE, tipLamports: TIP_LAMPORTS, shadow: !!shadowCfg, shadowMaxPerHour: SHADOW_MAX_PER_HOUR }));
  console.log(`sweeping ${tokens.length} tokens at ${BASE_SIZE} SOL, about ${(tokens.length * 2 * 60 / REQ_PER_MIN / 60).toFixed(1)} min per sweep; anything above ${FOLLOWUP_PCT}% is re-tested at ${FOLLOWUP_SIZES.join(", ")} SOL`);

  let sweep = 0, trips = 0, errors = 0, hits = 0;
  const shadowTally: Record<string, number> = {};
  let best = { profitAfterFeesSol: -Infinity, netPct: 0, symbol: "", sizeSol: 0, ts: "" };
  for (;;) {
    sweep++;
    const startedAt = Date.now();
    const nets: { sym: string; netPct: number; sizeSol: number; profitAfterFeesSol: number; slotGap: number | null }[] = [];
    for (const t of tokens) {
      const sizes = [BASE_SIZE];
      for (let i = 0; i < sizes.length; i++) {
        const sizeSol = sizes[i];
        try {
          const r = await roundTrip(t, sizeSol);
          trips++;
          writeLine({
            t: r.netPct > 0 ? "hit" : "rt", sym: t.symbol, mint: t.mint, sizeSol,
            netPct: +r.netPct.toFixed(4), netAfterFeesPct: +r.netAfterFeesPct.toFixed(4),
            profitSol: +r.profitSol.toFixed(9), profitAfterFeesSol: +r.profitAfterFeesSol.toFixed(9),
            outSol: +r.outSol.toFixed(6), buyVia: r.buyVia, sellVia: r.sellVia, impact: r.impact,
            buySlot: r.buySlot, sellSlot: r.sellSlot, slotGap: r.slotGap, legGapMs: r.legGapMs, sweep,
          });
          nets.push({ sym: t.symbol, netPct: r.netPct, sizeSol, profitAfterFeesSol: r.profitAfterFeesSol, slotGap: r.slotGap });
          if (r.profitAfterFeesSol > best.profitAfterFeesSol) best = { profitAfterFeesSol: r.profitAfterFeesSol, netPct: r.netPct, symbol: t.symbol, sizeSol, ts: new Date().toISOString() };
          if (r.netPct > 0) {
            hits++;
            console.log(`HIT  ${t.symbol} ${String(sizeSol).padStart(4)} SOL  +${r.netPct.toFixed(4)}%  profit ${r.profitSol.toFixed(6)} SOL, after costs ${r.profitAfterFeesSol.toFixed(6)} SOL  slots ${r.buySlot}/${r.sellSlot} (${r.legGapMs} ms)  buy ${r.buyVia.join("+")} -> sell ${r.sellVia.join("+")}`);
            // Look again at once: a gap that is gone on the second look was drift, not an opportunity.
            try {
              const again = await roundTrip(t, sizeSol);
              writeLine({ t: "confirm", sym: t.symbol, sizeSol, firstPct: +r.netPct.toFixed(4), againPct: +again.netPct.toFixed(4), againProfitAfterFeesSol: +again.profitAfterFeesSol.toFixed(9), buySlot: again.buySlot, sellSlot: again.sellSlot, legGapMs: again.legGapMs, sweep });
              console.log(`     re-check: ${again.netPct > 0 ? "still" : "gone"} ${again.netPct.toFixed(4)}%  (${again.profitAfterFeesSol.toFixed(6)} SOL after costs)`);
            } catch (e) { writeLine({ t: "confirm_err", sym: t.symbol, sizeSol, msg: (e as Error).message.slice(0, 160) }); }
            // The question a quote cannot answer: would it actually have worked on chain?
            if (shadowCfg && conn && shadowGate.tryStart()) {
              const sh = await shadowRun(conn, t.mint, sizeSol, shadowCfg);
              shadowTally[sh.verdict] = (shadowTally[sh.verdict] ?? 0) + 1;
              writeLine({ t: "shadow", sym: t.symbol, mint: t.mint, sizeSol, ...sh, sweep });
              const measured = sh.simulatedPct === null ? "" : `, measured ${sh.simulatedPct >= 0 ? "+" : ""}${sh.simulatedPct.toFixed(4)}%`;
              console.log(`     shadow: ${sh.verdict}${measured}  (${sh.sizeBytes ?? "-"} bytes, ${sh.computeUnits ?? "-"} CU, ${sh.ms} ms)${sh.err && sh.verdict !== "cancelled_by_profit_check" ? `  ${sh.err}` : ""}`);
            }
          }
          // A near miss at the base size earns the size ladder: the gap is fixed in percent, the costs are fixed in SOL.
          if (i === 0 && r.netPct > FOLLOWUP_PCT) sizes.push(...FOLLOWUP_SIZES);
        } catch (e) {
          errors++;
          const msg = (e as Error).message;
          writeLine({ t: "err", sym: t.symbol, mint: t.mint, sizeSol, msg: msg.slice(0, 160) });
          if ((e as any).rateLimited) await sleep(20_000); // back off hard, then carry on
        }
      }
    }
    // Per-sweep shape, ranked by what would actually land in the wallet, in SOL.
    const mins = (Date.now() - startedAt) / 60_000;
    const sorted = [...nets].sort((a, b) => b.profitAfterFeesSol - a.profitAfterFeesSol);
    const above = (x: number) => sorted.filter((n) => n.netPct > x).length;
    console.log(writeLine({
      t: "sweep", sweep, minutes: +mins.toFixed(1), tripsThisSweep: nets.length, trips, hits, errors,
      shadow: { ...shadowTally, started: shadowGate.started, skipped: shadowGate.skipped },
      counts: { above0: above(0), aboveMinus025: above(-0.25), aboveMinus05: above(-0.5),
        afterCostsAbove0: sorted.filter((n) => n.profitAfterFeesSol > 0).length, sameSlot: nets.filter((n) => n.slotGap === 0).length },
      top: sorted.slice(0, 5).map((n) => ({ sym: n.sym, sizeSol: n.sizeSol, netPct: +n.netPct.toFixed(4), profitAfterFeesSol: +n.profitAfterFeesSol.toFixed(9) })),
      bestEver: { profitAfterFeesSol: +best.profitAfterFeesSol.toFixed(9), netPct: +best.netPct.toFixed(4), sym: best.symbol, sizeSol: best.sizeSol, ts: best.ts },
    }));
  }
}

main().catch((e) => { console.error(e); writeLine({ t: "fatal", msg: (e as Error).message }); process.exit(1); });
