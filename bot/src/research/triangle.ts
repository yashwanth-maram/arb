import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";

// Usage: npm run triangle            (free: Jupiter's public endpoint, no key, no Helius credits)
//        TOKENS=10 SIZE_SOL=0.5 npm run triangle
//
// Every test so far was SOL -> token -> SOL. A TRIANGLE is SOL -> A -> B -> SOL, and it is a different search space:
// it trades A against B directly, a pair most bots never watch because they watch SOL pairs. A cycle that returns
// more SOL than it started with is an arbitrage, whatever the individual prices look like.
//
// Quoting every cycle outright would take hours (N tokens give N*(N-1) cycles, three quotes each). So this runs in
// two stages. The SCREEN quotes each leg once and estimates every cycle by scaling, which is approximate because
// depth is not linear. The VERIFY stage then re-quotes the best few exactly, in sequence, so nothing is believed
// on the strength of an approximation.
const BASE = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const REQ_PER_MIN = Number(process.env.REQ_PER_MIN ?? 25);
const N = Number(process.env.TOKENS ?? 10);
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 0.5);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const VERIFY = Number(process.env.VERIFY ?? 6);            // how many of the best cycles to re-quote exactly
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const TOKENS_FILE = join(LOG_DIR, "jup", "tokens.json");
const COST_LAMPORTS = Number(process.env.COST_LAMPORTS ?? 5_000); // a three-swap cycle still needs one signature

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}%`;
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `triangle-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
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
/** One swap quote. Returns the output amount, or null when no route exists. */
async function out(inputMint: string, outputMint: string, amount: string): Promise<number | null> {
  const { status, body } = await getJson(`${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
  if (status !== 200 || !body?.outAmount) return null;
  return Number(body.outAmount);
}

type Token = { symbol: string; mint: string; decimals: number };

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const tokens: Token[] = JSON.parse(readFileSync(TOKENS_FILE, "utf8")).slice(0, N);
  const lamports = Math.round(SIZE_SOL * 1e9);
  const screenQuotes = 2 * tokens.length + tokens.length * (tokens.length - 1);
  console.log(`${tokens.length} tokens, ${SIZE_SOL} SOL a cycle: ${tokens.length * (tokens.length - 1)} triangles`);
  console.log(`screen needs ${screenQuotes} quotes, about ${(screenQuotes / REQ_PER_MIN).toFixed(1)} min\n`);
  console.log(writeLine({ t: "start", tokens: tokens.length, sizeSol: SIZE_SOL, triangles: tokens.length * (tokens.length - 1) }));

  // Stage 1a: what SIZE_SOL buys of each token, and what that buys back. The round trip we already know, kept as a baseline.
  const buy = new Map<string, number>(), back = new Map<string, number>();
  for (const t of tokens) {
    await reserve(2);
    const b = await out(WSOL, t.mint, String(lamports));
    if (b === null) { console.log(`   ${t.symbol}: no route from SOL`); continue; }
    buy.set(t.mint, b);
    const r = await out(t.mint, WSOL, String(b));
    if (r !== null) back.set(t.mint, r);
  }
  console.log(`priced ${buy.size} tokens; round trips known for ${back.size}\n`);

  // Stage 1b: the cross matrix. A -> B using exactly what SIZE_SOL bought of A.
  const cross = new Map<string, number>();
  for (const a of tokens) {
    if (!buy.has(a.mint)) continue;
    for (const b of tokens) {
      if (a.mint === b.mint || !buy.has(b.mint)) continue;
      await reserve(1);
      const got = await out(a.mint, b.mint, String(buy.get(a.mint)!));
      if (got !== null) cross.set(`${a.mint}|${b.mint}`, got);
    }
    process.stdout.write(`   crossed ${a.symbol} -> ${cross.size} pairs so far\r`);
  }
  console.log(`\n${cross.size} of ${tokens.length * (tokens.length - 1)} pairs have a route\n`);

  // Estimate each cycle: B's sell price is known for the amount SIZE_SOL bought of B, so scale it to the amount the
  // cross leg actually delivers. Depth is not linear, so this is a screen, not a result.
  type Cand = { a: Token; b: Token; estPct: number; gotB: number };
  const cands: Cand[] = [];
  for (const a of tokens) for (const b of tokens) {
    if (a.mint === b.mint) continue;
    const gotB = cross.get(`${a.mint}|${b.mint}`);
    const refB = buy.get(b.mint), sellB = back.get(b.mint);
    if (gotB === undefined || refB === undefined || sellB === undefined) continue;
    const estimated = sellB * (gotB / refB);
    cands.push({ a, b, estPct: (estimated / lamports - 1) * 100, gotB });
  }
  cands.sort((x, y) => y.estPct - x.estPct);
  console.log(`best cycles by estimate (approximate, verified below):`);
  for (const c of cands.slice(0, Math.max(VERIFY, 8)))
    console.log(`   SOL -> ${c.a.symbol} -> ${c.b.symbol} -> SOL   estimate ${pct(c.estPct)}`);

  // Stage 2: re-quote the best cycles exactly, leg by leg. Only these numbers are real.
  console.log(`\nverifying the top ${VERIFY} exactly (three fresh quotes each):`);
  let bestReal = { pct: -Infinity, label: "" };
  for (const c of cands.slice(0, VERIFY)) {
    await reserve(3);
    const legA = await out(WSOL, c.a.mint, String(lamports));
    if (legA === null) { console.log(`   SOL -> ${c.a.symbol} -> ${c.b.symbol}: leg 1 has no route`); continue; }
    const legB = await out(c.a.mint, c.b.mint, String(legA));
    if (legB === null) { console.log(`   SOL -> ${c.a.symbol} -> ${c.b.symbol}: leg 2 has no route`); continue; }
    const legC = await out(c.b.mint, WSOL, String(legB));
    if (legC === null) { console.log(`   SOL -> ${c.a.symbol} -> ${c.b.symbol}: leg 3 has no route`); continue; }
    const realPct = (legC / lamports - 1) * 100;
    const profitSol = (legC - lamports - COST_LAMPORTS) / 1e9;
    const label = `SOL -> ${c.a.symbol} -> ${c.b.symbol} -> SOL`;
    if (realPct > bestReal.pct) bestReal = { pct: realPct, label };
    console.log(`   ${label.padEnd(34)} estimate ${pct(c.estPct).padStart(11)}   REAL ${pct(realPct).padStart(11)}   after costs ${profitSol >= 0 ? "+" : ""}${profitSol.toFixed(6)} SOL`);
    writeLine({ t: "cycle", a: c.a.symbol, b: c.b.symbol, estPct: +c.estPct.toFixed(4), realPct: +realPct.toFixed(4), profitAfterCostsSol: +profitSol.toFixed(9), sizeSol: SIZE_SOL });
  }
  const bestRound = [...back].map(([m, r]) => (r / lamports - 1) * 100).sort((a, b) => b - a)[0] ?? NaN;
  console.log(`\nbest verified triangle: ${pct(bestReal.pct)}  (${bestReal.label})`);
  console.log(`best plain round trip in the same run: ${pct(bestRound)}`);
  console.log(bestReal.pct > bestRound ? "triangles beat round trips here: worth more sampling." : "triangles did no better than round trips.");
}

main().catch((e) => { console.error(e); process.exit(1); });
