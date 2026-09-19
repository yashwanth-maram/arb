#!/usr/bin/env bash
# Keeps the divergence logger running: restarts it if it exits, 10 s backoff.
# Console output goes to bot/logs/logger.out; the data goes to bot/logs/divergence-*.jsonl.
cd "$(dirname "$0")/../bot" || exit 1
mkdir -p logs
while true; do
  echo "$(date -u +%FT%TZ) starting logger" >> logs/logger.out
  npm run --silent logger >> logs/logger.out 2>&1
  echo "$(date -u +%FT%TZ) logger exited with code $?; restarting in 10 s" >> logs/logger.out
  sleep 10
done