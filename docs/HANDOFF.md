# arb — Handoff (written 2026-09-21, end of day 3)

Full reference, with every measurement and decision:
https://claude.ai/code/artifact/c15ccfd7-517b-480a-b110-6ed3fe3f7748
Section 16 = build log, newest first. 17 = decisions. 12 = metrics.

## 1. The goal
Turn $5 into $100 by trading on Solana, from a laptop in India, with tools built from scratch.
Rules: no investment beyond $1-$5 until $100 of profit exists; atomic trades only; profit assertion on-chain;
no keys on the laptop; prediction markets excluded (prohibited in India).

## 2. Where it stands
THIRTEEN independent measurements, none executable. The system is complete and verified; the market does not pay it.
Best result ever recorded with a chain-enforced check: 5,000 lamports on a 2 SOL stake, which equals the cost of
landing. Closest on a wide route: -0.0076%.

## 3. What was built, and works
Measurement side
- src/feed/logger.ts         24/7 logger, crash-only recovery (exit 2 on a silent feed), supervised by ops/run_logger.sh
- src/decoders/              Meteora DLMM and DAMM v2, byte-exact
- src/quoter/                SDK-exact quotes at any size; pair.ts does executable round trips
- src/feed/probe.ts          on-demand depth probes (gate, base-fee trigger, one-read probe)
- src/analyze.ts             coverage-honest analysis; reads probe lines and joins them to episodes
- src/research/              the whole investigation (see section 5)

Execution side, the rare part
- src/exec/weld.ts           two Jupiter swaps composed into ONE transaction; route-width ladder 14/12/10/8;
                             uses Jupiter's own lookup tables; requireLamportsOut adds OUR profit check
- src/exec/simulate.ts       simulateTransaction against live state; measures the trade's own wrapped-SOL account
- src/exec/shadow.ts         free bets: build, enforce, simulate, ladder the win; never throws, always a verdict
- src/exec/find_payer.ts     a funded public payer (getLargestAccounts is not on the Helius free plan)
- src/exec/find_clean_payer.ts  a payer with NO wrapped-SOL account, required for the check to bite
- src/exec/dump_tx.ts        prints every instruction and the chain logs; says whether the check is present
- src/exec/profit_floor.ts   controls: demand 20/5/1% and confirm all revert

THE PROFIT CHECK, in one paragraph: after both swaps, a plain SPL token Transfer moves stake+floor of wrapped SOL
out of the trade's own account. The token program refuses to move more than is there, and one failed instruction
reverts the whole transaction. So a trade either pays the floor or costs ~5,000 lamports. No program of our own,
no deployment. Verified by controls: an impossible demand always reverts, a known loser (PEPE, -3%) reverts at the
smallest possible demand, USDC paid 5,000 and refused 10,000.

## 4. npm scripts
hello fixtures decode decode:dlmm decode:rpc probe logger analyze reconcile depth snapshot depthprobe
jup candidates candidates:depth diverge newpool newborn triangle sizes autopsy width
exec:probe exec:weld exec:sim exec:payer exec:clean exec:floor exec:ladder exec:dump exec:noise
test typecheck                                   (npm only works from bot/)

## 5. The thirteen measurements
 1. Meteora spot, 444 depth probes, 23 h          0 executable; best -0.218%       PAY
 2. Size ladder to 50 SOL                          profit peaks at 2 SOL, then falls PAY
 3. Long-tail pairs                                2 of 2,700 qualify, both one-sided
 4. Whole market via Jupiter, 365 round trips      best ~ +0.02%                    PAY
 5. Shock residuals, 44 fresh shocks               0 left after 1 block             REACH
 6. Liquidations (published census)                ~$324-758/month for EVERYONE     PAY
 7. Enforced free bets, 124 attempts               best 5,000 lamports on 2 SOL     PAY
 8. ANB divergence across 1,400 pools              0 of 10 executable; stranded pools
 9. Triangles, 10 verified                         -0.47% to -4.29%                 3 fees + thin middle leg
10. Size regime, 257 quotes                        at 0.042 SOL even p90 is negative
11. Candidate autopsy                              JEANPHIL was Token-2022; STONK flickers with the route
12. Width premium                                  wide routes FIT (Jupiter ships tables); 0 of 12 enforced
13. Newborn pools                                  built, not yet run

## 6. Rules learned, in order of usefulness
1. THE INSTRUMENT IS WRONG MORE OFTEN THAN THE MARKET IS GENEROUS. Ten headline numbers were wrong on first
   measurement; EVERY error flattered the result. Build a control that must fail, and check that it does.
2. The winner earns their cost advantage over the runner-up. Our route costs 1.2%, theirs 0.05%. A gap dies for us
   while still alive for them: measured, winners leave pairs at -0.25% to -0.9% of our break-even.
3. A flash loan only funds ATOMIC trades. Hold a position two seconds and the capital is $5 again.
4. Persistence is evidence AGAINST tradability. A gap open ten minutes is one nobody can take.
5. Every extra leg costs a fee and buys nothing unless that leg is mispriced.
6. Atomicity and route width pull against each other: the profitable routes split across 3+ venues a leg.
7. A displayed price is not a tradable one. The DLMM active-bin phantom was 0.8% on a busy pool and 179% on a
   stranded one. There is no ceiling.

## 7. Traps paid for (do not repeat)
- web3.js removeAccountChangeListener can wait forever on a dead socket: exit instead of reconnecting.
- Math.max(...bigArray) overflows the stack near 300k items.
- DLMM swapQuote reads Date.now() internally: pin it. Fee = LP fee + protocolFee, summed.
- DAMM v2 activationType 0 = slots, 1 = unix seconds; the wrong one throws "Swap is disabled".
- Jupiter's otherAmountThreshold is honoured on some routes and silently IGNORED on others. Never rely on it.
- With slippageBps 0, Jupiter's own minimum reverts before our check is reached: use 50.
- De-duplicating instructions silently deleted our profit check, because its ATA step is byte-identical to one of
  Jupiter's. De-duplicate only the aggregator's own steps.
- A simulation executes for real: the payer must EXIST and hold the SOL. It must have no wrapped-SOL account, or
  its balance pays our check.
- @solana/spl-token in this repo is ESM-only and cannot be imported from these CommonJS files.
- Meteora's API sorts only by tvl and volume_24h; created_at is rejected. It 403s Python's default user agent.
- A pool whose lifetime volume equals its 24 h volume was born today: that is the age detector.
- Helius free plan has no getLargestAccounts. Jupiter keyless allows ~30 requests a minute; pace everything.
- Windows Modern Standby suspends WSL2 and freezes every timer: powercfg /change standby-timeout-ac 0.
- ALWAYS replace whole files rather than patching; check wc -l against the expected count after every paste.

## 8. Costs to date
Helius: ~5,000 of 1,000,000 monthly credits. Jupiter: free, keyless. Meteora lists: free. Money spent: nothing.

## 9. Untested, if anyone resumes
- Token-2022 aware quoting (transfer fees). Six of ten divergence alarms were Token-2022.
- Non-SOL quote assets (USDC-token-USDC). Still two legs, so rule 5 is untouched.
- npm run newborn: tokens whose pools are minutes old, too young to have been arbitraged.
- Native Meteora swap instructions, which would let us trade pools Jupiter refuses to route.
Each must clear: SEE the real price, REACH it while open, PAY more than it costs, DO both legs atomically.
DO is solved and free. SEE is mostly solved. REACH and PAY are where everything has died.

## 10. Starting a fresh chat
Paste this file, the doc link, and a fresh zip (git archive --format=zip -o ~/arb-codebase.zip HEAD).
Say: "Continue from HANDOFF.md." Keep the method: one substep per reply, exact commands, paste the output,
verify before moving on.
