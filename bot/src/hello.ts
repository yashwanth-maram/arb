import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DLMM_POOL = new PublicKey("EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr");
const DAMM_POOL = new PublicKey("84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ");

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const slot = await conn.getSlot();
  console.log("rpc:", RPC, "slot:", slot);
  for (const [name, pk] of [["DLMM pool", DLMM_POOL], ["DAMM v2 pool", DAMM_POOL]] as const) {
    const info = await conn.getAccountInfo(pk);
    if (!info) throw new Error(`${name} not found`);
    console.log(`${name}: owner=${info.owner.toBase58()} bytes=${info.data.length}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });