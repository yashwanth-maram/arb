import json, glob, bisect, re, statistics as st
# After a shock, how much gap is LEFT, block by block? Same pair, same direction as the shock.
# Headline nets from the logger's snapshots, minus a worst-case haircut for DLMM one-sided bins (one bin step per DLMM leg).
KS = [0, 1, 2, 3, 5, 10]
THRESHOLDS = [1.0, 2.0, 5.0]
MAX_FEE_BPS = 500
ALIVE_WINDOW = 150  # slots: a later update from any pool must exist within this, or the logger may have been deaf

def haircut(label):
    m = re.search(r"dlmm(\d+)", label)
    return int(m.group(1)) / 100.0 if m else 0.0

by_token, all_slots = {}, []
for f in sorted(glob.glob("logs/divergence-*.jsonl")):
    for line in open(f):
        if '"t":"upd"' not in line: continue
        try: o = json.loads(line)
        except Exception: continue
        by_token.setdefault(o["token"], []).append((o["slot"], o["ts"], o["snap"]))
        all_slots.append(o["slot"])
all_slots = sorted(set(all_slots))
def alive_after(slot):
    i = bisect.bisect_right(all_slots, slot)
    return i < len(all_slots) and all_slots[i] - slot <= ALIVE_WINDOW

def nets(snap):
    ok = {l: v for l, v in snap.items() if v[1] <= MAX_FEE_BPS and v[0] > 0}
    return {(b, s): (ok[s][0] / ok[b][0] - 1) * 100 - (ok[b][1] + ok[s][1]) / 100 for b in ok for s in ok if b != s}

for token, ups in by_token.items():
    ups.sort(key=lambda u: (u[0], u[1]))
    slots, end_nets, peak = [], [], {}
    for slot, ts, snap in ups:
        n = nets(snap)
        if not n: continue
        if not slots or slots[-1] != slot: slots.append(slot); end_nets.append(n); peak[slot] = (max(n.values()), max(n, key=n.get), ts)
        else:
            end_nets[-1] = n
            if max(n.values()) > peak[slot][0]: peak[slot] = (max(n.values()), max(n, key=n.get), ts)
    print(f"\n== {token}: {len(slots)} blocks with updates")
    for T in THRESHOLDS:
        shocks = []
        for i, slot in enumerate(slots):
            pk, pair, ts = peak[slot]
            if pk < T: continue
            if i > 0 and end_nets[i - 1].get(pair, -99) >= T: continue  # not fresh: the gap was already open
            cut = haircut(pair[0]) + haircut(pair[1])
            row = []
            for k in KS:
                j = bisect.bisect_right(slots, slot + k) - 1
                row.append(end_nets[j].get(pair, float("nan")) - cut if alive_after(slot + k) else None)
            shocks.append((ts, pair, pk, cut, row))
        print(f"\n   fresh shocks with peak >= {T}%: {len(shocks)}")
        if not shocks: continue
        print(f"   {'left after':<28}" + "".join(f"{'same block' if k == 0 else '+' + str(k):>12}" for k in KS))
        for name, fn in [("median", st.median), ("best case", max)]:
            cells = []
            for c in range(len(KS)):
                vals = [r[4][c] for r in shocks if r[4][c] is not None and r[4][c] == r[4][c]]
                cells.append(f"{fn(vals):+.2f}%".rjust(12) if vals else "n/a".rjust(12))
            print(f"   {name + ' (conservative)':<28}" + "".join(cells))
        for lvl in (0.3, 1.0):
            cells = [str(sum(1 for r in shocks if r[4][c] is not None and r[4][c] > lvl)).rjust(12) for c in range(len(KS))]
            print(f"   {'shocks still above +' + str(lvl) + '%':<28}" + "".join(cells))
        print("   biggest five:")
        for ts, pair, pk, cut, row in sorted(shocks, key=lambda r: -r[2])[:5]:
            print(f"     {ts[:19]}  buy {pair[0]} > sell {pair[1]}  peak {pk:+.2f}%  haircut {cut:.1f}  ->  " + "  ".join("n/a" if v is None else f"{v:+.2f}" for v in row))
