# arb — Handoff for a fresh chat (written 2026-09-19, end of day 1 of building)

Read this first. The full living reference is the Claude Doc
"Solana Atomic Arbitrage — Project Reference & Build Log":
https://claude.ai/code/artifact/c15ccfd7-517b-480a-b110-6ed3fe3f7748
(19 sections; section 16 = checkpoint log, 17 = decision log D1–D13, 12 = metrics.) Open it only for specifics.

## 1. What this project is
Zero-cash-budget Solana atomic arbitrage, built from India, by one person learning as he builds.
Rules that do not change: bundles only (Jito), profit assertion on-chain, flash loans for working capital,
no sandwiching, no code from random repos, no keys in chat/doc/git, every level funded only by prior profit.
Ladder: Level 0 (prove an edge, $0) → Level 1 (first landed bundle, dust SOL from a Superteam bounty) → Level 2+.
Polymarket is prohibited in India (May 2026): excluded. Arena = Solana DEX atomic arb.

## 2. Working method (keep exactly this)
- One substep per reply. Give exact commands, expected output, and "report back". Wait for the pasted output before the next step.
- Verify before moving on. Test code in your own sandbox first when possible (the same pinned deps can be installed there).
- Plain language; the owner is a beginner with the CLI. When he says "I can't understand", give click-by-click steps.
- Owner runs `git` from `~/arb` and `npm` from `~/arb/bot`. He pastes terminal output; read it carefully, errors included.
- After each checkpoint, update the reference doc: section 16 (checkpoint entry), 17 (decisions), 12 (metrics), tick Week 1 tasks in 15.
- Honesty about odds: the plan is designed to discover cheaply whether an edge exists; say so.

## 3. Environment (laptop, dev only; never holds real keys)
- HP Victus, i5-13420H (8c/12t), 15.6 GB RAM, RTX 2050 (unused), Windows 11 Home 25H2, 30 Mbps WiFi.
- WSL2 (2.7.14) Ubuntu 24.04.5 installed on D: (`D:\WSL\Ubuntu-24.04`), user `arb`. `.wslconfig`: memory 8GB, processors 8, swap 8GB on D:.
- Project at `~/arb` (Linux FS). VS Code connected via WSL. Windows sleep disabled; lid = do nothing.
- Toolchain: rustc/cargo 1.98.1, solana-cli 4.1.2 (Agave, via `agave-install init 4.1.2`), anchor-cli 1.2.0 (avm 1.2.0),
  Node v24.21.0, yarn 1.22.22, TypeScript 5.9.3, tsx 4.23.13, vitest 5.0.1. `ops/setup.sh` reproduces the Linux side.
- Anchor launcher bug workaround: `~/.avm/bin/anchor` is a symlink to `anchor-1.2.0`. NEVER run `avm use`.
- Repo: github.com/yashwanth-maram/arb (private), SSH key `arb-dev-laptop`, commits with GitHub no-reply email.
- Helius free plan key lives only in `bot/.env` as `HELIUS_API_KEY` (git-ignored). `bot/.env.example` is the template.
- Logger runs 24/7 on the laptop: start `cd ~/arb && nohup ops/run_logger.sh > /dev/null 2>&1 &`; stop `ops/stop_logger.sh`;
  health `tail -1 ~/arb/bot/logs/divergence-$(date -u +%F).jsonl | cut -c1-120`. Logs are git-ignored (~20 MB/day).

## 4. Codebase map (all in `bot/` unless noted; tests: 12 passing)
- `src/decoders/meteora_dlmm.ts` — LbPair bytes → price from active bin, base + variable fee (bps). Uses SDK `decodeAccount`.
- `src/decoders/meteora_damm_v2.ts` — Pool bytes → price from sqrtPrice, base fee (pod-aligned handler), dynamic fee. Decodes via Anchor `Program(CpAmmIdl)`.
- `src/scanner/gap.ts` — `gapNetOfFees(priceA, feeA, priceB, feeB)` → gapPct, feeFloorPct, netPct, direction.
- `src/scanner/best_pair.ts` — best pair per token from snapshots; pools with fee > `MAX_FEE_BPS` (500) excluded.
- `src/config/watchlist.ts` — the six pools (below), grouped by token.
- `src/feed/ws_probe.ts` — 2-minute live probe. `src/feed/logger.ts` — 24/7 logger: 1 JSON line per pool update
  (slot, lag, price, fee, changed, best pair net of fees, snapshot of the token's pools), heartbeat 60 s, watchdog reconnect
  after 15 s without slot updates (guarded), daily file `logs/divergence-YYYY-MM-DD.jsonl`, clean stop.
- `src/analyze.ts` — from the log: end-of-slot episodes (survive a slot boundary; persistence in slots) vs intra-slot flashes,
  at thresholds 0 / −0.25 / −0.5 % net. Run: `npm run analyze`.
- `src/reconcile_probe.ts` — `TOKEN=PEPE FROM_SLOT=a TO_SLOT=b npm run reconcile`: every tx touching the token's pools in the range;
  signer, pools touched, programs, Jito tip, fee, CU, SOL/token deltas; per-slot ok/failed; per-signer summary. Chunks of 20, retries on 429.
- `src/fetch_fixtures.ts` + `test/fixtures/*.json` (slot 448334506), `src/decode_fixtures.ts`, `src/decode_dlmm.ts`, `src/decode_rpc.ts`, `src/hello.ts`.
- `vitest.config.mts` aliases both Meteora SDKs to their CommonJS builds (their ESM build breaks under Node).
- Repo root: `ops/setup.sh`, `ops/run_logger.sh`, `ops/stop_logger.sh`, `research/candidates_*.tsv`, `README.md`, `.gitignore`.
- npm scripts: hello, fixtures, decode, decode:dlmm, decode:rpc, probe, logger, analyze, reconcile, test, typecheck.

## 5. Watchlist (Step 2 record)
| Token | Venue | Pool | Fee |
|---|---|---|---|
| PERPSPAD (`PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL`, 6 dec) | Meteora DLMM bin 80 | `EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr` | 0.8% + variable |
| PERPSPAD | Meteora DAMM v2 | `84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ` | 1.0% fixed + dynamic |
| PEPE (`PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m`, 4 dec) | DLMM bin 80 | `C1baVnbBd31ucGqvuKgeghtyX6Xpnq5cXxamLqXi9hVN` | 1.0% |
| PEPE | DLMM bin 20 | `HDojZeCdUee8nczxsc9MeiMKVF961HqEFeKEvHw74xVR` | 0.2% |
| PEPE | DAMM v2 "damm1" | `GRNVafZv78DndVua7phP9BFGmmFxJ9r58wBEakDyfsCg` | 45% — launch-fee trap, excluded from pairing |
| PEPE | DAMM v2 "damm2" | `ED6PwhyCQ52CQa9V58yy9BTVi9NdVCSVAWWiL1ZzAXhX` | 1.0% |
Quote token: wSOL `So11111111111111111111111111111111111111112`. Prices are normalised to SOL per token.
Fee floors: PERPSPAD pair 1.8%; PEPE dlmm20↔damm2 1.2%; dlmm80↔dlmm20 1.2%.

## 6. Findings so far (all measured, 2026-09-19)
- Free Helius WebSocket delivers updates at slot lag 0 (median and max), one notification per transaction (not per slot).
- PERPSPAD: in 8.4 h, 0 opportunities survived a slot boundary; 6 intra-slot flashes up to +3.48% net, all closed in-slot.
  First one reconciled: shock = 651K PERPSPAD sold via Jupiter; winner `Mriy…Qu7X` (program `AN22…EgCR`) in the SAME slot,
  54,077 CU, no Jito tip, profit +0.0204 SOL (~$2.30); 178 failed competitor txs vs 6 successes (spam bot `ALVaRo…` 108 fails).
- PEPE: 9 end-of-slot episodes / 8.4 h (25.6/day), median persistence 6 slots, one of 191 slots (+0.68%). 14 flashes/day.
  Flash reconciled: same winner `Mriy…` paid a 7.48M-lamport priority fee for +0.022 SOL gross. The 191-slot "crumb" was probed
  every slot by ≥5 arb programs (`6666…rjRH`/`HiPM…Prkf`, `BTpD…U79U`/`kyxs…wXXS` incl. a Raydium CLMM PEPE pool, others) at ~$0.0007
  per probe and they took nothing: the gap existed at the active-bin quote but was NOT executable (thin bins). **Depth problem.**
- Conclusions: (1) Meteora pools of popular memecoins are saturated at every level (same-slot bots for big gaps, continuous probing
  for crumbs). (2) Our gap measure must be depth-aware (quote real output for 0.1/0.5/2 SOL through DLMM bin arrays and the DAMM v2
  curve) before any episode count is trusted. (3) Remaining candidate edge = coverage: pools those programs are not subscribed to;
  testable with the reconcile probe (zero probe txs in an idle window).

## 7. Position on the roadmap
Level 0. Done: research + doc, environment, token/pools, decoders + tests, logger running 24/7, analysis, reconcile probe.
Week 1 tasks (doc §15): 1–6 done; 7 ANB note (`research/anb.md`), 8 Superteam Earn signup/bounty, 9 Dune winner query: pending.
Week 1 review = Checkpoint 2 on 2026-09-26. Alpenglow mainnet activation begins 2026-09-28. D14 (tier change) pending data.

## 8. Immediate next steps, in order
1. 24-hour reading: `cd ~/arb/bot && npm run analyze`; record in doc §16/§12.
2. Step 8 = depth-aware quote: DLMM `swapQuote` with bin arrays (SDK) and DAMM v2 `swapQuoteExactInput`; add "executable net
   for 0.1 / 0.5 / 2 SOL" to the logger lines; re-run analysis; expect most PEPE "episodes" to vanish.
3. Coverage test: pick long-tail candidates (both pool types, TVL $10–50K, modest volume, SPL Token, freeze disabled) from
   `dlmm.datapi.meteora.ag` / `damm-v2.datapi.meteora.ag` (legacy dlmm-api is 404); run the reconcile probe on idle windows.
4. Decide D14 at the Week 1 review with those results.
5. Then router/sizer → shadow reconciliation (win-rate) → Rust on-chain program (flash-borrow, swap, swap, repay, assert).

## 9. Pitfalls already paid for (do not repeat)
- `npm run` only works inside `bot/`. tsconfig uses `module: node18`, `types: ["node"]`, `noEmit` (older `moduleResolution: node` breaks VS Code's TS).
- Meteora `cpAmmCoder` returns snake_case and needs account name `Pool`; decode through `new Program(CpAmmIdl, provider)` instead (camelCase, name `pool`).
- DAMM v2 base fee is pod-aligned bytes: use `getBaseFeeHandlerFromPodAlignedData(...).getMin/MaxFeeNumerator()`.
- DLMM price = (1 + binStep/10000)^activeId × 10^(decX−decY); fee helpers return values scaled by 1e9; SDK `LbPair` = 904 bytes, DAMM v2 `Pool` = 1,112 bytes (check after SDK upgrades).
- Read decimals from the mint (byte 44); PEPE has 4, not 6. Flip the price when SOL is on the X/A side.
- Downloads: `curl -4 --connect-timeout 30 --retry 5 --retry-all-errors`; IPv6 is dead inside WSL; one CDN route black-holed for 300 s.
- Helius free plan: 429 on big batches → 20 txs per `getParsedTransactions` + 400 ms sleep. Transactions now have version 1: `maxSupportedTransactionVersion: 1`.
- Never pipe a `curl --retry` into `head` (spams write errors); save to a file first.
- Local validator: `solana-test-validator --reset --url https://api.mainnet-beta.solana.com --clone <acct> ...` works; local keypair `~/.config/solana/id.json` is localnet-only.
- The vitest config must be `.mts`; the SDK ESM builds fail under Node's loader.
- Watchdog reconnects must be guarded against overlap (fixed). `fatal: fetch failed` at start = no internet; the supervisor restarts it.

## 10. How to start the fresh chat
Paste: this file, the doc link above, the zip of the repo, and the latest `npm run analyze` output. Then say:
"Continue from HANDOFF.md; the next step is 8.1 (depth-aware quote) unless the 24-hour reading changes it." Keep the one-substep-per-reply method.
