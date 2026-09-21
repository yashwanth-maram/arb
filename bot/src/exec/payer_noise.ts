import { Connection, PublicKey } from "@solana/web3.js";
import { associatedTokenAddress } from "./simulate";
import { WSOL } from "../config/watchlist";

// Usage: npm run exec:noise                (about 25 Helius credits, takes ~2 minutes)
// The instrument check. Shadow results are measured as the change in the payer's wrapped-SOL account across a
// simulation. If that account moves on its own between the read and the run, its traffic is indistinguishable from
// profit. This watches the account doing nothing at all: any movement here is noise in every shadow measurement.
// It also reports whether the account exists, because a payer with NO wrapped-SOL account is immune: the
// transaction creates it, so nothing outside the trade can ever touch it.
const CANDIDATES: [string, string][] = [
  ["current shadow payer", process.env.SIM_PAYER ?? "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"],
  ["alternative", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
];
const SAMPLES = Number(process.env.SAMPLES ?? 20);
const GAP_MS = Number(process.env.GAP_MS ?? 6000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const amount = (data: Buffer) => (data.length >= 72 ? Number(data.readBigUInt64LE(64)) : null);

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");

  console.log("does each candidate already hold a wrapped-SOL account?\n");
  const watch: { name: string; payer: PublicKey; ata: PublicKey }[] = [];
  for (const [name, address] of CANDIDATES) {
    const payer = new PublicKey(address);
    const ata = associatedTokenAddress(new PublicKey(WSOL), payer);
    const info = await conn.getAccountInfo(ata, "processed");
    const bal = info ? amount(Buffer.from(info.data)) : null;
    console.log(`${name.padEnd(22)} ${address}`);
    console.log(`   wrapped-SOL account ${ata.toBase58()}: ${info === null ? "DOES NOT EXIST -> immune to outside traffic, ideal payer" : `holds ${(bal! / 1e9).toFixed(6)} SOL -> its own traffic can pollute every measurement`}`);
    if (info) watch.push({ name, payer, ata });
  }
  if (watch.length === 0) { console.log("\nno existing accounts to watch: nothing can pollute a measurement."); return; }

  console.log(`\nwatching ${watch.length} existing account(s) doing nothing, ${SAMPLES} reads ${GAP_MS / 1000}s apart.`);
  console.log("Any movement below is indistinguishable from profit in a shadow run.\n");
  const series = new Map<string, number[]>(watch.map((w) => [w.name, []]));
  for (let i = 0; i < SAMPLES; i++) {
    for (const w of watch) {
      const info = await conn.getAccountInfo(w.ata, "processed");
      const bal = info ? amount(Buffer.from(info.data)) : null;
      if (bal !== null) series.get(w.name)!.push(bal);
    }
    if (i < SAMPLES - 1) await sleep(GAP_MS);
  }
  for (const [name, vals] of series) {
    if (vals.length < 2) { console.log(`${name}: too few reads`); continue; }
    const steps = vals.slice(1).map((v, i) => v - vals[i]);
    const moved = steps.filter((s) => s !== 0);
    const biggest = steps.reduce((m, s) => (Math.abs(s) > Math.abs(m) ? s : m), 0);
    const drift = vals[vals.length - 1] - vals[0];
    console.log(`${name}:`);
    console.log(`   balance ${(Math.min(...vals) / 1e9).toFixed(6)} to ${(Math.max(...vals) / 1e9).toFixed(6)} SOL over ${((SAMPLES - 1) * GAP_MS / 1000).toFixed(0)}s`);
    console.log(`   changed between reads ${moved.length} of ${steps.length} times; biggest single change ${(biggest / 1e9).toFixed(6)} SOL; total drift ${(drift / 1e9).toFixed(6)} SOL`);
    console.log(`   >>> the best "profit" a shadow run reported was +0.000429 SOL. Compare it with the numbers above.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
