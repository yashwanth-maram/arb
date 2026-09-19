import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Usage: tsx src/analyze.ts [file.jsonl ...]   (default: every logs/divergence-*.jsonl)
// Thresholds are "net gap after both fees" in percent. 0 = a real opportunity; negatives = near-misses.
const THRESHOLDS = (process.env.THRESHOLDS ?? "0,-0.25,-0.5").split(",").map(Number);
const LOG_DIR = process.env.LOG_DIR ?? "logs";

type Upd = { ts: string; slot: number; lag: number; token: string; pool: string; changed: boolean;
  best: { a: string; b: string; gapPct: number; floorPct: number; netPct: number; dir: string } | null };
type Episode = { token: string; pair: string; startSlot: number; endSlot: number; startTs: string; maxNet: number; updates: number };

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(LOG_DIR).filter((f) => /^divergence-.*\.jsonl$/.test(f)).sort().map((f) => join(LOG_DIR, f));
if (files.length === 0) { console.error("no log files"); process.exit(1); }

const upds: Upd[] = [];
let hb = 0, reconnects = 0, errors = 0, maxStale = 0, firstTs = "", lastTs = "";
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let o: any; try { o = JSON.parse(line); } catch { errors++; continue; }
    if (!firstTs) firstTs = o.ts; lastTs = o.ts;
    if (o.t === "upd") upds.push(o);
    else if (o.t === "hb") { hb++; maxStale = Math.max(maxStale, o.staleSec ?? 0); reconnects = Math.max(reconnects, o.reconnects ?? 0); }
    else if (o.t === "error" || o.t === "fatal") errors++;
    else if (o.t === "reconnect") reconnects = Math.max(reconnects, o.reconnects ?? 0);
  }
}
const hours = (Date.parse(lastTs) - Date.parse(firstTs)) / 3.6e6;
const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

console.log(`files: ${files.length}  span: ${firstTs} -> ${lastTs} (${hours.toFixed(2)} h)`);
console.log(`updates: ${upds.length}  heartbeats: ${hb}  reconnects: ${reconnects}  errors: ${errors}  max stale: ${maxStale}s`);
const lags = upds.map((u) => u.lag);
console.log(`feed lag (slots): median ${pct(lags, 0.5)}  p95 ${pct(lags, 0.95)}  max ${Math.max(...lags)}`);

const byToken = new Map<string, Upd[]>();
for (const u of upds) (byToken.get(u.token) ?? byToken.set(u.token, []).get(u.token)!).push(u);

for (const [token, list] of byToken) {
  const nets = list.filter((u) => u.best).map((u) => u.best!.netPct);
  const changes = list.filter((u) => u.changed).length;
  console.log(`\n== ${token}: ${list.length} updates, ${changes} price changes (${(changes / Math.max(hours, 1e-9)).toFixed(1)}/h)`);
  console.log(`   net gap %: max ${Math.max(...nets).toFixed(3)}  p99 ${pct(nets, 0.99).toFixed(3)}  p95 ${pct(nets, 0.95).toFixed(3)}  median ${pct(nets, 0.5).toFixed(3)}`);
  const pairs = new Map<string, number>();
  for (const u of list) if (u.best) { const k = `${u.best.a} vs ${u.best.b}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
  console.log(`   best pair by frequency: ${[...pairs].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(", ")}`);

  for (const T of THRESHOLDS) {
    // An episode = a run of consecutive updates (in slot order) where the token's best net gap stays above T.
    const eps: Episode[] = [];
    let cur: Episode | null = null;
    for (const u of [...list].sort((a, b) => a.slot - b.slot)) {
      const above = !!u.best && u.best.netPct > T;
      if (above) {
        if (!cur) cur = { token, pair: `${u.best!.a} vs ${u.best!.b}`, startSlot: u.slot, endSlot: u.slot, startTs: u.ts, maxNet: u.best!.netPct, updates: 0 };
        cur.endSlot = u.slot; cur.maxNet = Math.max(cur.maxNet, u.best!.netPct); cur.updates++;
      } else if (cur) { eps.push(cur); cur = null; }
    }
    if (cur) eps.push(cur);
    const durs = eps.map((e) => e.endSlot - e.startSlot);
    const perDay = hours > 0 ? (eps.length / hours) * 24 : NaN;
    console.log(`   net > ${T}%: ${eps.length} episodes (${perDay.toFixed(1)}/day)  persistence slots: median ${pct(durs, 0.5)}  p90 ${pct(durs, 0.9)}  max ${durs.length ? Math.max(...durs) : NaN}`);
    for (const e of eps.sort((a, b) => b.maxNet - a.maxNet).slice(0, 3))
      console.log(`      ${e.startTs}  slots ${e.startSlot}-${e.endSlot} (${e.endSlot - e.startSlot})  max net ${e.maxNet.toFixed(3)}%  ${e.pair}`);
  }
}