#!/usr/bin/env bash
# SignalFlow launcher — no dependencies beyond Python 3.11+.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
PORT="${SIGNALFLOW_PORT:-8000}"

echo "SignalFlow — starting on http://127.0.0.1:${PORT}"
echo "  (Ctrl+C to stop)"
echo

# open the browser (macOS), best-effort
( sleep 1; command -v open >/dev/null && open "http://127.0.0.1:${PORT}" || true ) &

exec "$PY" server.py
