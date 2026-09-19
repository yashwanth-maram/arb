import { Connection, PublicKey } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT = join(__dirname, "..", "test", "fixtures");

// PERPSPAD pair, from the Step 2 record in the reference doc.
const ACCOUNTS: Record<string, string> = {
  dlmm_pool:      "EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr",
  dlmm_reserve_x: "Gj7XhZqxg5CVbdpsMfKHjCVihbBLVoLcv7VUrShLHQ7v",
  dlmm_reserve_y: "3DbxfpKznPLs2AP6BRuLHofGXz1UuRQN1Vo2fpYBz4JH",
  damm_pool:      "84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ",
  damm_vault_x:   "5H7CRcneLziuJkxKkmjW8PVhJd3pHR4U7eujNd7LbQtP",
  damm_vault_y:   "HsMgCJjkmR6SZFe8sCr4ZU2WcRBsDvg6HRmyQYj22nk4",
  mint_perpspad:  "PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL",
  mint_wsol:      "So11111111111111111111111111111111111111112",
};

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const labels = Object.keys(ACCOUNTS);
  const keys = labels.map((l) => new PublicKey(ACCOUNTS[l]));
  // One request, one slot: every fixture is a consistent snapshot.
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys);
  mkdirSync(OUT, { recursive: true });
  const fetchedAt = new Date().toISOString();
  labels.forEach((label, i) => {
    const info = value[i];
    if (!info) throw new Error(`${label} (${ACCOUNTS[label]}) not found`);
    const fixture = {
      label,
      address: ACCOUNTS[label],
      owner: info.owner.toBase58(),
      lamports: info.lamports,
      slot: context.slot,
      fetchedAt,
      dataBase64: Buffer.from(info.data).toString("base64"),
    };
    writeFileSync(join(OUT, `${label}.json`), JSON.stringify(fixture, null, 2) + "\n");
    console.log(`${label.padEnd(15)} owner=${fixture.owner.slice(0, 8)}…  ${info.data.length} bytes  slot ${context.slot}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });