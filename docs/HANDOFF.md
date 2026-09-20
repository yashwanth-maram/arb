# arb — Handoff for a fresh chat (written 2026-09-20, day 2, after Step 8.7)

Read this first. The full living reference is the Claude Doc
"Solana Atomic Arbitrage — Project Reference & Build Log":
https://claude.ai/code/artifact/c15ccfd7-517b-480a-b110-6ed3fe3f7748
(19 sections; section 16 = checkpoint log, newest first; 17 = decision log D1-D16; 12 = metrics.) Open it only for specifics.

## 1. What this project is
Zero-cash-budget Solana atomic arbitrage, built from India, by one person learning as he builds.
Rules that do not change: bundles only (Jito), profit assertion on-chain, flash loans for working capital,
no sandwiching, no code from random repos, no keys in chat/doc/git, every level funded only by prior profit.
Ladder: Level 0 (prove an edge, $0) -> Level 1 (first landed bundle, dust SOL from a Superteam bounty) -> Level 2+.
Polymarket is prohibited in India (May 2026): excluded. Arena = Solana DEX atomic arb.

## 2. Working method (keep exactly this)
- One substep per reply. Give exact commands, expected output, and "report back". Wait for the pasted output before the next step.
- Verify before moving on. The assistant tests every file first in its own sandbox with the same pinned deps (npm ci on the repo zip).
  The sandbox cannot reach mainnet: real bytes come from the laptop (npm run snapshot), and network code is tested against a local
  fake RPC (HTTP + WebSocket) that serves the snapshot and can go silent.
- Delivery that works: one `cat > path <<'EOF' ... EOF` block per file, pasted into the terminal from ~/arb/bot; then `wc -l` against the
  expected counts; then `npm run typecheck`, `npm test`; commit only when green. Whole-file replacement for anything big. For a two-line
  change, a `python3 - <<'EOF'` patch that asserts exactly one match before writing. New npm scripts via `npm pkg set scripts.x="tsx src/x.ts"`.
- Plain language; the owner is a beginner with the CLI. When he asks "what do I do now", give numbered click-by-click steps.
- Owner runs git from ~/arb and npm from ~/arb/bot. He pastes terminal output, often only part of what was asked: fold a safe
  `git add -A && git commit ...; git push` for the previous step into the next step ("nothing to commit" is fine), and re-ask briefly.
- After each step, update the reference doc: section 16 (record), 17 (decisions), 12 (metrics), tick Week 1 tasks in 15.
- Honesty about odds: the plan is designed to discover cheaply whether an edge exists; say so.

## 3. Environment (laptop, dev only; never holds real keys)
- HP Victus, i5-13420H, 15.6 GB RAM, Windows 11 Home 25H2, 30 Mbps WiFi. WSL2 Ubuntu 24.04.5 on D:, user arb, Windows user admin.
  Terminal clock is UTC. Project at ~/arb (Linux FS). VS Code via WSL. Windows sleep disabled; lid = do nothing.
- Toolchain: rustc/cargo 1.98.1, solana-cli 4.1.2 (Agave), anchor-cli 1.2.0 (avm; NEVER run `avm use`), Node v24.21.0, TypeScript 5.9.3,
  tsx 4.23.13, vitest 5.0.1. ops/setup.sh reproduces the Linux side.
- Repo: github.com/yashwanth-maram/arb (private), SSH key arb-dev-laptop. Helius free-plan key only in bot/.env as HELIUS_API_KEY.
- Helius free plan (docs read 2026-09-20): 1M credits/month, 10 RPC req/s, 5 WebSocket connections, 1,000 subscriptions each;
  every standard RPC call = 1 credit whatever the size; WebSocket data is metered at 2 credits per 0.1 MB. The logger streams roughly
  260 MB/day (about 5-6k credits/day by estimate). Confirmed on the dashboard 2026-09-20: 4,740 credits used after the first day (logger, reconcile probes, all one-off reads).
- Logger, 24/7: start `cd ~/arb && nohup ops/run_logger.sh > /dev/null 2>&1 &`
  restart `cd ~/arb && ops/stop_logger.sh; sleep 3; pkill -9 -f "feed/logger.ts"; sleep 1; nohup ops/run_logger.sh > /dev/null 2>&1 &`
  health `tail -n 1 ~/arb/bot/logs/divergence-$(date -u +%F).jsonl | cut -c1-120`; supervisor log bot/logs/logger.out.
  The first heartbeat comes 60 s after a start: wait 70 s before looking for it. Logs are git-ignored (about 65 MB/day); a new file starts at 00:00 UTC.
- Crash-only recovery (D15): no slot for 15 s -> one `stale_exit` line, exit code 2, the supervisor starts a fresh process (10 s wait,
  doubling to 60 s while runs keep failing). Exit codes: 0 asked to stop, 1 could not start, 2 silent feed.
- Zip for a chat upload: `cd ~/arb && git archive --format=zip -o ~/arb-codebase.zip HEAD && cd ~ && explorer.exe .` then drag the zip into the chat.

## 4. Codebase map (all in bot/ unless noted; tests: 43 passing)
- src/decoders/meteora_dlmm.ts: decodeDlmmPool (summary) + decodeDlmmRaw, decodeBinArray, decodeBitmapExtension, summarizeDlmm.
- src/decoders/meteora_damm_v2.ts: decodeDammV2Pool (summary) + decodeDammV2Raw, summarizeDammV2. Its totalFeeBps is a WORST CASE.
- src/quoter/types.ts: Clock {slot, unixTime}, Side (buy = SOL in, sell = token in), LegQuote, effectivePrice, solToLamports.
- src/quoter/damm_v2.ts: quoteDammV2 via SDK getSwapResultFromExactInput; currentPoint picks slot or unix time per pool.
- src/quoter/dlmm_accounts.ts: binArrayIndexesForSwap / BothWays (bitmap walk), binArrayAddress, bitmapExtensionAddress, DLMM_PROGRAM_ID.
- src/quoter/dlmm.ts: quoteDlmm = SDK swapQuote on a DLMM object built offline; pins Date.now to the clock; fee = LP + protocol part.
- src/quoter/pair.ts: QuotablePool, dlmmQuotable, dammQuotable, roundTrip (spend S SOL on A, sell all tokens on B; null + reason if
  unfillable), allRoundTrips (pools above MAX_FEE_BPS left out), bestPerSize.
- src/quoter/fetch_depth.ts: fetchDepthSnapshot = everything for the watchlist at ONE slot (two passes, retry if a pool moved).
- src/quoter/snapshot.ts: decodeDepthSnapshot (from memory), loadDepthSnapshot (from file) -> ready-to-quote states by label.
- src/depth.ts (`npm run depth`, FIXTURE=1 offline): a ladder per pool + a between-pools table (dust, 0.1, 0.5, 2 SOL; * = best).
- src/fetch_depth_snapshot.ts (`npm run snapshot`): verification printout, saves to logs/depth_snapshot-<slot>.json.
  The pinned fixture test/fixtures/depth_snapshot.json (slot 448478047) is only replaced on purpose with OUT=.
- src/feed/probe.ts: ProbeGate, bestPairAtBaseFees (trigger), probeArrayIndexes, probeToken (one getMultipleAccounts read, best per size).
- src/probe_once.ts (`npm run depthprobe`): times probe reads warm/cold. NOTE `npm run probe` is the old 2-minute WebSocket probe.
- src/feed/logger.ts: 24/7 logger. Line types: start, connect, base, upd (spot best pair at stored fees + snapshot), hb (updates,
  opportunities = quote-level count, probes, probeSkips, staleSec), probe, probe_error, stale_exit, stop, fatal, error; old files also have reconnect.
  Probe line: {t:"probe", token, trigSlot, slot, ms, accounts, kb, trig:{a,b,dir,netBase,net}, best:{"0.001"|"0.1"|"0.5"|"2":{net,buy,sell}}, unfilled?, note?}.
  Env: PROBES=0, PROBE_THRESHOLD (-0.25), PROBE_MIN_INTERVAL_MS (2000), PROBE_MAX_PER_HOUR (300), STALE_SECONDS (15), STARTUP_SECONDS (60).
- src/analyze.ts (`npm run analyze`): coverage-aware (dead time = last proof of life to the next connect; rates per listened day; episodes
  cut at dead time; no Math.max(...big)). It does not read probe lines yet (Step 8.8).
- src/scanner/gap.ts, best_pair.ts, src/config/watchlist.ts (six pools, MAX_FEE_BPS 500, WSOL), src/reconcile_probe.ts, fixtures of slot 448334506.
- Tests: decoders 10, best_pair 2, quoter_damm_v2 7, dlmm_accounts 3, quoter_dlmm 8, pair 5, probe 8.
- npm scripts: hello, fixtures, decode, decode:dlmm, decode:rpc, probe, logger, analyze, reconcile, depth, snapshot, depthprobe, test, typecheck.
- Commits: 8.1 967b581, 8.2 25c4174, 8.3 ac4042a, 8.4 e867204; run `git log --oneline -12` for L2, L3, 8.5, 8.6, 8.7.

## 5. Watchlist
| Token | Venue | Pool | Fee |
|---|---|---|---|
| PERPSPAD (`PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL`, 6 dec) | DLMM bin 80 | `EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr` | 0.8% + variable |
| PERPSPAD | DAMM v2 | `84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ` | 1.0% fixed + dynamic |
| PEPE (`PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m`, 4 dec) | DLMM bin 80 | `C1baVnbBd31ucGqvuKgeghtyX6Xpnq5cXxamLqXi9hVN` | 1.0% + variable |
| PEPE | DLMM bin 20 | `HDojZeCdUee8nczxsc9MeiMKVF961HqEFeKEvHw74xVR` | 0.2% |
| PEPE | DAMM v2 damm1 | `GRNVafZv78DndVua7phP9BFGmmFxJ9r58wBEakDyfsCg` | 45% really charged: excluded |
| PEPE | DAMM v2 damm2 | `ED6PwhyCQ52CQa9V58yy9BTVi9NdVCSVAWWiL1ZzAXhX` | 1.0% |
Quote token wSOL `So11111111111111111111111111111111111111112`; prices are SOL per token. All three DLMM pools: X = token, Y = SOL,
limit orders on, no bitmap extension. PERPSPAD damm: A = PERPSPAD, B = SOL, activationType 1 (unix seconds), collectFeeMode 1.

## 6. Findings so far (all measured)
- Feed: free Helius WebSocket at slot lag 0 (max 8), one notification per transaction. Probe reads take 0.2-0.4 s, warm or cold.
- First coverage-aware reading (to 2026-09-20 05:48Z, 16.39 h listened of 21.59 h): PEPE 102 end-of-slot episodes at net > 0 (149/day),
  persistence median 10 slots, p90 173, max 1538; 141 flashes (207/day) up to +14.6%, all closed in-slot; PERPSPAD 0 episodes, 18 flashes.
  ALL of this is quote-level. Earlier reconciliations: same-slot winner Mriy...Qu7X takes big gaps; >=5 programs probe crumbs every slot.
- Depth (slot 448478047 and live): PEPE dlmm80 asks are thin (0.06 SOL in the active bin) and its bids fine; dlmm20 deep both sides;
  damm2 costs about 0.2% a leg at 0.5 SOL and 0.8% at 2 SOL; damm1 pays 4,500 bps each way. Direction decides: buy dlmm20 -> sell dlmm80
  was -0.86% / -0.86% / -0.93% at 0.1 / 0.5 / 2 SOL while the opposite direction was -2.11% / -3.93% / -10.29%.
- The active-bin phantom (06:00Z 09-20): headline measure +0.13% net (dlmm80 vs dlmm20) while the executable net at dust was -0.686%.
  dlmm80's active bin held SOL but no PEPE, so the first PEPE for sale sat one bin (0.8%) higher. A DLMM active-bin price is not a two-sided
  quote. The headline counter then showed 1,031 "opportunities" in 32 minutes. This probably explains many long PEPE episodes.
- A DLMM pool stores the variable fee of its last swap; after a quiet spell a new swap pays less (97.46 -> 80 bps in an hour), so stored fees
  can hide a gap. Probes therefore trigger on base fees.
- Conclusion so far: Meteora pools of popular memecoins are saturated; nothing executable has been seen yet; the remaining candidate edge is
  coverage (pools the bots are not subscribed to). Probes now measure the executable side of every headline episode.

## 7. Position on the roadmap
Level 0. Done: research + doc, environment, pools, decoders, logger (crash-only since L2), coverage-aware analysis (L3), reconcile probe,
Step 8.1-8.7 (both quoters, depth report, snapshot, pair round trips, depth probes in the logger). Decisions added: D15 (crash-only logger),
D16 (on-demand probes, not streamed bin arrays). Week 1 tasks (doc section 15): 1-6 done; 7 ANB note, 8 Superteam Earn, 9 Dune winner query pending.
Week 1 review = Checkpoint 2 on 2026-09-26 (D14, tier decision). Alpenglow mainnet activation begins 2026-09-28.

## 8. Immediate next steps, in order
1. Let probes accumulate (logger restarted with probes 2026-09-20 06:26Z). Health: heartbeats show probes and probeSkips; count
   `grep -c '"t":"probe"'` and `'"t":"probe_error"'` in today's log; paste `tail -n 5` of the probe lines for the assistant.
2. Step 8.8: analyze.ts joins probes to headline episodes. For each end-of-slot episode (net > 0 and > -0.25%), attach probes whose trigSlot
   falls inside it; report episodes probed, the share with executable net > 0 at dust / 0.1 / 0.5 / 2 SOL, the phantom size
   (headline net minus executable dust net) by pair and direction, probe ms and slot lag (slot - trigSlot), and error counts.
3. Helius credits: 4,740 used after day 1 (2026-09-20), in line with the estimate. Look again once a week.
4. Coverage test: long-tail candidates (both pool types, TVL $10-50K, modest volume, SPL Token, freeze disabled) from
   dlmm.datapi.meteora.ag / damm-v2.datapi.meteora.ag; reconcile probe on idle windows; the same depth tools apply once pools join the watchlist.
5. Week 1 tasks 7-9, then the Week 1 review on 2026-09-26 (D14).
6. Then router/sizer -> shadow reconciliation (win-rate) -> Rust on-chain program (flash-borrow, swap, swap, repay, assert).

## 9. Pitfalls already paid for (do not repeat)
- web3.js removeAccountChangeListener / removeSlotChangeListener can wait forever on a dead socket. Never await them without a time limit;
  the logger exits instead of reconnecting (D15). In bash, `$?` after a `$(date)` in the same echo is the exit code of date: capture `code=$?` first.
- Never overwrite a running bash script in place: write file.new, then mv. `pkill -f pattern` also kills the shell running it when the pattern
  appears in that shell's own command line: run such tests from a script file, or write the pattern as `logge[r].ts`.
- Math.max(...list) overflows the stack near 300,000 items: use a loop. analyze.ts holds all updates in memory (fine for a week, not for a month).
- DAMM v2: activationType 0 = slots, 1 = unix seconds; pass the matching currentPoint or the SDK throws "Swap is disabled". The decoder's
  totalFeeBps is the worst case; the fee a trade pays comes from a quote. Base fee bytes are pod-aligned (getBaseFeeHandlerFromPodAlignedData).
- DLMM: price = (1 + binStep/10000)^activeId x 10^(decX-decY); LbPair 904 bytes, BinArray 10,136 bytes (70 bins x 144), DAMM v2 Pool 1,112 bytes;
  bins hold LP liquidity plus limit orders (use getBinMaxAmountOut); swapQuote reads Date.now() and returns LP fee and protocolFee separately;
  the active bin can be one-sided; the stored variable fee is stale after quiet periods; default import `DLMM` works under tsx and vitest.
- Two 1% fees cost -1.990%, not -2.000%. Anchor's accounts encoder has a 1,000-byte buffer (cannot encode a bin array).
- cpAmmCoder returns snake_case and needs account name Pool: decode through new Program(CpAmmIdl, provider). vitest config must be .mts.
- Read decimals from the mint (byte 44); PEPE has 4. Flip the price when SOL is on the X/A side.
- Never paste base64 fixtures into a chat: zip the repo and upload. `npm run snapshot` writes to logs/ by default.
- Helius free plan: 429 on big getParsedTransactions batches (20 per call + 400 ms sleep); maxSupportedTransactionVersion: 1.
  One slow network minute made probe reads exceed 5 s (now 15 s limit, duration recorded). IPv6 is dead inside WSL: `curl -4`.
- `npm run` only works inside bot/. A garbled echo of a pasted command is harmless when the output below it is right.

## 10. How to start the fresh chat
Paste: this file, the doc link above, a fresh zip of the repo (section 3), the latest `npm run analyze` output and the last five probe lines.
Then say: "Continue from HANDOFF.md; the next step is 8.8 (join probes to episodes)." Keep the one-substep-per-reply method.
