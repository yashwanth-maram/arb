import { Connection, PublicKey } from "@solana/web3.js";
import { buildWeldedTrade } from "./weld";
import { associatedTokenAddress, simulateWelded } from "./simulate";
import { WSOL } from "../config/watchlist";

// Usage: SIM_PAYER=<clean address> TOKEN=<mint> SIZE_SOL=2 npm run exec:dump      (about 3 Helius credits)
// Show exactly what the welded transaction contains and what the chain says when it runs. Used when a result looks
// impossible: the instruction list and the logs settle what actually happened, instead of a theory about it.
const TOKEN = process.env.TOKEN ?? "PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m";
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 2);
const DEMAND = Number(process.env.DEMAND ?? 5_000);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 0);
const NAMES: Record<string, string> = {
  "ComputeBudget111111111111111111111111111111": "ComputeBudget",
  "11111111111111111111111111111111": "System",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "AssociatedToken",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter",
};
const TOKEN_IX: Record<number, string> = { 3: "Transfer", 7: "MintTo", 9: "CloseAccount", 12: "TransferChecked", 17: "SyncNative" };

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP || !process.env.SIM_PAYER) { console.error("need HELIUS_API_KEY in bot/.env and SIM_PAYER"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const payer = new PublicKey(process.env.SIM_PAYER);
  const lamports = Math.round(SIZE_SOL * 1e9);
  const wsolAta = associatedTokenAddress(new PublicKey(WSOL), payer).toBase58();

  const w = await buildWeldedTrade(TOKEN, lamports, payer, {
    connection: conn, keepWsolAccount: true, requireLamportsOut: lamports + DEMAND, slippageBps: SLIPPAGE_BPS,
  });
  console.log(`token ${TOKEN.slice(0, 6)}...  stake ${(lamports / 1e9).toFixed(6)} SOL  demanding ${((lamports + DEMAND) / 1e9).toFixed(6)} back  slippage ${SLIPPAGE_BPS} bps`);
  console.log(`buy ${w.buyVia.join("+")} -> sell ${w.sellVia.join("+")}, ${w.sizeBytes} bytes, quoted ${w.netPct.toFixed(4)}%`);
  console.log(`the trade's wrapped-SOL account is ${wsolAta}\n`);

  console.log("instructions in the transaction:");
  w.instructions.forEach((ix, i) => {
    const prog = NAMES[ix.programId.toBase58()] ?? ix.programId.toBase58().slice(0, 8) + "...";
    let note = "";
    if (prog === "Token" && ix.data.length >= 1) {
      const kind = TOKEN_IX[ix.data[0]] ?? `op ${ix.data[0]}`;
      const amt = ix.data.length >= 9 ? Number(Buffer.from(ix.data).readBigUInt64LE(1)) : null;
      note = `  ${kind}${amt !== null ? ` ${(amt / 1e9).toFixed(6)} SOL-equiv` : ""}` +
        (kind === "Transfer" ? `  from ${ix.keys[0].pubkey.toBase58() === wsolAta ? "THE TRADE'S ACCOUNT" : ix.keys[0].pubkey.toBase58().slice(0, 8) + "..."}` : "");
    }
    if (prog === "System" && ix.data.length >= 12) note = `  transfer ${(Number(Buffer.from(ix.data).readBigUInt64LE(4)) / 1e9).toFixed(6)} SOL to ${ix.keys[1]?.pubkey.toBase58() === wsolAta ? "THE TRADE'S ACCOUNT" : "elsewhere"}`;
    console.log(`  ${String(i).padStart(2)}  ${prog.padEnd(16)} ${String(ix.keys.length).padStart(2)} accounts, ${String(ix.data.length).padStart(3)} bytes${note}`);
  });

  const s = await simulateWelded(conn, w, payer);
  console.log(`\nsimulated at slot ${s.slot}: ${s.ok ? "SUCCEEDED" : `FAILED ${s.err}`}, ${s.unitsConsumed} compute units`);
  console.log("chain logs:");
  (s.logTail ?? []).forEach((l) => console.log(`  ${l.slice(0, 160)}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
