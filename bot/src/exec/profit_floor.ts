import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { simulateWelded } from "./simulate";

// Usage: SIM_PAYER=<address> npm run exec:floor          (about 10 Helius credits)
// The free-bet test. Jupiter's quote carries otherAmountThreshold: the least the swap will accept. If we raise it
// above the stake before asking for instructions, the trade can only end two ways: it pays a profit, or it refuses
// and the whole transaction reverts for the base fee (~5,000 lamports, a twentieth of a cent).
//
// That only works if Jupiter actually encodes OUR number. Step 1 proves it does, by building the same trade twice
// with different floors and comparing the raw instruction bytes. If the bytes are identical, the idea is dead.
const TOKEN = process.env.TOKEN ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 0.5);
const COST_LAMPORTS = Number(process.env.COST_LAMPORTS ?? 105_000); // signature plus a minimal tip
const sol = (l: number | null) => (l === null ? "n/a" : (l / 1e9).toFixed(6));

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing"); process.exit(1); }
  if (!process.env.SIM_PAYER) { console.error("SIM_PAYER missing (run `npm run exec:payer`)"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const payer = new PublicKey(process.env.SIM_PAYER);
  const size = Math.round(SIZE_SOL * 1e9);
  const opts = { connection: conn, keepWsolAccount: true };

  console.log(`token ${TOKEN.slice(0, 6)}...  size ${SIZE_SOL} SOL (${size} lamports)\n`);

  // Jupiter honours minOutLamports on some routes and silently ignores it on others, so it cannot be trusted alone.
  // OUR check is a plain token transfer of the demanded amount at the end of the trade: the token program enforces it
  // and one failed instruction reverts everything. These runs prove that it bites at demands nothing could pay.
  console.log("1. our own profit check, tested at demands the market cannot possibly meet:");
  for (const pct of [20, 5, 1]) {
    const floor = size + Math.round(size * pct / 100);
    try {
      const w = await buildWeldedTrade(TOKEN, size, payer, { ...opts, requireLamportsOut: floor });
      const sim = await simulateWelded(conn, w, payer);
      console.log(`   demand stake +${String(pct).padStart(2)}% (${sol(floor)} SOL back) -> ${sim.ok ? "WON, which should be impossible: the check is not biting" : "reverted, as it must"}`);
    } catch (e) { console.log(`   demand stake +${pct}% -> could not build: ${(e as Error).message.slice(0, 90)}`); }
  }

  console.log("\n2. the real bet: demand the stake plus what it costs to land.");
  const floor = size + COST_LAMPORTS;
  const bet = await buildWeldedTrade(TOKEN, size, payer, { ...opts, requireLamportsOut: floor });
  console.log(`   staked ${sol(size)} SOL, demanding ${sol(floor)} back (quote says ${bet.netPct >= 0 ? "+" : ""}${bet.netPct.toFixed(4)}%), ${bet.sizeBytes} bytes`);
  const s2 = await simulateWelded(conn, bet, payer);
  if (s2.ok) console.log(`   WON: the chain paid the floor. Account change ${sol(s2.wsolDelta)} SOL, ${s2.unitsConsumed} compute units`);
  else console.log(`   reverted: the chain would not pay the floor. Cost if sent: about 0.000005 SOL.`);

  console.log("\n3. a demand of zero profit (stake back exactly) should usually succeed, proving the trade itself works:");
  const even = await buildWeldedTrade(TOKEN, size, payer, { ...opts, requireLamportsOut: size });
  const s3 = await simulateWelded(conn, even, payer);
  console.log(`   demand ${sol(size)} back -> ${s3.ok ? "returned at least the stake" : "did not even return the stake (the round trip loses)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
