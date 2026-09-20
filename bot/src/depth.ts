import { Connection } from "@solana/web3.js";
import { join } from "node:path";
import { MAX_FEE_BPS, WATCHLIST, WSOL } from "./config/watchlist";
import { summarizeDlmm } from "./decoders/meteora_dlmm";
import { summarizeDammV2 } from "./decoders/meteora_damm_v2";
import { fetchDepthSnapshot } from "./quoter/fetch_depth";
import { allRoundTrips, bestPerSize, dammQuotable, dlmmQuotable, type QuotablePool } from "./quoter/pair";
import { decodeDepthSnapshot, loadDepthSnapshot, type DepthSnapshot } from "./quoter/snapshot";
import { effectivePrice, solToLamports } from "./quoter/types";

// Depth report for the whole watchlist, from ONE consistent read of every pool and its bin arrays.
//   npm run depth                  live (2 RPC requests)
//   FIXTURE=1 npm run depth        offline, from test/fixtures/depth_snapshot.json (slot 448478047)
//   SIZES=0.1,0.5,2 npm run depth  trade sizes in SOL
// Part 1, one pool at a time: buy with SOL, sell the tokens straight back. Shows each pool's fee and depth.
// Part 2, between pools: spend SOL on one pool, sell every token on the other. This is the trade we would send,
//         so its result is the executable net: fees and depth of both pools included.
const SIZES = (process.env.SIZES ?? "0.1,0.5,2").split(",").map(Number);
const DUST_SOL = 0.001; // too small to move the price: its round trip shows the two fees alone

type View = { pool: QuotablePool; spot: number; tokenDecimals: number };
const pctStr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
const num = (bn: { toString(): string }) => Number(bn.toString());

function viewsOf(snap: DepthSnapshot, token: string): View[] {
  return WATCHLIST.filter((p) => p.token === token).map((p) => {
    if (p.venue === "dlmm") {
      const st = snap.dlmm.get(p.label)!;
      const [mx, my] = [st.lbPair.tokenXMint.toBase58(), st.lbPair.tokenYMint.toBase58()];
      const s = summarizeDlmm(st.address, st.lbPair, snap.decimals.get(mx)!, snap.decimals.get(my)!);
      return { pool: dlmmQuotable(p.label, st, snap.clock), spot: mx === WSOL ? 1 / s.price : s.price, tokenDecimals: snap.decimals.get(mx === WSOL ? my : mx)! };
    }
    const d = snap.damm.get(p.label)!;
    const [ma, mb] = [d.state.tokenAMint.toBase58(), d.state.tokenBMint.toBase58()];
    const s = summarizeDammV2(d.address, d.state, snap.decimals.get(ma)!, snap.decimals.get(mb)!);
    return { pool: dammQuotable(p.label, d.address, d.state, snap.clock), spot: ma === WSOL ? 1 / s.price : s.price, tokenDecimals: snap.decimals.get(ma === WSOL ? mb : ma)! };
  });
}

function ladder(v: View) {
  // Buy with `sol`, then sell every token received straight back into the same pool.
  const trip = (sol: number) => {
    const buy = v.pool.quote("buy", solToLamports(sol));
    const sell = v.pool.quote("sell", buy.amountOut);
    return { buy, sell, pct: (num(sell.amountOut) / num(buy.amountIn) - 1) * 100 };
  };
  let dust: ReturnType<typeof trip> | null = null;
  try { dust = trip(DUST_SOL); } catch { /* the depth column stays empty */ }
  console.log(`\n  ${v.pool.label}  spot ${v.spot.toPrecision(8)} SOL  headline fee ${v.pool.feeBps.toFixed(3)} bps  ${dust ? `round trip on dust ${pctStr(dust.pct)}` : "dust quote failed"}`);
  console.log(`    size SOL     tokens bought   buy vs spot   sell vs spot   round trip   of which depth   fee paid buy / sell bps`);
  for (const sol of SIZES) {
    try {
      const t = trip(sol);
      const buyPx = effectivePrice(t.buy, v.tokenDecimals), sellPx = effectivePrice(t.sell, v.tokenDecimals);
      console.log([
        `    ${sol.toFixed(3).padStart(8)}`,
        (num(t.buy.amountOut) / 10 ** v.tokenDecimals).toFixed(4).padStart(17),
        pctStr((buyPx / v.spot - 1) * 100).padStart(13),
        pctStr((sellPx / v.spot - 1) * 100).padStart(14),
        pctStr(t.pct).padStart(12),
        (dust ? pctStr(t.pct - dust.pct) : "n/a").padStart(16),
        `${t.buy.feeBps.toFixed(3)} / ${t.sell.feeBps.toFixed(3)}`.padStart(25),
      ].join(" "));
    } catch (e) {
      console.log(`    ${sol.toFixed(3).padStart(8)}   could not be quoted: ${(e as Error).message}`);
    }
  }
}

function pairTable(views: View[]) {
  // The dust column is what the prices promise for a trade too small to move anything; the rest is what size costs.
  const sizes = [DUST_SOL, ...SIZES];
  const trips = allRoundTrips(views.map((v) => v.pool), sizes, MAX_FEE_BPS);
  const best = bestPerSize(trips);
  const width = Math.max(...views.map((v) => v.pool.label.length));
  console.log(`\n  between pools: spend SOL on the first, sell every token on the second   (* = best at that size)`);
  console.log(`    ${"buy on".padEnd(width)}  ${"sell on".padEnd(width)}  ${sizes.map((s) => (s === DUST_SOL ? "dust" : `${s} SOL`).padStart(11)).join("")}`);
  const seen = new Set<string>();
  for (const t of trips) {
    const key = `${t.buyOn}>${t.sellOn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cells = sizes.map((size) => {
      const r = trips.find((x) => x.buyOn === t.buyOn && x.sellOn === t.sellOn && x.sizeSol === size)!;
      return (r.netPct === null ? "no fill " : `${pctStr(r.netPct)}${best.get(size) === r ? "*" : " "}`).padStart(11);
    });
    console.log(`    ${t.buyOn.padEnd(width)}  ${t.sellOn.padEnd(width)}  ${cells.join("")}`);
  }
  const skipped = views.filter((v) => v.pool.feeBps > MAX_FEE_BPS).map((v) => `${v.pool.label} (${v.pool.feeBps.toFixed(0)} bps)`);
  if (skipped.length) console.log(`    left out, fee above ${MAX_FEE_BPS} bps: ${skipped.join(", ")}`);
}

async function main() {
  let snap: DepthSnapshot;
  if (process.env.FIXTURE) {
    snap = loadDepthSnapshot(join(__dirname, "..", "test", "fixtures", "depth_snapshot.json"));
    console.log(`fixture  slot ${snap.slot}  ${snap.fetchedAt}`);
  } else {
    try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
    const KEY = process.env.HELIUS_API_KEY;
    const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
    if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
    snap = decodeDepthSnapshot(await fetchDepthSnapshot(new Connection(HTTP, "confirmed"), 3, console.log));
    console.log(`live  slot ${snap.slot}  ${snap.fetchedAt}`);
  }
  for (const token of [...new Set(WATCHLIST.map((p) => p.token))]) {
    const views = viewsOf(snap, token);
    console.log(`\n== ${token}`);
    for (const v of views) ladder(v);
    pairTable(views);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
