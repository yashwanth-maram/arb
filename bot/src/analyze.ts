import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gapNetOfFees } from "./scanner/gap";
import { MAX_FEE_BPS } from "./config/watchlist";

// Usage: tsx src/analyze.ts [file.jsonl ...]   (default: every logs/divergence-*.jsonl)
// Thresholds are "net gap after both fees" in percent. 0 = a real opportunity; negatives = near-misses.
//
// Two kinds of opportunity are reported:
//   end-of-slot: the gap as it stood when a slot closed. Only these survive a slot boundary, so only these
//                are reachable for a bot that reacts to published state (our tier). Persistence is in slots.
//   intra-slot:  flashes that appeared and were closed inside one slot (shock and arb in the same block).
//                Reachable only with shred-level data. Counted, not measured for persistence.
//
// Coverage: the logger is not always listening (restarts, WiFi drops, a stopped process). Dead time runs from the last
// proof that the feed was delivering (an update, or a heartbeat that had seen a slot recently) to the next "connect"
// line, or to the end of the log. Rates per day are computed on the hours actually listened, and an episode that was
// open when the feed died is cut there instead of being stretched across the hole.
const THRESHOLDS = (process.env.THRESHOLDS ?? "0,-0.25,-0.5").split(",").map(Number);
const LOG_DIR = process.env.LOG_DIR ?? "logs";

type Snap = Record<string, [number, number, number]>; // label -> [price, feeBps, slot]
type Upd = { ts: string; slot: number; lag: number; token: string; pool: string; changed: boolean;
  best: { a: string; b: string; gapPct: number; floorPct: number; netPct: number; dir: string } | null; snap: Snap };
type SlotState = { slot: number; ts: string; net: number; pair: string; maxIntra: number; intraPair: string };
type Episode = { startSlot: number; endSlot: number; startTs: string; maxNet: number; pair: string; cut?: boolean };
type Dead = { from: number; to: number; endedBy: "connect" | "end of log" };

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(LOG_DIR).filter((f) => /^divergence-.*\.jsonl$/.test(f)).sort().map((f) => join(LOG_DIR, f));
if (files.length === 0) { console.error("no log files"); process.exit(1); }

const upds: Upd[] = [];
const dead: Dead[] = [];
let hb = 0, connects = 0, staleExits = 0, errors = 0, firstTs = "", lastTs = "";
let lastAlive = 0; // ms: the last moment we know the feed was delivering
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let o: any; try { o = JSON.parse(line); } catch { errors++; continue; }
    if (!firstTs) firstTs = o.ts; lastTs = o.ts;
    const ms = Date.parse(o.ts);
    if (o.t === "upd") { upds.push(o); lastAlive = ms; }
    else if (o.t === "hb") { hb++; lastAlive = Math.max(lastAlive, ms - (o.staleSec ?? 0) * 1000); } // staleSec = seconds since the last slot seen
    else if (o.t === "stale_exit") { staleExits++; lastAlive = Math.max(lastAlive, ms - (o.staleSec ?? 0) * 1000); }
    else if (o.t === "error" || o.t === "fatal") errors++;
    else if (o.t === "connect") {
      connects++;
      if (lastAlive && ms - lastAlive > 2000) dead.push({ from: lastAlive, to: ms, endedBy: "connect" });
      lastAlive = ms;
    }
  }
}
const firstMs = Date.parse(firstTs), lastMs = Date.parse(lastTs);
if (lastAlive && lastMs - lastAlive > 90_000) dead.push({ from: lastAlive, to: lastMs, endedBy: "end of log" });
const spanHours = (lastMs - firstMs) / 3.6e6;
const deadHours = dead.reduce((sum, d) => sum + (d.to - d.from), 0) / 3.6e6;
const hours = spanHours - deadHours; // hours actually listened: every rate below uses this
const perDay = (n: number) => (hours > 0 ? (n / hours) * 24 : NaN).toFixed(1);
const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const maxOf = (arr: number[]) => arr.reduce((m, x) => (x > m ? x : m), -Infinity); // Math.max(...arr) overflows the stack on big logs
const hm = (ms: number) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m >= 1 ? `${m} min` : `${Math.round(ms / 1000)} s`; };
// Which stretch of continuous listening a moment belongs to: the number of dead intervals that ended before it.
const stretchOf = (ms: number) => { let n = 0; for (const d of dead) if (d.to <= ms) n++; return n; };

// Best pair from a snapshot, same rule as the logger (pools above MAX_FEE_BPS excluded).
function bestFromSnap(snap: Snap): { net: number; pair: string } {
  const labels = Object.keys(snap).filter((l) => snap[l][1] <= MAX_FEE_BPS && snap[l][0] > 0);
  let best = { net: -Infinity, pair: "" };
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = snap[labels[i]], b = snap[labels[j]];
    const g = gapNetOfFees(a[0], a[1], b[0], b[1]);
    if (g.netPct > best.net) best = { net: g.netPct, pair: `${labels[i]} vs ${labels[j]}` };
  }
  return best;
}

console.log(`files: ${files.length}  span: ${firstTs} -> ${lastTs} (${spanHours.toFixed(2)} h)`);
console.log(`coverage: ${hours.toFixed(2)} h listened (${((hours / Math.max(spanHours, 1e-9)) * 100).toFixed(1)}% of the span)  dead time: ${hm(deadHours * 3.6e6)} in ${dead.length} intervals  connects: ${connects}  stale exits: ${staleExits}`);
for (const d of [...dead].sort((a, b) => (b.to - b.from) - (a.to - a.from)).filter((d) => d.to - d.from >= 30_000).slice(0, 5))
  console.log(`   dead: ${new Date(d.from).toISOString().slice(0, 19)}Z -> ${new Date(d.to).toISOString().slice(0, 19)}Z  (${hm(d.to - d.from)}, until ${d.endedBy})`);
console.log(`updates: ${upds.length}  heartbeats: ${hb}  errors: ${errors}   rates below are per day of listening`);
const lags = upds.map((u) => u.lag);
console.log(`feed lag (slots): median ${pct(lags, 0.5)}  p95 ${pct(lags, 0.95)}  max ${maxOf(lags)}`);

const byToken = new Map<string, Upd[]>();
for (const u of upds) (byToken.get(u.token) ?? byToken.set(u.token, []).get(u.token)!).push(u);

for (const [token, list] of byToken) {
  list.sort((a, b) => a.slot - b.slot || a.ts.localeCompare(b.ts));
  const changes = list.filter((u) => u.changed).length;
  console.log(`\n== ${token}: ${list.length} updates, ${changes} price changes (${(changes / Math.max(hours, 1e-9)).toFixed(1)}/h)`);

  // One state per slot that had updates: the gap when the slot closed, plus the best flash seen inside it.
  const slots: SlotState[] = [];
  for (const u of list) {
    const last = slots[slots.length - 1];
    const intra = u.best ? u.best.netPct : -Infinity;
    if (!last || last.slot !== u.slot) {
      const b = bestFromSnap(u.snap);
      slots.push({ slot: u.slot, ts: u.ts, net: b.net, pair: b.pair, maxIntra: intra, intraPair: u.best ? `${u.best.a} vs ${u.best.b}` : "" });
    } else {
      const b = bestFromSnap(u.snap);
      last.net = b.net; last.pair = b.pair;
      if (intra > last.maxIntra) { last.maxIntra = intra; last.intraPair = u.best ? `${u.best.a} vs ${u.best.b}` : ""; }
    }
  }
  const endNets = slots.map((s) => s.net).filter(Number.isFinite);
  console.log(`   end-of-slot net gap %: max ${maxOf(endNets).toFixed(3)}  p99 ${pct(endNets, 0.99).toFixed(3)}  p95 ${pct(endNets, 0.95).toFixed(3)}  median ${pct(endNets, 0.5).toFixed(3)}   (${slots.length} slots with updates)`);

  for (const T of THRESHOLDS) {
    // End-of-slot episodes: from the first slot that closed above T to the first later slot that closed at or below T.
    const eps: Episode[] = [];
    let cur: Episode | null = null;
    let stretch = -1;
    for (const s of slots) {
      const st = stretchOf(Date.parse(s.ts));
      if (cur && st !== stretch) { cur.cut = true; eps.push(cur); cur = null; } // the feed died while it was open: we never saw it close
      stretch = st;
      if (s.net > T) {
        if (!cur) cur = { startSlot: s.slot, endSlot: s.slot, startTs: s.ts, maxNet: s.net, pair: s.pair };
        else { cur.endSlot = s.slot; if (s.net > cur.maxNet) { cur.maxNet = s.net; cur.pair = s.pair; } }
      } else if (cur) { cur.endSlot = s.slot; eps.push(cur); cur = null; }
    }
    if (cur) eps.push(cur);
    const cut = eps.filter((e) => e.cut).length;
    const durs = eps.filter((e) => !e.cut).map((e) => e.endSlot - e.startSlot); // persistence only where we saw the end
    // A flash: the gap peaked above T inside the slot but had closed by at least 0.1 points when the slot ended.
    const flashes = slots.filter((s) => s.maxIntra > T && s.maxIntra > s.net + 0.1);
    console.log(`   net > ${T}%: end-of-slot ${eps.length} episodes (${perDay(eps.length)}/day), persistence slots median ${pct(durs, 0.5)} p90 ${pct(durs, 0.9)} max ${durs.length ? maxOf(durs) : NaN}${cut ? ` (${cut} cut by dead time)` : ""};  intra-slot flashes ${flashes.length} (${perDay(flashes.length)}/day)`);
    for (const e of [...eps].sort((a, b) => b.maxNet - a.maxNet).slice(0, 3))
      console.log(`      survived: ${e.startTs}  slots ${e.startSlot}-${e.endSlot} (${e.endSlot - e.startSlot}${e.cut ? "+, cut by dead time" : ""})  max net ${e.maxNet.toFixed(3)}%  ${e.pair}`);
    for (const s of [...flashes].sort((a, b) => b.maxIntra - a.maxIntra).slice(0, 3))
      console.log(`      flash:    ${s.ts}  slot ${s.slot}  peak ${s.maxIntra.toFixed(3)}% -> closed at ${s.net.toFixed(3)}%  ${s.intraPair}`);
  }
}
