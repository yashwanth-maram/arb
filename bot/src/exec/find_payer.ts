import { Connection, PublicKey } from "@solana/web3.js";

// Usage: npm run exec:payer        (about 5 Helius credits)
// A simulation executes for real, so the payer must EXIST on chain and hold the SOL being swapped. We have no wallet,
// so a funded public address stands in. Nothing is ever signed or sent, so that address cannot be affected in any way.
// This lists candidates and reports which are plain, funded wallets. getLargestAccounts is not on the free plan.
const SYSTEM = "11111111111111111111111111111111";
const CANDIDATES: [string, string][] = [
  ["Solana Foundation-era address", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
  ["large public holder", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"],
  ["Meteora PEPE damm2 pool", "ED6PwhyCQ52CQa9V58yy9BTVi9NdVCSVAWWiL1ZzAXhX"],
  ["Meteora PEPE dlmm20 pool", "HDojZeCdUee8nczxsc9MeiMKVF961HqEFeKEvHw74xVR"],
];

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
  const conn = new Connection(HTTP, "processed");
  const extra = (process.env.CANDIDATES ?? "").split(",").filter(Boolean).map((a, i) => [`extra ${i + 1}`, a] as [string, string]);

  console.log(`${"candidate".padEnd(32)} ${"SOL".padStart(12)}  ${"owner".padEnd(12)} bytes  usable as payer?`);
  for (const [name, address] of [...CANDIDATES, ...extra]) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(address), "processed");
      if (!info) { console.log(`${name.padEnd(32)} ${"-".padStart(12)}  ${"-".padEnd(12)} -      no: this account does not exist`); continue; }
      const owner = info.owner.toBase58();
      const plain = owner === SYSTEM && info.data.length === 0;
      // A payer must be a plain system-owned wallet with no data: a program or pool account cannot pay for a transaction.
      const usable = plain && info.lamports > 2e9;
      console.log(`${name.padEnd(32)} ${(info.lamports / 1e9).toFixed(3).padStart(12)}  ${owner.slice(0, 10).padEnd(12)} ${String(info.data.length).padEnd(6)} ${usable ? "YES" : plain ? "no: too little SOL" : "no: not a plain wallet"}`);
      if (usable) console.log(`${" ".repeat(32)} ${address}`);
    } catch (e) {
      console.log(`${name.padEnd(32)} ${"-".padStart(12)}  ${"-".padEnd(12)} -      no: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log(`\nTake any address marked YES and run:  SIM_PAYER=<address> npm run exec:sim`);
}

main().catch((e) => { console.error(e); process.exit(1); });
