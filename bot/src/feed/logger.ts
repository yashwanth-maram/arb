import { Connection, PublicKey } from "@solana/web3.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodeDlmmPool } from "../decoders/meteora_dlmm";
import { decodeDammV2Pool } from "../decoders/meteora_damm_v2";
import { WATCHLIST, MAX_FEE_BPS, WSOL, type PoolCfg } from "../config/watchlist";
import { bestPair, type PoolSnap } from "../scanner/best_pair";

// ---- configuration (env) ----------------------------------------------------------------
try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
const HTTP = process.env.RPC_HTTP ?? `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const WS = process.env.RPC_WS ?? `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const LOG_DIR = process.env.LOG_DIR ?? "logs";
const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS ?? 60);
const STALE_SECONDS = Number(process.env.STALE_SECONDS ?? 15);     // no slot update for this long -> exit, the supervisor starts a fresh process
const STARTUP_SECONDS = Number(process.env.STARTUP_SECONDS ?? 60); // the first connect may take this long before we give up the same way
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 0);          // 0 = run forever

// ---- log file ---------------------------------------------------------------------------
mkdirSync(LOG_DIR, { recursive: true });
const logPath = () => join(LOG_DIR, `divergence-${new Date().toISOString().slice(0, 10)}.jsonl`);
function writeLine(obj: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  appendFileSync(logPath(), line + "\n");
  return line;
}

// ---- state ------------------------------------------------------------------------------
const decimalsByMint = new Map<string, number>();
const snapsByToken = new Map<string, Map<string, PoolSnap>>();   // token -> label -> latest snapshot
const counts = new Map<string, number>(WATCHLIST.map((p) => [p.label, 0]));
let currentSlot = 0;
let lastSlotAt = Date.now();
let updates = 0;
let opportunities = 0;
const startedAt = Date.now();

type Decoded = { price: number; feeBps: number; mints: [string, string] };

function decodePrice(pool: PoolCfg, data: Buffer): Decoded {
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

async function loadDecimals(conn: Connection, mints: string[]) {
  const missing = mints.filter((m) => !decimalsByMint.has(m));
  if (missing.length === 0) return;
  const infos = await conn.getMultipleAccountsInfo(missing.map((m) => new PublicKey(m)));
  infos.forEach((info, i) => {
    if (!info) throw new Error(`mint ${missing[i]} not found`);
    decimalsByMint.set(missing[i], info.data[44]); // SPL Mint layout: decimals byte at offset 44
  });
}

function record(pool: PoolCfg, data: Buffer, slot: number, source: "baseline" | "update") {
  const { price, feeBps } = decodePrice(pool, data);
  const snaps = snapsByToken.get(pool.token) ?? new Map<string, PoolSnap>();
  snapsByToken.set(pool.token, snaps);
  const prev = snaps.get(pool.label);
  snaps.set(pool.label, { price, feeBps, slot, ts: Date.now() });
  const best = bestPair(snaps, MAX_FEE_BPS);
  const changed = !prev || prev.price !== price;
  if (best && best.netPct > 0) opportunities++;
  const snapshot: Record<string, [number, number, number]> = {};
  for (const [label, s] of snaps) snapshot[label] = [s.price, Number(s.feeBps.toFixed(3)), s.slot];
  return writeLine({
    t: source === "baseline" ? "base" : "upd",
    slot, lag: source === "update" ? currentSlot - slot : 0,
    token: pool.token, pool: pool.label, price, feeBps: Number(feeBps.toFixed(3)), changed,
    best: best ? { a: best.a, b: best.b, gapPct: +best.gapPct.toFixed(4), floorPct: +best.feeFloorPct.toFixed(4), netPct: +best.netPct.toFixed(4), dir: best.direction } : null,
    snap: snapshot,
  });
}

// ---- connection lifecycle -----------------------------------------------------------------
type Live = { conn: Connection; subs: number[]; slotSub: number };

async function connect(): Promise<Live> {
  const conn = new Connection(HTTP, { wsEndpoint: WS, commitment: "processed" });
  currentSlot = await conn.getSlot("processed");
  lastSlotAt = Date.now();

  const keys = WATCHLIST.map((p) => new PublicKey(p.address));
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys);
  const mints = new Set<string>();
  value.forEach((info, i) => {
    if (!info) throw new Error(`${WATCHLIST[i].label} account not found`);
    const p = WATCHLIST[i].venue === "dlmm"
      ? decodeDlmmPool(WATCHLIST[i].address, Buffer.from(info.data), 0, 0)
      : decodeDammV2Pool(WATCHLIST[i].address, Buffer.from(info.data), 0, 0);
    ("tokenXMint" in p ? [p.tokenXMint, p.tokenYMint] : [p.tokenAMint, p.tokenBMint]).forEach((m) => mints.add(m));
  });
  await loadDecimals(conn, [...mints]);
  value.forEach((info, i) => record(WATCHLIST[i], Buffer.from(info!.data), context.slot, "baseline"));

  const slotSub = conn.onSlotChange((s) => { currentSlot = s.slot; lastSlotAt = Date.now(); });
  const subs = WATCHLIST.map((pool) =>
    conn.onAccountChange(new PublicKey(pool.address), (info, ctx) => {
      updates++;
      counts.set(pool.label, (counts.get(pool.label) ?? 0) + 1);
      try {
        const line = record(pool, Buffer.from(info.data), ctx.slot, "update");
        if (process.env.VERBOSE) console.log(line);
      } catch (e) {
        writeLine({ t: "error", pool: pool.label, slot: ctx.slot, msg: (e as Error).message });
      }
    }, "processed"),
  );
  console.log(`${new Date().toISOString()} connected slot ${currentSlot}, ${WATCHLIST.length} pools, decimals ${JSON.stringify(Object.fromEntries(decimalsByMint))}`);
  writeLine({ t: "connect", slot: currentSlot, pools: WATCHLIST.length });
  return { conn, subs, slotSub };
}

async function teardown(live: Live) {
  await Promise.allSettled([
    ...live.subs.map((id) => live.conn.removeAccountChangeListener(id)),
    live.conn.removeSlotChangeListener(live.slotSub),
  ]);
}

async function main() {
  writeLine({ t: "start", pid: process.pid });
  let live: Live | null = null;

  // Watchdog, crash-only. The feed must keep moving: slots arrive every 0.4 s. If none arrives for STALE_SECONDS
  // (or the first connect takes longer than STARTUP_SECONDS), write one line and exit with code 2. The supervisor
  // (ops/run_logger.sh) starts a fresh process a few seconds later. A fresh process cannot inherit a half-dead
  // socket or a promise that never settles; an in-process reconnect can, and did: on 2026-09-20 closing the dead
  // connection never returned, every later reconnect was blocked, and the logger sat deaf for 3 h 48 min.
  // It starts before the first connect, so a connect that hangs is covered too. Nothing in it waits on the network.
  setInterval(() => {
    const staleSec = (Date.now() - lastSlotAt) / 1000;
    if (staleSec < (live ? STALE_SECONDS : STARTUP_SECONDS)) return;
    console.log(writeLine({ t: "stale_exit", phase: live ? "running" : "startup", staleSec: Math.round(staleSec), slot: currentSlot, updates }));
    process.exit(2);
  }, 1000);

  const stop = async (why: string) => {
    console.log(writeLine({ t: "stop", why, updates, opportunities, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
    setTimeout(() => process.exit(0), 2000); // unsubscribing politely must never keep us alive
    try { if (live) await teardown(live); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  if (RUN_SECONDS > 0) setTimeout(() => stop(`RUN_SECONDS=${RUN_SECONDS}`), RUN_SECONDS * 1000);

  live = await connect();
  lastSlotAt = Date.now(); // the subscriptions get STALE_SECONDS from here to deliver their first slot

  setInterval(() => {
    const line = writeLine({
      t: "hb", slot: currentSlot, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      updates, opportunities, counts: Object.fromEntries(counts),
      staleSec: Math.round((Date.now() - lastSlotAt) / 1000),
    });
    console.log(line);
  }, HEARTBEAT_SECONDS * 1000);
}

main().catch((e) => { console.error(e); writeLine({ t: "fatal", msg: (e as Error).message }); process.exit(1); });
