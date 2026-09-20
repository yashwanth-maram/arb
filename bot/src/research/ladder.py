import json, glob, collections
rows = []
for f in sorted(glob.glob("logs/jupiter-*.jsonl")):
    for line in open(f):
        try: o = json.loads(line)
        except Exception: continue
        if o.get("t") in ("rt", "hit") and "profitSol" in o: rows.append(o)
if not rows: raise SystemExit("no round-trip rows yet")
print(f"{len(rows)} round trips in {len(set(r['sweep'] for r in rows))} sweeps\n")

# Every moment where one token was priced at several sizes: does profit in SOL grow with size?
groups = collections.defaultdict(dict)
for r in rows: groups[(r["sweep"], r["sym"])][r["sizeSol"]] = r
ladders = {k: v for k, v in groups.items() if len(v) >= 3}
print(f"{len(ladders)} size ladders (one token, one moment, several sizes)\n")
print(f"{'token':<10} {'sweep':>5}   " + "".join(f"{str(s)+' SOL':>22}" for s in [0.1, 0.5, 2, 10, 50]))
for (sweep, sym), by in sorted(ladders.items(), key=lambda kv: -max(r["profitSol"] for r in kv[1].values()))[:12]:
    cells = []
    for s in [0.1, 0.5, 2, 10, 50]:
        r = by.get(s)
        cells.append(f"{r['netPct']:+.4f}% {r['profitSol']:+.5f}".rjust(22) if r else "".rjust(22))
    print(f"{sym:<10} {sweep:>5}   " + "".join(cells))

print("\nbest profit ever seen at each size (SOL), against a fixed cost of 0.000105 SOL:")
for s in sorted({r["sizeSol"] for r in rows}):
    at = [r for r in rows if r["sizeSol"] == s]
    b = max(at, key=lambda r: r["profitSol"])
    print(f"  {str(s)+' SOL':>9}: best {b['profitSol']:+.6f} SOL ({b['netPct']:+.4f}%, {b['sym']})   median {sorted(r['profitSol'] for r in at)[len(at)//2]:+.6f}   n={len(at)}")
