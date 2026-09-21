import json, glob, collections, statistics as st
COST_SOL = 0.000105  # one signature plus a minimal tip: what it costs to land the trade
rows = []
for f in sorted(glob.glob("logs/jupiter-*.jsonl")):
    for line in open(f):
        if "shadow" not in line: continue
        try: o = json.loads(line)
        except Exception: continue
        if o.get("t") != "shadow": continue
        # Rows written before the measurement fix read as about +100%: the stake was counted as profit.
        if o.get("simulatedPct") is not None and abs(o["simulatedPct"]) > 50: continue
        rows.append(o)
if not rows: raise SystemExit("no shadow rows yet")

verdicts = collections.Counter(r["verdict"] for r in rows)
print(f"{len(rows)} shadow attempts, every one on a round trip that LOOKED profitable")
for v, n in verdicts.most_common():
    print(f"   {v:<26} {n:>5}  ({n / len(rows) * 100:.1f}%)")

ex = [r for r in rows if r["verdict"] == "executed" and r.get("simulatedPct") is not None]
if ex:
    nets = [r["simulatedPct"] for r in ex]
    profits = [r["simulatedPct"] / 100 * r["sizeSol"] for r in ex]
    after = [p - COST_SOL for p in profits]
    print(f"\nof the {len(ex)} that executed:")
    print(f"   measured net %: best {max(nets):+.4f}  median {st.median(nets):+.4f}  worst {min(nets):+.4f}")
    print(f"   above 0% on chain: {sum(1 for n in nets if n > 0)}  ({sum(1 for n in nets if n > 0) / len(ex) * 100:.1f}%)")
    print(f"   profit in SOL:  best {max(profits):+.6f}  median {st.median(profits):+.6f}")
    print(f"   AFTER the {COST_SOL} SOL it costs to land: above zero {sum(1 for p in after if p > 0)} of {len(ex)}   best {max(after):+.6f} SOL")
    both = [(r["quotedPct"], r["simulatedPct"]) for r in ex if r.get("quotedPct") is not None]
    if both:
        drop = [q - s for q, s in both]
        print(f"\n   the quote overstated the result by (points): median {st.median(drop):+.4f}  worst {max(drop):+.4f}")
        print(f"   quotes that were positive and stayed positive on chain: {sum(1 for q, s in both if q > 0 and s > 0)} of {sum(1 for q, s in both if q > 0)}")
    best = max(ex, key=lambda r: r["simulatedPct"] / 100 * r["sizeSol"])
    print(f"\n   best single trade: {best['sym']} {best['sizeSol']} SOL, quoted {best.get('quotedPct')}%, measured {best['simulatedPct']}%")
    print(f"      = {best['simulatedPct'] / 100 * best['sizeSol']:+.6f} SOL, i.e. {best['simulatedPct'] / 100 * best['sizeSol'] - COST_SOL:+.6f} SOL after costs")
