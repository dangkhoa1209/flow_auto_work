#!/usr/bin/env bash
# Build / refresh WorkBench graphify for a customer checkout — never writes inside source/.
#
# Usage:
#   scripts/graphify-work-project.sh <user>/<slug>
#   scripts/graphify-work-project.sh khoadev/ykk
#   scripts/graphify-work-project.sh --source /abs/path/to/.../source
#
# Layout:
#   project/<user>/<slug>/source        ← scanned
#   project/<user>/<slug>/graphify-out  ← WorkBench-owned output
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:${HOME}/Library/Python/3.12/bin:${HOME}/Library/Python/3.11/bin:${HOME}/Library/Python/3.10/bin:/opt/homebrew/bin:${PATH}"

if ! command -v graphify >/dev/null 2>&1; then
  echo "graphify not found on this host." >&2
  echo "Debian/Ubuntu: sudo apt install pipx && pipx ensurepath && pipx install graphifyy" >&2
  echo "Or venv: python3 -m venv /opt/flow-graphify && /opt/flow-graphify/bin/pip install graphifyy" >&2
  echo "Then set GRAPHIFY_BIN to that binary if it is not on PATH." >&2
  exit 1
fi

SOURCE=""
if [[ "${1:-}" == "--source" ]]; then
  SOURCE="$(cd "${2:?need path}" && pwd)"
elif [[ -n "${1:-}" ]]; then
  SOURCE="$ROOT/project/$1/source"
else
  echo "Usage: $0 <user>/<slug> | --source <path-to-source>" >&2
  exit 1
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "Source not found: $SOURCE" >&2
  exit 1
fi

if [[ "$(basename "$SOURCE")" == "source" ]]; then
  OUT="$(cd "$(dirname "$SOURCE")" && pwd)/graphify-out"
else
  OUT="${SOURCE}.graphify-out"
fi

mkdir -p "$OUT"
echo "Scanning: $SOURCE"
echo "Output:   $OUT"
GRAPHIFY_OUT="$OUT" graphify update "$SOURCE" --force
echo "Graph:    $OUT/graph.json"
echo "Query:    graphify query \"…\" --graph \"$OUT/graph.json\""
