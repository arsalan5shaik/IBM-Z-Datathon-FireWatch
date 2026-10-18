#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="/home/linux1/IBM-Z-Datathon-FireWatch"
PYTHON="/home/linux1/firewatch/.venv311/bin/python"
LOG="/home/linux1/firewatch_logs/erc_v6_refresh.log"

mkdir -p "$(dirname "$LOG")"
cd "$PROJECT"

{
  echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') REFRESH START ====="

  # Prevent overlapping refresh and SHAP publication jobs.
  flock -n 9 || {
    echo "Another refresh is running; skipping."
    exit 0
  }

  "$PYTHON" backend/scripts/refresh_erc_v6_multicell.py
  # Keep published JSON readable by Docker's unprivileged backend.
  chmod 755 shared/data/erc-v6
  chmod 644 shared/data/erc-v6/*.json

  echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') REFRESH SUCCESS ====="
} 9>"$PROJECT/shared/data/erc-v6/.hourly.lock" >> "$LOG" 2>&1
