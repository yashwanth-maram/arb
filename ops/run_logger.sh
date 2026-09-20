#!/usr/bin/env bash
# Keeps the divergence logger running: restarts it whenever it exits.
# Exit codes: 0 = asked to stop, 1 = could not start (usually no internet), 2 = the feed went silent (watchdog).
# Waits 10 s before a restart. If runs keep ending within a minute the wait doubles, up to 60 s; a healthy run resets it.
# Console output goes to bot/logs/logger.out; the data goes to bot/logs/divergence-*.jsonl.
cd "$(dirname "$0")/../bot" || exit 1
mkdir -p logs
backoff=10
while true; do
  started=$(date +%s)
  echo "$(date -u +%FT%TZ) starting logger" >> logs/logger.out
  npm run --silent logger >> logs/logger.out 2>&1
  code=$?
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -ge 60 ]; then backoff=10; fi
  echo "$(date -u +%FT%TZ) logger exited with code $code after ${ran} s; restarting in ${backoff} s" >> logs/logger.out
  sleep "$backoff"
  if [ "$ran" -lt 60 ]; then backoff=$(( backoff * 2 )); [ "$backoff" -gt 60 ] && backoff=60; fi
done
