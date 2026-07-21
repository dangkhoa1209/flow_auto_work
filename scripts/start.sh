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
else
  echo "Starting flow_auto_work on ${HOST}:${PORT}..."
  nohup npx tsx src/index.ts >"$ROOT/data/server.log" 2>&1 &
  echo $! >"$PID_DIR/server.pid"
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install: brew install cloudflare/cloudflare/cloudflared"
  echo "Server is up locally; configure tunnel manually."
  exit 0
fi

if [[ -f "$PID_DIR/tunnel.pid" ]] && kill -0 "$(cat "$PID_DIR/tunnel.pid")" 2>/dev/null; then
  echo "Tunnel already running (pid $(cat "$PID_DIR/tunnel.pid"))."
  if [[ -f "$ROOT/scripts/.tunnel-url" ]]; then
    echo "Webhook URL: $(cat "$ROOT/scripts/.tunnel-url")/webhooks/gitlab"
  fi
  exit 0
fi

echo "Starting cloudflared quick tunnel..."
TUNNEL_LOG="$ROOT/data/tunnel.log"
: >"$TUNNEL_LOG"
nohup cloudflared tunnel --url "http://${HOST}:${PORT}" >"$TUNNEL_LOG" 2>&1 &
echo $! >"$PID_DIR/tunnel.pid"

echo "Waiting for tunnel URL..."
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  if [[ -n "${URL}" ]]; then
    echo "$URL" >"$ROOT/scripts/.tunnel-url"
    echo "Tunnel ready: $URL"
    echo "Set GitLab webhook to: ${URL}/webhooks/gitlab"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for tunnel URL. Check $TUNNEL_LOG"
exit 1
