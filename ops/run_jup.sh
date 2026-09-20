#!/usr/bin/env bash
# Keeps the Jupiter whole-market round-trip scanner running: restarts it whenever it exits.
# Free: Jupiter's public endpoint, no key, no Helius credits. Output: bot/logs/jupiter-*.jsonl, console in bot/logs/jup.out.
# Waits 30 s before a restart, doubling to 5 min while runs keep ending within a minute; a healthy run resets it.
cd "$(dirname "$0")/../bot" || exit 1
mkdir -p logs
backoff=30
while true; do
  started=$(date +%s)
  echo "$(date -u +%FT%TZ) starting jup scanner" >> logs/jup.out
  npm run --silent jup >> logs/jup.out 2>&1
  code=$?
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -ge 60 ]; then backoff=30; fi
  echo "$(date -u +%FT%TZ) jup scanner exited with code $code after ${ran} s; restarting in ${backoff} s" >> logs/jup.out
  sleep "$backoff"
  if [ "$ran" -lt 60 ]; then backoff=$(( backoff * 2 )); [ "$backoff" -gt 300 ] && backoff=300; fi
done
