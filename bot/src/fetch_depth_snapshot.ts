import { Connection } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import BN from "bn.js";
import { getBinArrayLowerUpperBinId, getBinMaxAmountOut, isSupportLimitOrder } from "@meteora-ag/dlmm";
import { WATCHLIST, WSOL } from "./config/watchlist";
import { DLMM_PROGRAM_ID } from "./quoter/dlmm_accounts";
import { fetchDepthSnapshot } from "./quoter/fetch_depth";
import { decodeDepthSnapshot } from "./quoter/snapshot";

// Usage: npm run snapshot
// Saves everything a depth-aware quote needs for the watchlist, read at ONE slot, and prints what it found.
// Default output: logs/depth_snapshot-<slot>.json (git-ignored). The test fixture test/fixtures/depth_snapshot.json has
// numbers pinned to it, so it is only replaced on purpose: OUT=test/fixtures/depth_snapshot.json npm run snapshot
const ARRAYS_PER_SIDE = Number(process.env.ARRAYS_PER_SIDE ?? 3);
const NEAR_BINS = 5; // the summary adds up liquidity in the active bin plus this many bins beyond it
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }

  const raw = await fetchDepthSnapshot(new Connection(HTTP, "confirmed"), ARRAYS_PER_SIDE, console.log);
  const snap = decodeDepthSnapshot(raw);
  const fmt = (amount: BN, mint: string) => (Number(amount.toString()) / 10 ** (snap.decimals.get(mint) ?? 0)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  console.log(`snapshot  slot ${raw.slot}  ${raw.fetchedAt}  ${raw.accounts.length} accounts requested`);

  for (const p of WATCHLIST.filter((w) => w.venue === "dlmm")) {
    const state = snap.dlmm.get(p.label)!;
    const lb = state.lbPair;
    const [mx, my] = [lb.tokenXMint.toBase58(), lb.tokenYMint.toBase58()];
    const name = (mint: string) => (mint === WSOL ? "SOL" : p.token);
    const limitOrders = isSupportLimitOrder(lb);
    console.log(`\n${p.label}  ${short(p.address)}  active bin ${lb.activeId}  bin step ${lb.binStep}  X=${name(mx)} Y=${name(my)}  limit orders ${limitOrders ? "on" : "off"}`);
    const ext = raw.accounts.find((a) => a.kind === "bitmap_ext" && a.label === p.label)!;
    console.log(`  bitmap extension ${short(ext.address)}: ${ext.missing ? "does not exist (normal for most pools)" : `${ext.bytes} bytes`}`);

    const bins = new Map<number, NonNullable<ReturnType<typeof state.binArrays.get>>["bins"][number]>();
    for (const a of raw.accounts.filter((x) => x.kind === "bin_array" && x.label === p.label)) {
      const arr = state.binArrays.get(a.index!)!;
      const [lower, upper] = getBinArrayLowerUpperBinId(new BN(a.index!)).map((b) => b.toNumber());
      arr.bins.forEach((bin, k) => bins.set(lower + k, bin));
      const filled = arr.bins.filter((b) => !getBinMaxAmountOut(b, true, limitOrders).isZero() || !getBinMaxAmountOut(b, false, limitOrders).isZero()).length;
      const ok = a.owner === DLMM_PROGRAM_ID.toBase58() && arr.index.toNumber() === a.index && arr.lbPair.toBase58() === p.address;
      console.log(`  bin array ${String(a.index).padStart(5)}  ${short(a.address)}  ${a.bytes} bytes  bins ${lower}..${upper}  with liquidity ${String(filled).padStart(2)}/70  ${ok ? "ok" : "UNEXPECTED owner/index/pool"}`);
    }

    // What a swap could take out near the current price: Y by selling X (walking down), X by selling Y (walking up).
    const sum = (from: number, step: number, swapForY: boolean) => {
      let total = new BN(0);
      for (let k = 0; k <= NEAR_BINS; k++) { const b = bins.get(from + step * k); if (b) total = total.add(getBinMaxAmountOut(b, swapForY, limitOrders)); }
      return total;
    };
    const active = bins.get(lb.activeId);
    if (!active) { console.log(`  active bin ${lb.activeId} is not inside the fetched arrays`); continue; }
    console.log(`  active bin holds      ${fmt(getBinMaxAmountOut(active, false, limitOrders), mx)} ${name(mx)}  and  ${fmt(getBinMaxAmountOut(active, true, limitOrders), my)} ${name(my)}`);
    console.log(`  active + ${NEAR_BINS} bins down   ${fmt(sum(lb.activeId, -1, true), my)} ${name(my)} available to sellers of ${name(mx)}`);
    console.log(`  active + ${NEAR_BINS} bins up     ${fmt(sum(lb.activeId, +1, false), mx)} ${name(mx)} available to sellers of ${name(my)}`);
  }

  const out = process.env.OUT ?? join("logs", `depth_snapshot-${raw.slot}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(raw, null, 1) + "\n");
  const kinds = raw.accounts.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  console.log(`\nwrote ${out}`);
  console.log(`accounts: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
