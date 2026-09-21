import json, glob, os
# Turn the divergence watcher's alarms into the candidate file the depth checker reads, so the pools it named can be
# examined for real liquidity. Keeps the newest alarm per token. No network, no credits.
rows = {}
for f in sorted(glob.glob("logs/divergence_all-*.jsonl")):
    for line in open(f):
        if '"t":"alarm"' not in line: continue
        try: o = json.loads(line)
        except Exception: continue
        rows[o["mint"]] = o
if not rows: raise SystemExit("no alarms found (run `npm run diverge` first)")

head = ["symbol", "mint", "holders", "verified", "pools", "token_vol24h", "buy_venue", "buy_pool", "buy_detail",
        "buy_fee_pct", "buy_tvl", "buy_vol24h", "sell_venue", "sell_pool", "sell_detail", "sell_fee_pct",
        "sell_tvl", "sell_vol24h", "gap_pct", "fees_pct", "net_pct"]
out = [ "\t".join(head) ]
for o in sorted(rows.values(), key=lambda r: -r["netPct"]):
    b, s = o["buy"], o["sell"]
    fees = b["feePct"] + s["feePct"]
    out.append("\t".join(str(x) for x in [
        o["token"], o["mint"], 0, False, 2, 0,
        b["venue"], b["address"], b["venue"], f'{b["feePct"]:.3f}', b["tvl"], 0,
        s["venue"], s["address"], s["venue"], f'{s["feePct"]:.3f}', s["tvl"], 0,
        f'{o["netPct"] + fees:.3f}', f"{fees:.3f}", f'{o["netPct"]:.3f}']))
os.makedirs("../research", exist_ok=True)
open("../research/coverage_candidates.tsv", "w").write("\n".join(out) + "\n")
print(f"{len(rows)} alarms written to research/coverage_candidates.tsv")
for o in sorted(rows.values(), key=lambda r: -r["netPct"])[:12]:
    print(f"   {o['token']:<12} {o['netPct']:>8.1f}%  buy {o['buy']['venue']} ${o['buy']['tvl']:<8} fee {o['buy']['feePct']:.2f}%  ->  sell {o['sell']['venue']} ${o['sell']['tvl']:<8} fee {o['sell']['feePct']:.2f}%")
