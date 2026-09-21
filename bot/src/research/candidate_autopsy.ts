import { Connection, PublicKey } from "@solana/web3.js";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";
import { requestJson } from "../exec/http";
import { buildWeldedTrade } from "../exec/weld";
import { simulateWelded } from "../exec/simulate";

// Usage: SIM_PAYER=<clean address> TOKENS=STONK,JEANPHIL npm run autopsy
//        REPEATS=15 SIZES=0.005,0.02,0.042,0.1 npm run autopsy
//
// The size sweep found candidates, not profits: two sequential Jupiter quotes are a DISCREPANCY, never an executed
// trade. This settles each candidate in two stages.
//   1. REPEAT the round trip many times. A real structural gap returns the same number every time; a quote artefact
//      flickers between positive and negative.
//   2. ENFORCE any positive on chain. The welded transaction demands stake + floor back through our own token
//      transfer, which the token program refuses to fulfil unless the money is really there. Nothing is ever signed
//      or sent, and the controls in exec:floor proved the check bites.
// It also reports each mint's token program, because Token-2022 carries transfer fees our quoting does not model,
// and a candidate that is Token-2022 is suspect until that is accounted for.
const CLASSIC_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BASE = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const REQ_PER_MIN = Number(process.env.REQ_PER_MIN ?? 25);
const WANTED = (process.env.TOKENS ?? "STONK,JEANPHIL,MET,HYPE").split(",").map((s) => s.trim()).filter(Boolean);
const SIZES = (process.env.SIZES ?? "0.005,0.02,0.042,0.1").split(",").map(Number);
const REPEATS = Number(process.env.REPEATS ?? 10);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const BASE_FEE = Number(process.env.BASE_FEE_LAMPORTS ?? 5_000);
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const TOKENS_FILE = join(LOG_DIR, "jup", "tokens.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}%`;
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `autopsy-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  return line;
}
let nextSlot = 0;
async function reserve(n = 1) {
  const gap = 60_000 / REQ_PER_MIN;
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + gap * n;
  if (wait > 0) await sleep(wait);
}
type Quote = { outAmount: string; routePlan?: { swapInfo: { label: string } }[]; priceImpactPct?: string; contextSlot?: number };
async function quote(inputMint: string, outputMint: string, amount: string): Promise<Quote | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await requestJson("GET", `${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
    if (r.status === 200 && r.body?.outAmount) return r.body as Quote;
    if (r.status === 429) { await sleep(4000 * attempt); continue; }
    return null;
  }
  return null;
}
const venues = (q: Quote) => [...new Set((q.routePlan ?? []).map((s) => s.swapInfo.label))].join("+");
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const all: { symbol: string; mint: string }[] = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  const picked = WANTED.map((w) => all.find((t) => t.symbol.toUpperCase() === w.toUpperCase())).filter(Boolean) as { symbol: string; mint: string }[];
  if (!picked.length) { console.error(`none of ${WANTED.join(", ")} are in ${TOKENS_FILE}`); process.exit(1); }

  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  const conn = HTTP ? new Connection(HTTP, "processed") : null;
  const payer = process.env.SIM_PAYER ? new PublicKey(process.env.SIM_PAYER) : null;
  if (!conn || !payer) console.log("no RPC or SIM_PAYER: repeating quotes only, no enforced check\n");

  // Which token program owns each mint? Token-2022 charges transfer fees our quoting does not model.
  if (conn) {
    const infos = await conn.getMultipleAccountsInfo(picked.map((t) => new PublicKey(t.mint)), "processed");
    picked.forEach((t, i) => {
      const owner = infos[i]?.owner.toBase58();
      const kind = owner === CLASSIC_TOKEN ? "classic SPL" : owner === TOKEN_2022 ? "TOKEN-2022 (transfer fees not modelled: treat results as suspect)" : `unknown owner ${owner?.slice(0, 8)}`;
      console.log(`${t.symbol.padEnd(10)} ${t.mint}  ${kind}`);
      writeLine({ t: "mint", sym: t.symbol, mint: t.mint, owner, kind });
    });
    console.log();
  }

  for (const token of picked) {
    for (const sizeSol of SIZES) {
      const lamports = Math.round(sizeSol * 1e9);
      const nets: number[] = [];
      let positives = 0, routeA = "", routeB = "";
      console.log(`== ${token.symbol} at ${sizeSol} SOL, ${REPEATS} repeats`);
      for (let i = 0; i < REPEATS; i++) {
        await reserve(2);
        const buy = await quote(WSOL, token.mint, String(lamports));
        if (!buy) { console.log(`   ${String(i + 1).padStart(2)}: buy quote failed`); continue; }
        const sell = await quote(token.mint, WSOL, buy.outAmount);
        if (!sell) { console.log(`   ${String(i + 1).padStart(2)}: sell quote failed`); continue; }
        const back = Number(sell.outAmount);
        const netPct = (back / lamports - 1) * 100;
        nets.push(netPct);
        if (netPct > 0) positives++;
        routeA = venues(buy); routeB = venues(sell);
        writeLine({ t: "repeat", sym: token.symbol, sizeSol, i, netPct: +netPct.toFixed(5), profitLamports: back - lamports - BASE_FEE, buyVia: routeA, sellVia: routeB, impact: [buy.priceImpactPct, sell.priceImpactPct], slot: sell.contextSlot });
        console.log(`   ${String(i + 1).padStart(2)}: ${pct(netPct).padStart(10)}   buy ${routeA} -> sell ${routeB}`);
      }
      if (!nets.length) { console.log(`   no usable quotes\n`); continue; }
      const spread = Math.max(...nets) - Math.min(...nets);
      const verdict = positives === nets.length ? "PERSISTENT: positive every time"
        : positives === 0 ? "never positive on a repeat"
        : `FLICKERS: positive ${positives} of ${nets.length} (spread ${spread.toFixed(3)} points) -> quote timing, not structure`;
      console.log(`   median ${pct(median(nets))}  best ${pct(Math.max(...nets))}  worst ${pct(Math.min(...nets))}   ${verdict}`);
      writeLine({ t: "summary", sym: token.symbol, sizeSol, n: nets.length, positives, medianPct: +median(nets).toFixed(5), bestPct: +Math.max(...nets).toFixed(5), worstPct: +Math.min(...nets).toFixed(5), spreadPoints: +spread.toFixed(5) });

      // Only the chain settles it. Demand stake + the base fee back through our own transfer instruction.
      if (positives > 0 && conn && payer) {
        try {
          const w = await buildWeldedTrade(token.mint, lamports, payer, { connection: conn, keepWsolAccount: true, slippageBps: SLIPPAGE_BPS, requireLamportsOut: lamports + BASE_FEE });
          const s = await simulateWelded(conn, w, payer);
          console.log(`   ENFORCED: ${s.ok ? `PAID stake + ${BASE_FEE} lamports` : "refused: the chain would not pay it"}   (${w.sizeBytes} bytes, ${s.unitsConsumed} CU, quote said ${pct(w.netPct)})`);
          writeLine({ t: "enforced", sym: token.symbol, sizeSol, paid: s.ok, quotedPct: +w.netPct.toFixed(5), floorLamports: lamports + BASE_FEE, computeUnits: s.unitsConsumed, err: s.err });
        } catch (e) {
          console.log(`   ENFORCED: could not build (${(e as Error).message.slice(0, 80)})`);
        }
      }
      console.log();
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
