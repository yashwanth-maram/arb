import json, glob, collections, statistics as st
# Read the free-bet results. A "won" means the chain actually paid stake+floor: OUR token transfer succeeded, and
# the trade would have reverted otherwise. Rows written before the fix had no check in the transaction at all, and
# are excluded by requiring the stakeLamports field, which was added alongside it.
BASE_FEE = 5_000  # what a reverted attempt costs: no tip, no pool fees, just the signature
rows = []
for f in sorted(glob.glob("logs/jupiter-*.jsonl")):
    for line in open(f):
        if "shadow" not in line: continue
        try: o = json.loads(line)
        except Exception: continue
        if o.get("t") != "shadow" or "stakeLamports" not in o: continue
        rows.append(o)
if not rows: raise SystemExit("no free-bet rows yet (restart the scanner and wait for hits)")

verdicts = collections.Counter(r["verdict"] for r in rows)
attempts = sum(verdicts[v] for v in ("won", "reverted"))
print(f"{len(rows)} free bets, every one on a round trip that looked profitable")
for v, n in verdicts.most_common():
    print(f"   {v:<14} {n:>5}  ({n / len(rows) * 100:.1f}%)")

wins = [r for r in rows if r["verdict"] == "won"]
if wins:
    profits = [r["profitLamports"] or 0 for r in wins]
    print(f"\n{len(wins)} wins of {attempts} real attempts ({len(wins) / max(attempts, 1) * 100:.2f}%)")
    print(f"   the chain paid, in lamports: best {max(profits)}  median {int(st.median(profits))}")
    print(f"   in SOL:                      best {max(profits) / 1e9:.6f}  median {st.median(profits) / 1e9:.6f}")
    net = sum(profits) - BASE_FEE * (attempts - len(wins))
    print(f"\n   if every one had been sent: {sum(profits) / 1e9:+.6f} SOL won, {(BASE_FEE * (attempts - len(wins))) / 1e9:.6f} SOL of base fees on reverts")
    print(f"   net: {net / 1e9:+.6f} SOL   (before any tip, which a winner must also pay to land first)")
    best = max(wins, key=lambda r: r["profitLamports"] or 0)
    print(f"\n   best bet: {best['sym']} staking {(best['stakeLamports'] or 0) / 1e9} SOL, paid +{(best['profitLamports'] or 0) / 1e9:.6f} SOL")
    print(f"      route: buy {'+'.join(best['buyVia'])} -> sell {'+'.join(best['sellVia'])}, {best['computeUnits']} CU")
else:
    print(f"\n0 wins of {attempts} real attempts. Every bet reverted, costing {BASE_FEE / 1e9} SOL each if sent.")
bare = collections.Counter(r.get("bareVerdict") for r in rows if r.get("bareVerdict") not in (None, "skipped"))
if bare: print(f"\nreverts that WOULD have cleared a bare 5,000-lamport floor: {bare.get('won', 0)} of {sum(bare.values())}")
