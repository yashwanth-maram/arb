import { Connection, PublicKey } from "@solana/web3.js";
import { decodeDlmmPool } from "../decoders/meteora_dlmm";
import { decodeDammV2Pool } from "../decoders/meteora_damm_v2";

// Reads bot/.env (git-ignored). Never put the key in code or in the repo.
try { process.loadEnvFile(".env"); } catch { /* no .env: fall through to the check below */ }
const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
const HTTP = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const WS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 120);

const WSOL = "So11111111111111111111111111111111111111112";

type Venue = "dlmm" | "damm";
type Pool = { label: string; venue: Venue; address: string };
// The six watchlist pools from the Step 2 record.
const POOLS: Pool[] = [
  { label: "PERPSPAD dlmm80", venue: "dlmm", address: "EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr" },
  { label: "PERPSPAD damm",   venue: "damm", address: "84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ" },
  { label: "PEPE dlmm80",     venue: "dlmm", address: "C1baVnbBd31ucGqvuKgeghtyX6Xpnq5cXxamLqXi9hVN" },
  { label: "PEPE dlmm20",     venue: "dlmm", address: "HDojZeCdUee8nczxsc9MeiMKVF961HqEFeKEvHw74xVR" },
  { label: "PEPE damm1",      venue: "damm", address: "GRNVafZv78DndVua7phP9BFGmmFxJ9r58wBEakDyfsCg" },
  { label: "PEPE damm2",      venue: "damm", address: "ED6PwhyCQ52CQa9V58yy9BTVi9NdVCSVAWWiL1ZzAXhX" },
];

const decimalsByMint = new Map<string, number>();

async function loadDecimals(conn: Connection, mints: string[]) {
  const missing = mints.filter((m) => !decimalsByMint.has(m));
  if (missing.length === 0) return;
  const infos = await conn.getMultipleAccountsInfo(missing.map((m) => new PublicKey(m)));
  infos.forEach((info, i) => {
    if (!info) throw new Error(`mint ${missing[i]} not found`);
    decimalsByMint.set(missing[i], info.data[44]); // SPL Mint layout: decimals is the byte at offset 44
  });
}

// Returns price as SOL per token, whichever side of the pool SOL sits on, plus the fee a swap pays now.
function decodePrice(pool: Pool, data: Buffer): { price: number; feeBps: number; mints: [string, string] } {
  if (pool.venue === "dlmm") {
    const probe = decodeDlmmPool(pool.address, data, 0, 0);
    const [mx, my] = [probe.tokenXMint, probe.tokenYMint];
    const s = decodeDlmmPool(pool.address, data, decimalsByMint.get(mx) ?? 0, decimalsByMint.get(my) ?? 0);
    return { price: mx === WSOL ? 1 / s.price : s.price, feeBps: s.totalFeeBps, mints: [mx, my] };
  }
  const probe = decodeDammV2Pool(pool.address, data, 0, 0);
  const [ma, mb] = [probe.tokenAMint, probe.tokenBMint];
  const s = decodeDammV2Pool(pool.address, data, decimalsByMint.get(ma) ?? 0, decimalsByMint.get(mb) ?? 0);
  return { price: ma === WSOL ? 1 / s.price : s.price, feeBps: s.totalFeeBps, mints: [ma, mb] };
}

const ts = () => new Date().toISOString().slice(11, 23);

async function main() {
  const conn = new Connection(HTTP, { wsEndpoint: WS, commitment: "processed" });
  const startSlot = await conn.getSlot("processed");
  console.log(`${ts()} connected, slot ${startSlot}, watching ${POOLS.length} pools for ${RUN_SECONDS}s`);

  // Baseline: one fetch of all pools, learn their mints and decimals, print current prices.
  const infos = await conn.getMultipleAccountsInfo(POOLS.map((p) => new PublicKey(p.address)));
  const mints = new Set<string>();
  infos.forEach((info, i) => {
    if (!info) throw new Error(`${POOLS[i].label} account not found`);
    const p = POOLS[i].venue === "dlmm"
      ? decodeDlmmPool(POOLS[i].address, Buffer.from(info.data), 0, 0)
      : decodeDammV2Pool(POOLS[i].address, Buffer.from(info.data), 0, 0);
    ("tokenXMint" in p ? [p.tokenXMint, p.tokenYMint] : [p.tokenAMint, p.tokenBMint]).forEach((m) => mints.add(m));
  });
  await loadDecimals(conn, [...mints]);
  console.log("decimals:", Object.fromEntries(decimalsByMint));
  infos.forEach((info, i) => {
    const { price, feeBps } = decodePrice(POOLS[i], Buffer.from(info!.data));
    console.log(`${ts()} baseline  ${POOLS[i].label.padEnd(16)} ${price.toPrecision(8)} SOL/token  fee ${feeBps.toFixed(3)} bps`);
  });

  // Live: current slot from the slot stream, account updates from the account stream.
  let currentSlot = startSlot;
  const slotSub = conn.onSlotChange((s) => { currentSlot = s.slot; });
  const counts = new Map<string, number>(POOLS.map((p) => [p.label, 0]));
  const lags: number[] = [];
  const subs = POOLS.map((pool) =>
    conn.onAccountChange(new PublicKey(pool.address), (info, ctx) => {
      const lag = currentSlot - ctx.slot;
      lags.push(lag);
      counts.set(pool.label, (counts.get(pool.label) ?? 0) + 1);
      try {
        const { price, feeBps } = decodePrice(pool, Buffer.from(info.data));
        console.log(`${ts()} slot ${ctx.slot} lag ${lag}  ${pool.label.padEnd(16)} ${price.toPrecision(8)} SOL/token  fee ${feeBps.toFixed(3)} bps`);
      } catch (e) {
        console.log(`${ts()} slot ${ctx.slot}  ${pool.label} decode error: ${(e as Error).message}`);
      }
    }, "processed"),
  );

  await new Promise((r) => setTimeout(r, RUN_SECONDS * 1000));
  await Promise.all(subs.map((id) => conn.removeAccountChangeListener(id)));
  await conn.removeSlotChangeListener(slotSub);
  const sorted = [...lags].sort((a, b) => a - b);
  console.log(`\n${ts()} done. updates per pool:`, Object.fromEntries(counts));
  console.log(`slot lag: n=${lags.length} median=${sorted[Math.floor(sorted.length / 2)] ?? "n/a"} max=${sorted.at(-1) ?? "n/a"}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });