import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { WATCHLIST, WSOL } from "./config/watchlist";
import { decodeDammV2Raw, summarizeDammV2 } from "./decoders/meteora_damm_v2";
import { quoteDammV2 } from "./quoter/damm_v2";
import { effectivePrice, solToLamports, type Clock } from "./quoter/types";

// Depth ladder: what a trade of a given size really pays or receives in a pool, against the pool's headline price.
//   npm run depth                  live: every DAMM v2 pool on the watchlist, read in one RPC snapshot (2 requests)
//   FIXTURE=1 npm run depth        offline: the PERPSPAD DAMM v2 fixture (slot 448334506)
//   SIZES=0.1,0.5,2 npm run depth  trade sizes in SOL
// DLMM pools need their bin arrays; they join this ladder in a later step.
const SIZES = (process.env.SIZES ?? "0.1,0.5,2").split(",").map(Number);
const DUST_SOL = 0.001; // too small to move the price: its round trip shows the two fees alone

type Pool = { label: string; address: string; state: PoolState };
const pctStr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;
const num = (bn: { toString(): string }) => Number(bn.toString());

function ladder(p: Pool, clock: Clock, decimalsOf: (mint: string) => number) {
  const [mintA, mintB] = [p.state.tokenAMint.toBase58(), p.state.tokenBMint.toBase58()];
  const s = summarizeDammV2(p.address, p.state, decimalsOf(mintA), decimalsOf(mintB));
  const tokenDecimals = decimalsOf(mintA === WSOL ? mintB : mintA);
  const spot = mintA === WSOL ? 1 / s.price : s.price; // always SOL per token

  // Buy with `sol`, then sell every token received straight back into the same pool.
  const trip = (sol: number) => {
    const buy = quoteDammV2(p.state, "buy", solToLamports(sol), clock);
    const sell = quoteDammV2(p.state, "sell", buy.amountOut, clock);
    return { buy, sell, pct: (num(sell.amountOut) / num(buy.amountIn) - 1) * 100 };
  };
  let dust: ReturnType<typeof trip> | null = null;
  try { dust = trip(DUST_SOL); } catch { /* dust too small for this token: the depth column stays empty */ }

  // "fee max" is the decoder's worst case (the top of a fee schedule). The last column is what each trade is really charged.
  const dustStr = dust ? `round trip on dust ${pctStr(dust.pct)}` : "dust quote failed";
  console.log(`\n${p.label}  ${short(p.address)}  spot ${spot.toPrecision(8)} SOL  fee max ${s.totalFeeBps.toFixed(3)} bps  ${dustStr}`);
  console.log(`  size SOL     tokens bought   buy vs spot   sell vs spot   round trip   of which depth   fee paid buy / sell bps`);
  for (const sol of SIZES) {
    try {
      const t = trip(sol);
      const buyPx = effectivePrice(t.buy, tokenDecimals), sellPx = effectivePrice(t.sell, tokenDecimals);
      console.log([
        `  ${sol.toFixed(3).padStart(8)}`,
        (num(t.buy.amountOut) / 10 ** tokenDecimals).toFixed(4).padStart(17),
        pctStr((buyPx / spot - 1) * 100).padStart(13),
        pctStr((sellPx / spot - 1) * 100).padStart(14),
        pctStr(t.pct).padStart(12),
        (dust ? pctStr(t.pct - dust.pct) : "n/a").padStart(16),
        `${t.buy.feeBps.toFixed(3)} / ${t.sell.feeBps.toFixed(3)}`.padStart(25),
      ].join(" "));
    } catch (e) {
      console.log(`  ${sol.toFixed(3).padStart(8)}   could not be quoted: ${(e as Error).message}`);
    }
  }
}

async function main() {
  const raw: { label: string; address: string; data: Buffer }[] = [];
  const decimals = new Map<string, number>();
  let clock: Clock;
  let conn: Connection | null = null;

  if (process.env.FIXTURE) {
    const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "..", "test", "fixtures", `${name}.json`), "utf8"));
    const pool = fx("damm_pool");
    for (const m of [fx("mint_perpspad"), fx("mint_wsol")]) decimals.set(m.address, Buffer.from(m.dataBase64, "base64")[44]);
    raw.push({ label: "PERPSPAD damm (fixture)", address: pool.address, data: Buffer.from(pool.dataBase64, "base64") });
    clock = { slot: pool.slot, unixTime: Math.floor(Date.parse(pool.fetchedAt) / 1000) };
    console.log(`fixture  slot ${clock.slot}  ${pool.fetchedAt}`);
  } else {
    try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
    const KEY = process.env.HELIUS_API_KEY;
    const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
    if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
    conn = new Connection(HTTP, "confirmed");
    const cfgs = WATCHLIST.filter((p) => p.venue === "damm");
    // One request, one slot: every pool is read at the same moment.
    const { context, value } = await conn.getMultipleAccountsInfoAndContext(cfgs.map((p) => new PublicKey(p.address)));
    cfgs.forEach((p, i) => {
      if (!value[i]) console.log(`${p.label}  ${short(p.address)}  account not found`);
      else raw.push({ label: p.label, address: p.address, data: Buffer.from(value[i]!.data) });
    });
    clock = { slot: context.slot, unixTime: Math.floor(Date.now() / 1000) };
    console.log(`live  slot ${clock.slot}  ${new Date().toISOString()}`);
  }

  // Decode once. A pool that fails to decode is reported and skipped; the others still print.
  const pools: Pool[] = [];
  for (const r of raw) {
    try { pools.push({ label: r.label, address: r.address, state: decodeDammV2Raw(r.data) }); }
    catch (e) { console.log(`\n${r.label}  ${short(r.address)}  could not be decoded: ${(e as Error).message}`); }
  }

  if (conn) {
    const mints = [...new Set(pools.flatMap((p) => [p.state.tokenAMint.toBase58(), p.state.tokenBMint.toBase58()]))];
    const infos = await conn.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)));
    infos.forEach((info, i) => { if (info) decimals.set(mints[i], info.data[44]); }); // SPL Mint layout: decimals byte at offset 44
  }
  const decimalsOf = (mint: string) => {
    const d = decimals.get(mint);
    if (d === undefined) throw new Error(`decimals unknown for mint ${mint}`);
    return d;
  };

  for (const p of pools) {
    try { ladder(p, clock, decimalsOf); }
    catch (e) { console.log(`\n${p.label}  ${short(p.address)}  could not be quoted: ${(e as Error).message}`); }
  }
  if (conn) console.log(`\n${WATCHLIST.filter((p) => p.venue === "dlmm").length} DLMM pools are not shown yet: their quote needs bin arrays (a later step).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
