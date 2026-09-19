#!/usr/bin/env bash
# Stops the supervisor and the logger. The logger writes a "stop" line to the data file on SIGTERM.
pkill -f "ops/run_logger.sh"
pkill -f "src/feed/logger.ts"
echo "stopped"