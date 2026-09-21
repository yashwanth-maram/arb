import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";

// Usage: npm run sizes                     (free: Jupiter's public endpoint, no Helius credits)
//        TOKENS=20 RUN_MINUTES=40 npm run sizes
//
// Every previous test ran at 0.5 or 2 SOL. A $5 bankroll is about 0.042 SOL, fifty times smaller, and on thin
// liquidity that is a different regime. This sweeps the whole ladder from 0.005 to 0.5 SOL and reports the
// DISTRIBUTION of executable round trips at each size, not a single number.
//
// The arithmetic that makes it worth asking: the base fee is fixed at 5,000 lamports, so it is 0.0119% of a 0.042
// SOL stake and 0.00025% of a 2 SOL one. Small size makes the hurdle FIFTY TIMES harder. The only way it pays is if
// the gaps themselves are materially wider on small trades, because a small trade takes less liquidity and suffers
// less price impact. That is the hypothesis, and this measures it.
const BASE = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const REQ_PER_MIN = Number(process.env.REQ_PER_MIN ?? 25);
const SIZES = (process.env.SIZES ?? "0.005,0.01,0.02,0.042,0.1,0.5").split(",").map(Number);
const N = Number(process.env.TOKENS ?? 20);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const BASE_FEE = Number(process.env.BASE_FEE_LAMPORTS ?? 5_000);   // what a reverted attempt costs
const JITO_MIN_TIP = Number(process.env.JITO_MIN_TIP ?? 1_000);    // the smallest tip that can win a bundle slot
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 0);
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const TOKENS_FILE = join(LOG_DIR, "jup", "tokens.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}%`;
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `sizes-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  return line;
}
let nextSlot = 0;
async function reserve(n = 1) {
  const gap = 60_000 / REQ_PER_MIN;
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + gap * n;
  if (wait > 0) await sleep(wait);
}
function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { family: 4, timeout: 30_000, headers: { accept: "application/json" } }, (res) => {
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
    const { status, body } = await getJson(`${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
    if (status === 200 && body?.outAmount) return Number(body.outAmount);
    if (status === 429) { lastReason = "rate limited"; await sleep(4000 * attempt); continue; }
    lastReason = status === 400 ? (body?.errorCode ?? "no route") : `HTTP ${status}`;
    return null;
  }
  return null;
}

type Token = { symbol: string; mint: string };
const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const tokens: Token[] = JSON.parse(readFileSync(TOKENS_FILE, "utf8")).slice(0, N);
  console.log(writeLine({ t: "start", tokens: tokens.length, sizes: SIZES, baseFee: BASE_FEE }));
  console.log(`${tokens.length} tokens across ${SIZES.length} sizes: ${SIZES.join(", ")} SOL`);
  console.log(`the base fee is ${BASE_FEE} lamports whatever the size, so each size needs a different gap to clear it:`);
  for (const s of SIZES) console.log(`   ${String(s).padStart(6)} SOL needs ${((BASE_FEE / (s * 1e9)) * 100).toFixed(4)}% just for the signature, ${(((BASE_FEE + JITO_MIN_TIP) / (s * 1e9)) * 100).toFixed(4)}% with the smallest tip`);
  console.log();

  const nets = new Map<number, number[]>(SIZES.map((s) => [s, []]));
  const profits = new Map<number, number[]>(SIZES.map((s) => [s, []]));
  const startedAt = Date.now();

  for (let sweep = 1; ; sweep++) {
    for (const t of tokens) {
      for (const sizeSol of SIZES) {
        const lamports = Math.round(sizeSol * 1e9);
        await reserve(2);
        const bought = await out(WSOL, t.mint, String(lamports));
        if (bought === null) { writeLine({ t: "err", sym: t.symbol, sizeSol, msg: lastReason }); continue; }
        const back = await out(t.mint, WSOL, String(bought));
        if (back === null) { writeLine({ t: "err", sym: t.symbol, sizeSol, msg: lastReason }); continue; }
        const netPct = (back / lamports - 1) * 100;
        const profitLamports = back - lamports - BASE_FEE;
        nets.get(sizeSol)!.push(netPct);
        profits.get(sizeSol)!.push(profitLamports);
        writeLine({ t: "rt", sym: t.symbol, mint: t.mint, sizeSol, netPct: +netPct.toFixed(5), profitLamports, sweep });
        if (profitLamports > 0) console.log(`   *** ${t.symbol} ${sizeSol} SOL  ${pct(netPct)}  = ${profitLamports} lamports after the signature`);
      }
    }

    console.log(`\n--- after sweep ${sweep} ---`);
    console.log(`${"size".padStart(7)} ${"n".padStart(5)} ${"best".padStart(10)} ${"p90".padStart(10)} ${"median".padStart(10)}   ${"best lamports".padStart(14)}  ${"beat fee".padStart(9)}  ${"beat fee+tip".padStart(12)}`);
    for (const s of SIZES) {
      const n = nets.get(s)!, p = profits.get(s)!;
      if (!n.length) { console.log(`${String(s).padStart(7)} ${String(0).padStart(5)}   no data`); continue; }
      const bestLamports = Math.max(...p);
      console.log(`${String(s).padStart(7)} ${String(n.length).padStart(5)} ${pct(Math.max(...n)).padStart(10)} ${pct(quantile(n, 0.9)).padStart(10)} ${pct(quantile(n, 0.5)).padStart(10)}   ${String(bestLamports).padStart(14)}  ${String(p.filter((x) => x > 0).length).padStart(9)}  ${String(p.filter((x) => x > JITO_MIN_TIP).length).padStart(12)}`);
    }
    // The hypothesis stands or falls on this line: do gaps widen as size shrinks?
    const medians = SIZES.map((s) => ({ s, m: quantile(nets.get(s)!, 0.5) })).filter((x) => Number.isFinite(x.m));
    if (medians.length >= 2) {
      const small = medians[0], large = medians[medians.length - 1];
      console.log(`\nmedian at ${small.s} SOL is ${pct(small.m)}, at ${large.s} SOL it is ${pct(large.m)}: ` +
        (small.m > large.m ? "gaps ARE wider on small trades." : "small trades are no better; the fixed fee then dominates."));
    }
    writeLine({ t: "summary", sweep, perSize: SIZES.map((s) => ({ sizeSol: s, n: nets.get(s)!.length, bestPct: +Math.max(...nets.get(s)!, -99).toFixed(5), medianPct: +quantile(nets.get(s)!, 0.5).toFixed(5), bestLamports: Math.max(...profits.get(s)!, -99999), beatFee: profits.get(s)!.filter((x) => x > 0).length })) });
    if (RUN_MINUTES > 0 && (Date.now() - startedAt) / 60_000 >= RUN_MINUTES) break;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
