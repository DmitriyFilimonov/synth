#!/usr/bin/env bash
# dataset-watch.sh <datasetDir> — следит за сборкой датасета и
# обновляет анализ (refresh-analysis.ts) при появлении новых
# завершённых прогонов. Опрос раз в 15 минут; жизнь — до 3 суток.
#
# Запуск (детачнуто):
#   setsid nohup .opencode/tools/dataset-watch.sh datasets/reference-4 \
#     >> /tmp/opencode/dataset-watch.log 2>&1 < /dev/null &

set -u

DATASET="${1:?usage: dataset-watch.sh <datasetDir>}"
INTERVAL=900
MAX_LIFETIME=259200
LAST_COUNT=-1
SECONDS=0

count_completed() {
  find "$DATASET" -name run.json -exec grep -l '"status": "completed"' {} + 2>/dev/null | wc -l
}

log() {
  echo "$(date -Is) $*"
}

log "dataset-watch started for $DATASET (pid $$)"

while [ "$SECONDS" -lt "$MAX_LIFETIME" ]; do
  count=$(count_completed)
  if [ "$count" != "$LAST_COUNT" ]; then
    log "completed runs: $count (was $LAST_COUNT); refreshing analysis"
    (cd /opt/synth && npx tsx src/dataset/refresh-analysis.ts --dataset "$DATASET") \
      2>&1 | grep -E 'STEP|SUMMARY|FAIL' | while read -r line; do log "  $line"; done
    LAST_COUNT=$count
  fi
  sleep "$INTERVAL"
done

log "lifetime reached, stopping"
