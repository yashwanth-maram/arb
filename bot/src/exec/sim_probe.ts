import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TX_SIZE_LIMIT, buildWeldedTrade } from "./weld";
import { simulateWelded } from "./simulate";

// Usage: npm run exec:sim                         (about 3 Helius credits per token)
//        SIM_PAYER=<address> SIZE_SOL=0.5 TOKEN=<mint> npm run exec:sim
// Step B4. Builds the welded trade and runs it against live chain state without sending it.
// The payer is a funded PUBLIC address standing in for a wallet we do not have; nothing is signed or sent.
const TOKENS: [string, string][] = process.env.TOKEN ? [["custom", process.env.TOKEN]] : [
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  ["PEPE", "PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m"],
];
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 0.5);
const sol = (lamports: number | null) => (lamports === null ? "n/a" : (lamports / 1e9).toFixed(6));

/** A funded public address to stand in as payer: given by SIM_PAYER, else the chain's largest plain SOL accounts. */
async function findPayer(conn: Connection): Promise<{ payer: PublicKey; how: string }> {
  if (process.env.SIM_PAYER) return { payer: new PublicKey(process.env.SIM_PAYER), how: "SIM_PAYER" };
  const largest = await conn.getLargestAccounts({ filter: "circulating" });
  for (const a of largest.value) {
    const info = await conn.getAccountInfo(a.address, "processed");
    // A plain wallet: owned by the system program and carrying no data. Program and stake accounts cannot pay.
    if (info && info.owner.toBase58() === "11111111111111111111111111111111" && info.data.length === 0 && info.lamports > 5e9)
      return { payer: a.address, how: `largest circulating account holding ${(info.lamports / 1e9).toFixed(0)} SOL` };
  }
  throw new Error("no funded plain wallet found; pass one with SIM_PAYER=<address>");
}

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");

  let payer: PublicKey, how: string;
  try { ({ payer, how } = await findPayer(conn)); }
  catch (e) {
    payer = Keypair.generate().publicKey; how = `NO FUNDED PAYER (${(e as Error).message})`;
  }
  console.log(`payer: ${payer.toBase58()}  (${how})`);
  console.log(`simulating ${SIZE_SOL} SOL welded round trips; nothing is signed or sent\n`);

  for (const [name, mint] of TOKENS) {
    try {
      // keepWsolAccount: without it the clean-up closes the very account we measure, and the result is unreadable.
      const w = await buildWeldedTrade(mint, Math.round(SIZE_SOL * 1e9), payer, { connection: conn, keepWsolAccount: true });
      console.log(`${name}  buy ${w.buyVia.join("+")} -> sell ${w.sellVia.join("+")}`);
      console.log(`   built at ${w.maxAccountsUsed} accounts a leg [${w.attempts.join(" ")}], ${w.sizeBytes}/${TX_SIZE_LIMIT} bytes, quoted ${w.netPct >= 0 ? "+" : ""}${w.netPct.toFixed(4)}%`);
      const s = await simulateWelded(conn, w, payer);
      if (process.env.VERBOSE) console.log(`   measuring account ${s.wsolAccount}`);
      if (s.ok) {
        const measured = s.wsolDelta === null ? "the account was closed by the clean-up, so no closing balance was returned"
          : `wrapped SOL ${sol(s.wsolBefore)} -> ${sol(s.wsolAfter)}, change ${s.wsolDelta >= 0 ? "+" : ""}${sol(s.wsolDelta)} SOL (${s.netPctSimulated!.toFixed(4)}% of size)`;
        console.log(`   SIMULATED OK at slot ${s.slot}: ${measured}, ${s.unitsConsumed} compute units`);
      } else if (s.slippageRejected) {
        console.log(`   CANCELLED by the profit check at slot ${s.slot} (a swap would have paid less than its quote). This is the safety working.`);
      } else if (s.underfunded) {
        console.log(`   payer does not hold ${SIZE_SOL} SOL, so the swaps were never reached: ${s.err}`);
      } else {
        console.log(`   FAILED at slot ${s.slot}: ${s.err}`);
        s.logTail.forEach((l) => console.log(`      ${l.slice(0, 150)}`));
      }
      console.log();
    } catch (e) {
      console.log(`${name}  could not be built: ${(e as Error).message}\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
