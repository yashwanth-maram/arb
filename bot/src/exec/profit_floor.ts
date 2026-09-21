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

  console.log("1. does Jupiter encode OUR floor into the instruction?");
  const plain = await buildWeldedTrade(TOKEN, size, payer, opts);
  const raised = await buildWeldedTrade(TOKEN, size, payer, { ...opts, minOutLamports: Math.round(size * 1.05) });
  console.log(`   quoted floor ${plain.minOutDemanded} lamports -> instruction data ${plain.sellSwapData.slice(0, 24)}...`);
  console.log(`   demanded     ${raised.minOutDemanded} lamports -> instruction data ${raised.sellSwapData.slice(0, 24)}...`);
  if (plain.sellSwapData === raised.sellSwapData) {
    console.log("   IDENTICAL: Jupiter ignored our floor. The free bet cannot be built this way.\n");
    return;
  }
  console.log("   DIFFERENT: our floor is in the instruction. The free bet can be built.\n");

  console.log("2. an impossible floor must revert (proving the safety bites):");
  const s1 = await simulateWelded(conn, raised, payer);
  console.log(`   demanded 5% profit -> ${s1.ok ? "EXECUTED, which should not happen" : s1.slippageRejected ? "reverted by the floor, as intended" : `failed: ${s1.err}`}`);

  console.log("\n3. the real bet: demand the stake plus what it costs to land.");
  const floor = size + COST_LAMPORTS;
  const bet = await buildWeldedTrade(TOKEN, size, payer, { ...opts, minOutLamports: floor });
  console.log(`   staked ${sol(size)} SOL, demanding ${sol(floor)} back (quote says ${bet.netPct >= 0 ? "+" : ""}${bet.netPct.toFixed(4)}%)`);
  const s2 = await simulateWelded(conn, bet, payer);
  if (s2.ok) console.log(`   WON: measured ${s2.wsolDelta! >= 0 ? "+" : ""}${sol(s2.wsolDelta)} SOL (${s2.netPctSimulated!.toFixed(4)}%), ${s2.unitsConsumed} compute units`);
  else if (s2.slippageRejected) console.log(`   reverted: the chain would not pay the floor. Cost if sent: about 0.000005 SOL.`);
  else console.log(`   failed for another reason: ${s2.err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
