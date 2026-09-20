#!/usr/bin/env bash
# Stops the Jupiter scanner and its supervisor.
pkill -f "ops/run_jup.sh"
pkill -f "research/jup_roundtrip.ts"
sleep 1
pgrep -af "run_ju[p].sh|jup_roundtri[p].ts" || echo "stopped"
