import { Keypair } from "@solana/web3.js";
import { TX_SIZE_LIMIT, buildWeldedTrade } from "./weld";

// Usage: npm run exec:weld                 (free: Jupiter only, no Helius credits, no wallet)
//        TOKEN=<mint> SIZE_SOL=0.5 MAX_ACCOUNTS=20 npm run exec:weld
// Step B2. Builds the welded trade for a few tokens and reports whether it fits in one Solana transaction.
const TOKENS: [string, string][] = process.env.TOKEN ? [["custom", process.env.TOKEN]] : [
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  ["PEPE", "PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m"],
];
const SIZE_SOL = Number(process.env.SIZE_SOL ?? 0.5);
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS ?? 20);

async function main() {
  const user = Keypair.generate().publicKey; // throwaway: never saved, never funded, never signs
  console.log(`welding ${SIZE_SOL} SOL round trips, at most ${MAX_ACCOUNTS} accounts a leg, limit ${TX_SIZE_LIMIT} bytes\n`);
  for (const [name, mint] of TOKENS) {
    try {
      const w = await buildWeldedTrade(mint, Math.round(SIZE_SOL * 1e9), user, { maxAccounts: MAX_ACCOUNTS });
      console.log(`${name.padEnd(6)} buy ${w.buyVia.join("+")} -> sell ${w.sellVia.join("+")}   slots ${w.buySlot}/${w.sellSlot}`);
      console.log(`       quoted round trip ${w.netPct >= 0 ? "+" : ""}${w.netPct.toFixed(4)}%  (${(w.lamportsBackQuoted / 1e9).toFixed(6)} SOL back)`);
      console.log(`       ${w.instructions.length} instructions (${w.droppedDuplicates} duplicate steps dropped), ${w.staticAccounts} accounts written in full + ${w.lookedUpAccounts} through ${w.lookupTables.length} lookup table(s)`);
      console.log(`       size ${w.sizeBytes} bytes of ${TX_SIZE_LIMIT}: ${w.fits ? `FITS, ${TX_SIZE_LIMIT - w.sizeBytes} to spare` : `TOO BIG by ${w.sizeBytes - TX_SIZE_LIMIT}`}\n`);
    } catch (e) {
      console.log(`${name.padEnd(6)} could not be built: ${(e as Error).message}\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
