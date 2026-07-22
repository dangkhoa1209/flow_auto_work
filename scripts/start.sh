#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_DIR="$ROOT/scripts/.pids"
mkdir -p "$PID_DIR" "$ROOT/data"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing .env — copy .env.example and fill values."
  exit 1
fi

PORT="$(grep -E '^PORT=' .env | cut -d= -f2- || true)"
PORT="${PORT:-8787}"
HOST="$(grep -E '^HOST=' .env | cut -d= -f2- || true)"
HOST="${HOST:-127.0.0.1}"

if [[ -f "$PID_DIR/server.pid" ]] && kill -0 "$(cat "$PID_DIR/server.pid")" 2>/dev/null; then
  echo "Server already running (pid $(cat "$PID_DIR/server.pid"))."
  exit 0
fi

echo "Starting flow_auto_work on ${HOST}:${PORT}..."
nohup npx tsx src/index.ts >"$ROOT/data/server.log" 2>&1 &
echo $! >"$PID_DIR/server.pid"
echo "UI: http://${HOST}:${PORT}/"
