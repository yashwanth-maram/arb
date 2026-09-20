import { Keypair } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSOL } from "../config/watchlist";
import { requestJson } from "./http";

// Usage: npm run exec:probe        (free: Jupiter only, no Helius credits, no wallet)
// Step B1. Jupiter can hand back the raw INSTRUCTIONS of a swap instead of a finished transaction. Those are the
// building blocks we need to put two swaps into ONE transaction. This asks for one set and shows what comes back.
// The "user" is a throwaway public key made in memory: it is never saved, never funded and never signs anything.
const BASE = process.env.JUP_BASE ?? "https://lite-api.jup.ag";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS ?? 20); // keep each leg small: two legs must share one 1,232-byte transaction

type Ix = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

async function main() {
  const q = await requestJson("GET", `${BASE}/swap/v1/quote?inputMint=${WSOL}&outputMint=${USDC}&amount=100000000&slippageBps=50&restrictIntermediateTokens=true&maxAccounts=${MAX_ACCOUNTS}`);
  if (q.status !== 200 || !q.body?.outAmount) { console.log(`quote failed: HTTP ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`); process.exit(1); }
  console.log(`quote: 0.1 SOL -> ${Number(q.body.outAmount) / 1e6} USDC via ${(q.body.routePlan ?? []).map((s: any) => s.swapInfo.label).join(" + ")}`);

  const user = Keypair.generate().publicKey.toBase58();
  const r = await requestJson("POST", `${BASE}/swap/v1/swap-instructions`, { quoteResponse: q.body, userPublicKey: user, wrapAndUnwrapSol: true });
  console.log(`swap-instructions: HTTP ${r.status}`);
  if (r.status !== 200) { console.log(JSON.stringify(r.body).slice(0, 400)); process.exit(1); }

  const b = r.body;
  console.log(`fields: ${Object.keys(b).join(", ")}`);
  const groups: [string, Ix[]][] = [
    ["computeBudgetInstructions", b.computeBudgetInstructions ?? []],
    ["setupInstructions", b.setupInstructions ?? []],
    ["swapInstruction", b.swapInstruction ? [b.swapInstruction] : []],
    ["cleanupInstruction", b.cleanupInstruction ? [b.cleanupInstruction] : []],
    ["otherInstructions", b.otherInstructions ?? []],
  ];
  const unique = new Set<string>();
  let dataBytes = 0;
  for (const [name, list] of groups) {
    console.log(`\n${name}: ${list.length}`);
    for (const ix of list) {
      const bytes = Buffer.from(ix.data, "base64").length;
      dataBytes += bytes;
      ix.accounts.forEach((a) => unique.add(a.pubkey)); unique.add(ix.programId);
      console.log(`   program ${ix.programId.slice(0, 8)}...  accounts ${String(ix.accounts.length).padStart(2)}  signers ${ix.accounts.filter((a) => a.isSigner).length}  writable ${ix.accounts.filter((a) => a.isWritable).length}  data ${bytes} bytes`);
    }
  }
  console.log(`\naddress lookup tables: ${(b.addressLookupTableAddresses ?? []).length}`);
  console.log(`unique accounts in this one leg: ${unique.size}   instruction data: ${dataBytes} bytes`);
  console.log(`other values: computeUnitLimit ${b.computeUnitLimit}  prioritizationFeeLamports ${b.prioritizationFeeLamports}  simulationError ${JSON.stringify(b.simulationError ?? null)}`);

  const dir = join(process.env.LOG_DIR ?? "logs", "jup");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "swap_ix_sample.json"), JSON.stringify({ quote: q.body, instructions: b }, null, 1) + "\n");
  console.log(`\nsaved the full answer to ${join(dir, "swap_ix_sample.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
