import { Connection } from "@solana/web3.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { binIdToBinArrayIndex, getBinFromBinArray, getBinMaxAmountOut, isSupportLimitOrder } from "@meteora-ag/dlmm";
import { MAX_FEE_BPS, WSOL, type PoolCfg } from "../config/watchlist";
import { fetchDepthSnapshot } from "../quoter/fetch_depth";
import { allRoundTrips, dammQuotable, dlmmQuotable, type QuotablePool } from "../quoter/pair";
import { decodeDepthSnapshot } from "../quoter/snapshot";

// Usage: npm run candidates:depth          (about 2 Helius credits per candidate)
// Coverage test, step 2: take the top rows of research/coverage_candidates.tsv and look at the REAL liquidity of each
// pair: both pools and their bin arrays read at one slot, then the round trip in both directions at dust, 0.1, 0.5 and
// 2 SOL. This separates phantoms (a gap in list prices that nobody can trade) from gaps that are really there.
// Tunables (env): ROWS 8 (how many candidates, in file order = best headline net first), SIZES 0.1,0.5,2.
const ROWS = Number(process.env.ROWS ?? 8);
const SIZES = [0.001, ...(process.env.SIZES ?? "0.1,0.5,2").split(",").map(Number)];
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RESEARCH = join(__dirname, "..", "..", "..", "research");
const pctStr = (x: number | null) => (x === null ? "no fill" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`);
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;

async function main() {
  try { process.loadEnvFile(".env"); } catch { /* .env optional if the variables are set another way */ }
  const KEY = process.env.HELIUS_API_KEY;
  const HTTP = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "");
  if (!HTTP) { console.error("HELIUS_API_KEY missing. Create bot/.env with: HELIUS_API_KEY=your_key"); process.exit(1); }
  const conn = new Connection(HTTP, "confirmed");

  const lines = readFileSync(join(RESEARCH, "coverage_candidates.tsv"), "utf8").trim().split("\n");
  const head = lines[0].split("\t");
  const rows = lines.slice(1, 1 + ROWS).map((l) => Object.fromEntries(l.split("\t").map((v, i) => [head[i], v])));
  const outFile = join(RESEARCH, "coverage_depth.tsv");
  if (!existsSync(outFile)) writeFileSync(outFile, ["checked_at", "slot", "symbol", "mint", "list_net_pct", "buy_pool", "sell_pool", ...SIZES.map((s) => `net_${s}`)].join("\t") + "\n");

  let real = 0, phantom = 0, skipped = 0;
  for (const r of rows) {
    const pools: PoolCfg[] = [
      { token: r.symbol, label: `A ${r.buy_venue} ${r.buy_detail}`, venue: r.buy_venue as PoolCfg["venue"], address: r.buy_pool },
      { token: r.symbol, label: `B ${r.sell_venue} ${r.sell_detail}`, venue: r.sell_venue as PoolCfg["venue"], address: r.sell_pool },
    ];
    console.log(`\n== ${r.symbol}  ${short(r.mint)}  ${r.holders} holders   list said: gap ${r.gap_pct}%  fees ${r.fees_pct}%  net ${Number(r.net_pct) >= 0 ? "+" : ""}${r.net_pct}%`);
    try {
      const raw = await fetchDepthSnapshot(conn, 3, (m) => console.log(`   ${m}`), pools);
      const foreign = raw.accounts.filter((a) => a.kind === "mint" && a.owner !== CLASSIC_TOKEN_PROGRAM);
      if (foreign.length) { console.log(`   skipped: mint ${short(foreign[0].address)} is not a classic SPL token (owner ${short(foreign[0].owner ?? "?")}); our quotes ignore Token-2022 transfer fees`); skipped++; continue; }
      const snap = decodeDepthSnapshot(raw);
      const quotables: QuotablePool[] = [];
      for (const p of pools) {
        if (p.venue === "dlmm") {
          const st = snap.dlmm.get(p.label)!;
          const lb = st.lbPair, lo = isSupportLimitOrder(lb);
          const [mx, my] = [lb.tokenXMint.toBase58(), lb.tokenYMint.toBase58()];
          const array = st.binArrays.get(binIdToBinArrayIndex(new BN(lb.activeId)).toNumber());
          const bin = array ? getBinFromBinArray(lb.activeId, array) : undefined;
          const amt = (swapForY: boolean, mint: string) => (bin ? Number(getBinMaxAmountOut(bin, swapForY, lo).toString()) / 10 ** (snap.decimals.get(mint) ?? 0) : NaN);
          const name = (m: string) => (m === WSOL ? "SOL" : r.symbol);
          console.log(`   ${p.label.padEnd(20)} ${short(p.address)}  active bin ${lb.activeId} holds ${amt(false, mx).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${name(mx)} and ${amt(true, my).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${name(my)}`);
          quotables.push(dlmmQuotable(p.label, st, snap.clock));
        } else {
          const d = snap.damm.get(p.label)!;
          console.log(`   ${p.label.padEnd(20)} ${short(p.address)}  constant-product curve`);
          quotables.push(dammQuotable(p.label, d.address, d.state, snap.clock));
        }
      }
      const trips = allRoundTrips(quotables, SIZES, MAX_FEE_BPS);
      console.log(`   slot ${snap.slot}   executable round trip   ${SIZES.map((s) => (s === 0.001 ? "dust" : `${s} SOL`).padStart(10)).join("")}`);
      let bestAnywhere = -Infinity;
      for (const [buy, sell] of [[quotables[0], quotables[1]], [quotables[1], quotables[0]]]) {
        const nets = SIZES.map((s) => trips.find((t) => t.buyOn === buy.label && t.sellOn === sell.label && t.sizeSol === s)?.netPct ?? null);
        for (const n of nets) if (n !== null && n > bestAnywhere) bestAnywhere = n;
        console.log(`   buy ${buy.label.slice(0, 1)}, sell ${sell.label.slice(0, 1)}                        ${nets.map((n) => pctStr(n).padStart(10)).join("")}`);
        appendFileSync(outFile, [raw.fetchedAt, raw.slot, r.symbol, r.mint, r.net_pct, buy.label, sell.label, ...nets.map((n) => (n === null ? "" : n.toFixed(4)))].join("\t") + "\n");
      }
      if (!trips.length) { console.log(`   nothing to quote: a pool's real fee is above ${MAX_FEE_BPS} bps`); skipped++; }
      else if (bestAnywhere > 0) { console.log(`   >>> EXECUTABLE GAP at this slot: best ${pctStr(bestAnywhere)}`); real++; }
      else { console.log(`   no executable gap: best ${pctStr(bestAnywhere)}${Number(r.net_pct) > 0 ? "  (the list's positive net was a phantom or is gone)" : ""}`); phantom++; }
    } catch (e) {
      console.log(`   could not be checked: ${(e as Error).message}`); skipped++;
    }
  }
  console.log(`\nchecked ${rows.length} candidates: ${real} with an executable gap right now, ${phantom} without, ${skipped} skipped.   Results appended to research/coverage_depth.tsv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
