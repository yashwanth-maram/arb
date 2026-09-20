import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { WATCHLIST } from "./config/watchlist";
import { PROBE_SIZES_SOL, probeToken } from "./feed/probe";

// Usage: npm run depthprobe              manual depth probes with timings, about 10 Helius credits, takes about a minute
//        TOKEN=PEPE npm run depthprobe   one token only
// Measures how long one probe read takes from this machine: on a warm connection at "processed" and at "confirmed",
// then on a cold connection (web3.js closes idle HTTP sockets after 19 s, so a probe that fires out of the blue is cold).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number | null) => (x === null ? "no fill" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`);

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const tokens = [...new Set(WATCHLIST.map((p) => p.token))].filter((t) => !process.env.TOKEN || t === process.env.TOKEN);

  let t0 = Date.now();
  const infos = await conn.getMultipleAccountsInfo(WATCHLIST.map((p) => new PublicKey(p.address)));
  const latest = new Map<string, Buffer>();
  WATCHLIST.forEach((p, i) => { if (infos[i]) latest.set(p.label, Buffer.from(infos[i]!.data)); });
  console.log(`read ${latest.size} pools in ${Date.now() - t0} ms (first request: includes opening the connection)`);

  const run = async (token: string, commitment: Commitment, label: string) => {
    try {
      const r = await probeToken(conn, token, latest, { commitment, timeoutMs: 30_000 });
      const nets = PROBE_SIZES_SOL.map((s) => `${s === 0.001 ? "dust" : s} ${pct(r.best[String(s)]?.net ?? null)}`).join("  ");
      console.log(`${token.padEnd(9)} ${commitment.padEnd(9)} ${label.padEnd(5)} ${String(r.ms).padStart(6)} ms  slot ${r.slot}  ${r.accounts} accounts  ${String(r.kb).padStart(3)} KB   ${nets}${r.unfilled ? `  (${r.unfilled} unfilled)` : ""}${r.note ? `  ${r.note}` : ""}`);
    } catch (e) {
      console.log(`${token.padEnd(9)} ${commitment.padEnd(9)} ${label.padEnd(5)}  FAILED: ${(e as Error).message}`);
    }
  };
  for (const token of tokens) for (const commitment of ["processed", "confirmed", "processed"] as Commitment[]) await run(token, commitment, "warm");
  for (const token of tokens) {
    console.log(`waiting 21 s so the connection goes cold ...`);
    await sleep(21_000);
    await run(token, "processed", "cold");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
