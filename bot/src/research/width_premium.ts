import { Connection, PublicKey } from "@solana/web3.js";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TX_SIZE_LIMIT, buildWeldedTrade } from "../exec/weld";
import { simulateWelded } from "../exec/simulate";

// Usage: SIM_PAYER=<clean address> npm run width           (about 4 Helius credits a token-size)
//        TOKENS=12 SIZES=0.005,0.02,0.042 WIDE=64 npm run width
//
// The autopsy found the profitable round trips all split across three or more venues a leg, and that a welded
// transaction has to narrow the route to fit 1,232 bytes. So the edge and the ability to execute it are in direct
// conflict. This measures the size of that conflict, for free.
//
// For each token and size it builds the trade twice: once at the WIDE account limit Jupiter prefers, once at the
// NARROW limit that always fits. The difference is the WIDTH PREMIUM: what narrowing costs us. Then it reports
// whether the wide build fits anyway, which happens when Jupiter ships an address lookup table for the route, and
// runs the enforced check on any that do.
//
// The decision this informs: buying our own lookup table costs about 0.008 SOL of rent. It is only worth it if the
// width premium is reliably larger than the 5,000-lamport signature. Nothing here spends anything.
const NARROW = Number(process.env.NARROW ?? 14);
const WIDE = Number(process.env.WIDE ?? 64);
const SIZES = (process.env.SIZES ?? "0.005,0.02,0.042").split(",").map(Number);
const N = Number(process.env.TOKENS ?? 12);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const BASE_FEE = Number(process.env.BASE_FEE_LAMPORTS ?? 5_000);
const ALT_RENT_LAMPORTS = Number(process.env.ALT_RENT_LAMPORTS ?? 8_000_000); // roughly what our own table would cost
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const TOKENS_FILE = join(LOG_DIR, "jup", "tokens.json");

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}%`;
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(join(LOG_DIR, `width-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  return line;
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP || !process.env.SIM_PAYER) { console.error("need HELIUS_API_KEY in bot/.env and SIM_PAYER (npm run exec:clean)"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const payer = new PublicKey(process.env.SIM_PAYER);
  const tokens: { symbol: string; mint: string }[] = JSON.parse(readFileSync(TOKENS_FILE, "utf8")).slice(0, N);

  console.log(`${tokens.length} tokens, sizes ${SIZES.join(", ")} SOL: wide route (${WIDE} accounts a leg) against narrow (${NARROW})\n`);
  const premiums: number[] = [];
  let wideFits = 0, wideBuilt = 0, enforcedPaid = 0;

  for (const t of tokens) {
    for (const sizeSol of SIZES) {
      const lamports = Math.round(sizeSol * 1e9);
      const common = { connection: conn, keepWsolAccount: true, slippageBps: SLIPPAGE_BPS };
      let narrowPct: number | null = null, widePct: number | null = null;
      let fits = false, bytes = 0, tables = 0, lookedUp = 0, note = "";

      try {
        const n = await buildWeldedTrade(t.mint, lamports, payer, { ...common, maxAccounts: NARROW });
        narrowPct = n.netPct;
      } catch (e) { note = `narrow: ${(e as Error).message.slice(0, 50)}`; }

      try {
        const w = await buildWeldedTrade(t.mint, lamports, payer, { ...common, maxAccounts: WIDE, requireLamportsOut: lamports + BASE_FEE });
        wideBuilt++;
        widePct = w.netPct; fits = w.fits; bytes = w.sizeBytes; tables = w.lookupTables.length; lookedUp = w.lookedUpAccounts;
        if (fits) {
          wideFits++;
          const s = await simulateWelded(conn, w, payer);
          if (s.ok) { enforcedPaid++; note = `ENFORCED PAID stake + ${BASE_FEE}`; }
          else note = "enforced: refused";
        }
      } catch (e) {
        // "too big to encode" is the expected answer for a wide route with no lookup table: that IS the finding.
        note = (e as Error).message.startsWith("too big") ? "wide route does not fit (no lookup table)" : `wide: ${(e as Error).message.slice(0, 50)}`;
      }

      if (narrowPct !== null && widePct !== null) premiums.push(widePct - narrowPct);
      const prem = narrowPct !== null && widePct !== null ? pct(widePct - narrowPct) : "n/a";
      console.log(`${t.symbol.padEnd(10)} ${String(sizeSol).padStart(6)} SOL   narrow ${narrowPct === null ? "  failed" : pct(narrowPct).padStart(9)}   wide ${widePct === null ? "  failed" : pct(widePct).padStart(9)}   premium ${prem.padStart(9)}   ${bytes ? `${bytes}b ${tables} table(s) ${lookedUp} looked up` : ""}  ${note}`);
      writeLine({ t: "width", sym: t.symbol, mint: t.mint, sizeSol, narrowPct, widePct,
        premiumPct: narrowPct !== null && widePct !== null ? +(widePct - narrowPct).toFixed(5) : null,
        wideFits: fits, sizeBytes: bytes, lookupTables: tables, lookedUpAccounts: lookedUp, note });
    }
  }

  console.log(`\nwide routes built ${wideBuilt}, of which ${wideFits} fit in one transaction, of which ${enforcedPaid} passed the enforced check`);
  if (premiums.length) {
    const med = median(premiums), best = Math.max(...premiums);
    console.log(`width premium (what the wide route is worth over the narrow one): median ${pct(med)}  best ${pct(best)}  n=${premiums.length}`);
    // The only question a lookup table answers: is the premium worth more than the fee, often enough to repay the rent?
    for (const sizeSol of SIZES) {
      const gain = (med / 100) * sizeSol * 1e9;
      console.log(`   at ${sizeSol} SOL the median premium is worth ${gain.toFixed(0)} lamports against a ${BASE_FEE} lamport signature: ` +
        (gain > BASE_FEE ? `it clears, and our own table (about ${ALT_RENT_LAMPORTS} lamports) would repay after ${Math.ceil(ALT_RENT_LAMPORTS / (gain - BASE_FEE))} winning trades.` : "it does not clear the signature, so a lookup table cannot pay for itself."));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
