#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="/home/linux1/IBM-Z-Datathon-FireWatch"
PYTHON="/home/linux1/firewatch/.venv311/bin/python"
LOG="/home/linux1/firewatch_logs/erc_v6_refresh.log"

cd "$PROJECT"

{
  echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') REFRESH START ====="
  "$PYTHON" backend/scripts/refresh_erc_v6.py
  echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') REFRESH SUCCESS ====="
} >> "$LOG" 2>&1
