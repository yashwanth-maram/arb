import { Connection, PublicKey } from "@solana/web3.js";
import { associatedTokenAddress } from "./simulate";
import { WSOL } from "../config/watchlist";

// Usage: npm run exec:clean          (about 25 Helius credits)
// The free bet needs a payer that holds SOL but has NO wrapped-SOL account, for two reasons:
//  1. The account is then created inside the transaction, so nothing outside the trade can touch its balance.
//  2. Our own profit check works by moving stake+floor OUT of it at the end. If the account already held wrapped SOL,
//     that balance would pay for the transfer and the check would pass no matter what the trade did.
// Candidates come from recent blocks: every transaction names a fee payer, which is by definition a funded wallet.
const SYSTEM = "11111111111111111111111111111111";
const NEEDED_SOL = Number(process.env.NEEDED_SOL ?? 3);
const BLOCKS = Number(process.env.BLOCKS ?? 2);
const WANT = Number(process.env.WANT ?? 3);

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing"); process.exit(1); }
  const conn = new Connection(HTTP, "confirmed");

  const slot = await conn.getSlot("finalized");
  const seen = new Set<string>();
  for (let i = 0; i < BLOCKS; i++) {
    const block = await conn.getBlock(slot - i * 3, { maxSupportedTransactionVersion: 1, transactionDetails: "accounts", rewards: false });
    // The fee payer is the first account of a transaction, and it must be a funded, signing wallet.
    for (const tx of (block?.transactions ?? []) as unknown as { transaction: { accountKeys?: { pubkey: string | PublicKey; signer: boolean }[] } }[]) {
      const first = tx.transaction.accountKeys?.[0];
      if (first?.signer) seen.add(typeof first.pubkey === "string" ? first.pubkey : first.pubkey.toBase58());
    }
    if (seen.size > 400) break;
  }
  console.log(`${seen.size} fee payers seen in recent blocks; looking for ${WANT} holding >= ${NEEDED_SOL} SOL with no wrapped-SOL account\n`);

  const found: string[] = [];
  const candidates = [...seen];
  for (let i = 0; i < candidates.length && found.length < WANT; i += 100) {
    const batch = candidates.slice(i, i + 100).map((a) => new PublicKey(a));
    const infos = await conn.getMultipleAccountsInfo(batch, "processed");
    const plain = batch.filter((_, j) => {
      const info = infos[j];
      return info && info.owner.toBase58() === SYSTEM && info.data.length === 0 && info.lamports >= NEEDED_SOL * 1e9;
    });
    if (plain.length === 0) continue;
    const atas = plain.map((p) => associatedTokenAddress(new PublicKey(WSOL), p));
    const ataInfos = await conn.getMultipleAccountsInfo(atas, "processed");
    plain.forEach((p, j) => {
      if (ataInfos[j] === null && found.length < WANT) {
        found.push(p.toBase58());
        const lamports = infos[batch.findIndex((b) => b.equals(p))]!.lamports;
        console.log(`FOUND  ${p.toBase58()}   holds ${(lamports / 1e9).toFixed(3)} SOL, no wrapped-SOL account`);
      }
    });
  }
  if (found.length === 0) {
    console.log("none found. Every funded fee payer already holds a wrapped-SOL account.");
    console.log("Try again with a larger BLOCKS, or a smaller NEEDED_SOL.");
    return;
  }
  console.log(`\nUse one of these:  SIM_PAYER=${found[0]}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
