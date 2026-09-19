import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { getBinArrayLowerUpperBinId, getBinMaxAmountOut, isSupportLimitOrder } from "@meteora-ag/dlmm";
import { WATCHLIST, WSOL } from "./config/watchlist";
import { decodeDlmmRaw, decodeBinArray, decodeBitmapExtension } from "./decoders/meteora_dlmm";
import { decodeDammV2Raw } from "./decoders/meteora_damm_v2";
import { DLMM_PROGRAM_ID, binArrayAddress, binArrayIndexesBothWays, bitmapExtensionAddress } from "./quoter/dlmm_accounts";

// Usage: npm run snapshot
// Reads, at ONE slot, everything a depth-aware quote needs for the watchlist: each pool account, the bin arrays a
// DLMM swap could walk (ARRAYS_PER_SIDE in each direction), each DLMM pool's bitmap extension, and the mints.
// Writes test/fixtures/depth_snapshot.json. Costs a handful of RPC requests.
const ARRAYS_PER_SIDE = Number(process.env.ARRAYS_PER_SIDE ?? 3);
const NEAR_BINS = 5; // the summary adds up liquidity in the active bin plus this many bins beyond it
const OUT = join(__dirname, "..", "test", "fixtures", "depth_snapshot.json");

type Want = { kind: "dlmm_pool" | "damm_pool" | "bitmap_ext" | "bin_array" | "mint"; label: string; address: string; index?: number };
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;
const dlmmPools = WATCHLIST.filter((p) => p.venue === "dlmm");

/** From the pool accounts, work out every other account the quotes need. */
function wantedAccounts(poolData: Map<string, Buffer>, extData: Map<string, Buffer | null>): Want[] {
  const wants: Want[] = [];
  const mints = new Set<string>();
  for (const p of WATCHLIST) {
    const data = poolData.get(p.address);
    if (!data) throw new Error(`${p.label} account not found`);
    wants.push({ kind: p.venue === "dlmm" ? "dlmm_pool" : "damm_pool", label: p.label, address: p.address });
    if (p.venue === "dlmm") {
      const lb = decodeDlmmRaw(data);
      const extAddress = bitmapExtensionAddress(new PublicKey(p.address)).toBase58();
      const ext = extData.get(extAddress);
      wants.push({ kind: "bitmap_ext", label: p.label, address: extAddress });
      for (const index of binArrayIndexesBothWays(lb, ext ? decodeBitmapExtension(ext) : null, ARRAYS_PER_SIDE))
        wants.push({ kind: "bin_array", label: p.label, address: binArrayAddress(new PublicKey(p.address), index).toBase58(), index });
      mints.add(lb.tokenXMint.toBase58()); mints.add(lb.tokenYMint.toBase58());
    } else {
      const pool = decodeDammV2Raw(data);
      mints.add(pool.tokenAMint.toBase58()); mints.add(pool.tokenBMint.toBase58());
    }
  }
  for (const m of mints) wants.push({ kind: "mint", label: m === WSOL ? "SOL" : short(m), address: m });
  return wants;
}

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
  const conn = new Connection(HTTP, "confirmed");

  // Pass 1: pools and bitmap extensions, to learn which bin arrays and mints to ask for.
  const poolKeys = WATCHLIST.map((p) => p.address);
  const extKeys = dlmmPools.map((p) => bitmapExtensionAddress(new PublicKey(p.address)).toBase58());
  const first = await conn.getMultipleAccountsInfo([...poolKeys, ...extKeys].map((k) => new PublicKey(k)));
  let poolData = new Map<string, Buffer>();
  let extData = new Map<string, Buffer | null>();
  poolKeys.forEach((k, i) => { if (first[i]) poolData.set(k, Buffer.from(first[i]!.data)); });
  extKeys.forEach((k, i) => { const info = first[poolKeys.length + i]; extData.set(k, info ? Buffer.from(info.data) : null); });

  // Pass 2: everything in one request, so every account is from the same slot. If a pool moved far enough between
  // the passes to need a bin array we did not ask for, ask again with the fresh state (a few tries at most).
  let wants = wantedAccounts(poolData, extData);
  let slot = 0;
  let infos: (AccountInfo<Buffer> | null)[] = [];
  for (let attempt = 1; ; attempt++) {
    const res = await conn.getMultipleAccountsInfoAndContext(wants.map((w) => new PublicKey(w.address)));
    slot = res.context.slot; infos = res.value;
    const byAddress = new Map(wants.map((w, i) => [w.address, infos[i]] as const));
    poolData = new Map<string, Buffer>();
    extData = new Map<string, Buffer | null>();
    for (const k of poolKeys) { const info = byAddress.get(k); if (info) poolData.set(k, Buffer.from(info.data)); }
    for (const k of extKeys) { const info = byAddress.get(k); extData.set(k, info ? Buffer.from(info.data) : null); }
    const fresh = wantedAccounts(poolData, extData);
    const missing = fresh.filter((w) => !byAddress.has(w.address));
    if (missing.length === 0) break;
    if (attempt >= 4) throw new Error(`pools kept moving: still missing ${missing.map((m) => `${m.label} #${m.index}`).join(", ")}`);
    console.log(`attempt ${attempt}: ${missing.length} more account(s) needed after a price move, asking again`);
    wants = fresh;
  }

  // Report what came back, pool by pool, and check it is what we think it is.
  const decimals = new Map<string, number>();
  wants.forEach((w, i) => { if (w.kind === "mint" && infos[i]) decimals.set(w.address, infos[i]!.data[44]); }); // SPL Mint layout: decimals byte at offset 44
  const fmt = (raw: BN, mint: string) => (Number(raw.toString()) / 10 ** (decimals.get(mint) ?? 0)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  console.log(`snapshot  slot ${slot}  ${new Date().toISOString()}  ${wants.length} accounts requested`);

  for (const p of dlmmPools) {
    const lb = decodeDlmmRaw(poolData.get(p.address)!);
    const [mx, my] = [lb.tokenXMint.toBase58(), lb.tokenYMint.toBase58()];
    const name = (mint: string) => (mint === WSOL ? "SOL" : p.token);
    const limitOrders = isSupportLimitOrder(lb);
    console.log(`\n${p.label}  ${short(p.address)}  active bin ${lb.activeId}  bin step ${lb.binStep}  X=${name(mx)} Y=${name(my)}  limit orders ${limitOrders ? "on" : "off"}`);
    const ext = wants.findIndex((w) => w.kind === "bitmap_ext" && w.label === p.label);
    console.log(`  bitmap extension ${short(wants[ext].address)}: ${infos[ext] ? `${infos[ext]!.data.length} bytes` : "does not exist (normal for most pools)"}`);

    const bins = new Map<number, ReturnType<typeof decodeBinArray>["bins"][number]>();
    wants.forEach((w, i) => {
      if (w.kind !== "bin_array" || w.label !== p.label) return;
      const info = infos[i];
      if (!info) { console.log(`  bin array ${String(w.index).padStart(5)}  ${short(w.address)}  MISSING`); return; }
      const arr = decodeBinArray(Buffer.from(info.data));
      const [lower, upper] = getBinArrayLowerUpperBinId(new BN(w.index!)).map((b) => b.toNumber());
      arr.bins.forEach((bin, k) => bins.set(lower + k, bin));
      const filled = arr.bins.filter((b) => !getBinMaxAmountOut(b, true, limitOrders).isZero() || !getBinMaxAmountOut(b, false, limitOrders).isZero()).length;
      const ok = info.owner.equals(DLMM_PROGRAM_ID) && arr.index.toNumber() === w.index && arr.lbPair.toBase58() === p.address;
      console.log(`  bin array ${String(w.index).padStart(5)}  ${short(w.address)}  ${info.data.length} bytes  bins ${lower}..${upper}  with liquidity ${String(filled).padStart(2)}/70  ${ok ? "ok" : "UNEXPECTED owner/index/pool"}`);
    });

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

  const missing = wants.filter((w, i) => !infos[i] && w.kind !== "bitmap_ext");
  if (missing.length) throw new Error(`accounts missing: ${missing.map((m) => `${m.kind} ${m.label} ${m.address}`).join("; ")}`);

  const accounts = wants.map((w, i) => {
    const info = infos[i];
    return info
      ? { ...w, owner: info.owner.toBase58(), lamports: info.lamports, bytes: info.data.length, dataBase64: Buffer.from(info.data).toString("base64") }
      : { ...w, missing: true };
  });
  writeFileSync(OUT, JSON.stringify({ slot, fetchedAt: new Date().toISOString(), arraysPerSide: ARRAYS_PER_SIDE, accounts }, null, 1) + "\n");
  const kinds = accounts.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  console.log(`\nwrote ${OUT}`);
  console.log(`accounts: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
