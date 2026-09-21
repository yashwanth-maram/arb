import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { associatedTokenAddress, simulateWelded } from "./simulate";

// Usage: SIM_PAYER=<clean address> TOKEN=<mint> SIZE_SOL=2 npm run exec:ladder      (about 2 credits per step)
// A win said the trade paid stake+floor. How much MORE would it pay? Demand progressively more until it refuses.
// The point is not the size of the win: it is whether the demand has a CEILING at all. A real arbitrage stops at
// the size of the gap. A demand that never stops is being funded by something outside the trade, which is a bug.
//
// Three control runs make that distinction for us:
//   control A: the smallest possible demand on a near-empty route. It must refuse.
//   control B: a deliberately terrible route (a token that round-trips at a big loss). It must refuse early.
//   main run:  the real trade, laddered until it refuses.
const TOKEN = process.env.TOKEN ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 2);
const STEPS = Number(process.env.STEPS ?? 14);
const PEPE = "PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m"; // measured at about -2% a round trip: a known loser
const sol = (l: number) => (l / 1e9).toFixed(6);

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP || !process.env.SIM_PAYER) { console.error("need HELIUS_API_KEY in bot/.env and SIM_PAYER"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const payer = new PublicKey(process.env.SIM_PAYER);
  const lamports = Math.round(SIZE_SOL * 1e9);
  const opts = { connection: conn, keepWsolAccount: true };

  // Is the payer's wrapped-SOL account really empty? If it is not, its balance pays the demand and every run "wins".
  const ata = associatedTokenAddress(new PublicKey("So11111111111111111111111111111111111111112"), payer);
  const pre = await conn.getAccountInfo(ata, "processed");
  console.log(`payer ${payer.toBase58()}`);
  console.log(`its wrapped-SOL account ${ata.toBase58()}: ${pre === null ? "does not exist (good: the trade creates it empty)" : `EXISTS and holds ${sol(Number(Buffer.from(pre.data).readBigUInt64LE(64)))} SOL -> this invalidates the check`}\n`);

  const ladder = async (label: string, mint: string, sizeLamports: number) => {
    console.log(`${label}: staking ${sol(sizeLamports)} SOL`);
    let demand = 5_000, lastWin = 0, steps = 0;
    for (; steps < STEPS; steps++) {
      try {
        const w = await buildWeldedTrade(mint, sizeLamports, payer, { ...opts, requireLamportsOut: sizeLamports + demand });
        const s = await simulateWelded(conn, w, payer);
        console.log(`   demand stake +${sol(demand).padStart(10)} SOL -> ${s.ok ? "paid" : "refused"}${s.ok ? "" : `  (${(s.err ?? "").slice(0, 60)})`}`);
        if (!s.ok) break;
        lastWin = demand;
        demand *= 2;
      } catch (e) { console.log(`   demand stake +${sol(demand)} SOL -> could not build: ${(e as Error).message.slice(0, 70)}`); break; }
    }
    const ceiling = steps < STEPS ? `ceiling found: the trade paid at most +${sol(lastWin)} SOL` : `NO CEILING after ${STEPS} steps (+${sol(lastWin)} SOL and still paying) -> something outside the trade is funding this`;
    console.log(`   ${ceiling}\n`);
    return lastWin;
  };

  console.log("control A: the smallest possible demand on a near-empty route. It must refuse.");
  try {
    const w = await buildWeldedTrade(TOKEN, lamports, payer, { ...opts, requireLamportsOut: lamports + 5_000, maxAccounts: 8 });
    const s = await simulateWelded(conn, w, payer);
    console.log(`   smallest possible demand (+0.000005 SOL) -> ${s.ok ? "paid" : "refused"}\n`);
  } catch (e) { console.log(`   could not build: ${(e as Error).message.slice(0, 80)}\n`); }

  await ladder("control B, a known loser (PEPE, about -2% a round trip)", PEPE, lamports);
  await ladder(`main run (${TOKEN.slice(0, 6)}...)`, TOKEN, lamports);
}

main().catch((e) => { console.error(e); process.exit(1); });
