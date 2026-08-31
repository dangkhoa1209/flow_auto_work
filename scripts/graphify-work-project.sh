#!/usr/bin/env bash
# Build / refresh WorkBench graphify for customer checkouts — never writes inside source/.
#
# Usage:
#   scripts/graphify-work-project.sh khoadev/ykk     # one project (preferred after code changes)
#   scripts/graphify-work-project.sh --force khoadev/ykk
#   scripts/graphify-work-project.sh --source /abs/path/to/.../source
#   scripts/graphify-work-project.sh                 # ALL checkouts (bootstrap only; slow on large repos)
#   scripts/graphify-work-project.sh --force         # ALL full rebuild
#
# Work/BA API actions already refresh only the project that was cloned/pulled/run.
# Layout:
#   project/<user>/<slug>/source        ← scanned
#   project/<user>/<slug>/graphify-out  ← WorkBench-owned output
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:${HOME}/Library/Python/3.12/bin:${HOME}/Library/Python/3.11/bin:${HOME}/Library/Python/3.10/bin:/opt/homebrew/bin:${PATH}"

FORCE=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [[ -n "${GRAPHIFY_BIN:-}" && -x "${GRAPHIFY_BIN}" ]]; then
  GRAPHIFY_CMD=("$GRAPHIFY_BIN")
elif command -v graphify >/dev/null 2>&1; then
  GRAPHIFY_CMD=(graphify)
else
  echo "graphify not found on this host." >&2
  echo "Debian/Ubuntu: sudo apt install pipx && pipx ensurepath && pipx install graphifyy" >&2
  echo "Or set GRAPHIFY_BIN=/root/.local/bin/graphify" >&2
  exit 1
fi

build_one() {
  local SOURCE="$1"
  if [[ ! -d "$SOURCE" ]]; then
    echo "Skip (missing): $SOURCE" >&2
    return 1
  fi
  local OUT
  if [[ "$(basename "$SOURCE")" == "source" ]]; then
    OUT="$(cd "$(dirname "$SOURCE")" && pwd)/graphify-out"
  else
    OUT="${SOURCE}.graphify-out"
  fi
  mkdir -p "$OUT"

  local STAMP_FILE="$OUT/.flow-graphify-stamp"
  local CUR_STAMP=""
  if [[ -d "$SOURCE/.git" ]]; then
    CUR_STAMP="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
    CUR_STAMP+=$'\n'
    CUR_STAMP+="$(git -C "$SOURCE" status --porcelain 2>/dev/null || true)"
  fi

  local MODE_ARGS=()
  local MODE_LABEL="incremental"
  if [[ "$FORCE" -eq 1 || ! -f "$OUT/graph.json" ]]; then
    MODE_ARGS=(--force)
    MODE_LABEL="full"
  elif [[ -n "$CUR_STAMP" && -f "$STAMP_FILE" ]] && cmp -s "$STAMP_FILE" <(printf '%s\n' "$CUR_STAMP"); then
    echo ""
    echo "=== Skip (unchanged): $SOURCE"
    echo "    Graph:    $OUT/graph.json"
    return 0
  fi

  echo ""
  echo "=== Scanning: $SOURCE ($MODE_LABEL)"
  echo "    Output:   $OUT"
  GRAPHIFY_OUT="$OUT" "${GRAPHIFY_CMD[@]}" update "$SOURCE" "${MODE_ARGS[@]}"
  if [[ -n "$CUR_STAMP" ]]; then
    printf '%s\n' "$CUR_STAMP" >"$STAMP_FILE"
  fi
  echo "    Graph:    $OUT/graph.json"
}

if [[ "${1:-}" == "--source" ]]; then
  build_one "$(cd "${2:?need path}" && pwd)"
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  build_one "$ROOT/project/$1/source"
  exit 0
fi

# No args: every …/source under project/ (Work users + BA _ba)
# No args: every …/source under project/ (bootstrap). Prefer: $0 user/slug
echo "Auto: ALL checkouts under $ROOT/project (for one project use: $0 <user>/<slug>)"
ok=0
fail=0
total=0
while IFS= read -r SRC; do
  [[ -z "$SRC" ]] && continue
  total=$((total + 1))
  if build_one "$SRC"; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
  fi
done < <(find "$ROOT/project" -mindepth 2 -maxdepth 3 -type d -name source 2>/dev/null | sort)

if [[ "$total" -eq 0 ]]; then
  echo "No project/**/source found under $ROOT/project" >&2
  exit 1
fi

echo ""
echo "Done: $ok ok, $fail failed ($total total)"
[[ "$fail" -eq 0 ]]
