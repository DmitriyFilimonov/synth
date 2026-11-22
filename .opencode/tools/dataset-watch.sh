#!/usr/bin/env bash
# dataset-watch.sh <datasetDir> — следит за новыми completed-прогонами
# и запускает refresh-analysis.ts кодом того репозитория, где лежит
# этот скрипт. Повторный запуск для того же датасета отклоняется через
# flock, который удерживается до выхода процесса (нужен util-linux/flock).
#
# DATASET_WATCH_WAIT_FOR_NEW=1 не запускает анализ на старте, а ждёт
# первого нового прогона. Полный лог последнего анализа лежит рядом
# с основным /tmp/opencode/dataset-watch-<id>-analysis.log.

set -u -o pipefail

DATASET="${1:?usage: dataset-watch.sh <datasetDir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ "$DATASET" != /* ]]; then
  DATASET="$REPO_ROOT/$DATASET"
fi
INTERVAL="${DATASET_WATCH_INTERVAL:-900}"
MAX_LIFETIME="${DATASET_WATCH_MAX_LIFETIME:-259200}"
WAIT_FOR_NEW="${DATASET_WATCH_WAIT_FOR_NEW:-0}"
WATCH_KEY="$(printf '%s' "$DATASET" | cksum | awk '{print $1}')"
LOCK_FILE="/tmp/opencode/dataset-watch-$WATCH_KEY.lock"
ANALYSIS_LOG="/tmp/opencode/dataset-watch-$WATCH_KEY-analysis.log"
SECONDS=0

log() {
  echo "$(date -Is) $*"
}

if ! command -v flock >/dev/null 2>&1; then
  log "flock is required to prevent duplicate watchers"
  exit 1
fi

# Дескриптор и блокировка живут до выхода процесса. Файл можно
# оставить на диске: после аварии ОС сама снимает flock, поэтому
# устаревший PID или его повторное использование не влияют на запуск.
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  log "dataset-watch already running for $DATASET"
  exit 0
fi

count_completed() {
  find "$DATASET" -name run.json -exec grep -l '"status": "completed"' {} + 2>/dev/null | wc -l
}

LAST_COUNT=-1
if [ "$WAIT_FOR_NEW" = "1" ]; then
  LAST_COUNT="$(count_completed)"
  log "waiting for a new completed run; current count: $LAST_COUNT"
fi
log "dataset-watch started for $DATASET (pid $$, repo $REPO_ROOT)"

while [ "$SECONDS" -lt "$MAX_LIFETIME" ]; do
  count="$(count_completed)"
  if [ "$count" != "$LAST_COUNT" ]; then
    log "completed runs: $count (was $LAST_COUNT); refreshing analysis"
    if (cd "$REPO_ROOT" && npx tsx src/dataset/refresh-analysis.ts --dataset "$DATASET") \
      2>&1 | tee "$ANALYSIS_LOG" \
      | grep --line-buffered -E 'STEP|SUMMARY|FAIL' \
      | while read -r line; do log "  $line"; done; then
      log "analysis refreshed; full log: $ANALYSIS_LOG"
      LAST_COUNT="$count"
    else
      log "analysis failed; will retry after the next interval; full log: $ANALYSIS_LOG"
    fi
  fi
  sleep "$INTERVAL"
done

log "lifetime reached, stopping"
