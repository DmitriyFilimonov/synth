#!/usr/bin/env bash
# quota-watchdog.sh — автовозобновление сессии OpenCode после
# исчерпания лимитов провайдера (429 / quota).
#
# Зачем: при исчерпании квоты модель «умирает» посреди хода и
# ретраить некому — ретрай должен жить снаружи модели. Сторожок
# опрашивает сессию через API сервера (`opencode api`, авторизация
# и поднятие сервера — на CLI) и, когда сессия простаивает в
# состоянии ошибки, шлёт пробное сообщение. Провайдер восстановился
# — агент просыпается и продолжает работу по реестру задач.
#
# Запуск (отсоединённо, переживает рестарт харнесса):
#   setsid nohup .opencode/tools/quota-watchdog.sh <sessionID> \
#     >> /tmp/opencode/quota-watchdog.log 2>&1 < /dev/null &
#
# Лог: /tmp/opencode/quota-watchdog-<sessionID>.log
# Остановка: kill <pid>, pid записан в /tmp/opencode/quota-watchdog-<sessionID>.pid

set -u

SID="${1:?usage: quota-watchdog.sh <sessionID>}"
OPENCODE="${OPENCODE_BIN:-/root/.opencode/bin/opencode}"
LOG="${QUOTA_WATCHDOG_LOG:-/tmp/opencode/quota-watchdog-$SID.log}"
PID_FILE="/tmp/opencode/quota-watchdog-$SID.pid"

POLL_HEALTHY_SEC=300      # здоровая сессия: опрос раз в 5 минут
BACKOFF_START_SEC=300     # первая пауза после неудачной пробы
BACKOFF_MAX_SEC=1800      # потолок паузы между пробами
PROBE_GRACE_SEC=90        # после пробы ждём пробуждения столько
MAX_PROBES=200            # защита от бесконечных проб
MAX_LIFETIME_SEC=172800   # 48 часов жизни сторожка

PROBE_TEXT='[quota-watchdog] Автоматический ретрай после исчерпания лимитов провайдера. Прочти реестр задач в docs/plan-kick-enhancement.md, проверь `npx tsx src/dataset/dataset-status.ts --dataset datasets/reference-4` и продолжи работу с текущего незавершённого пункта. Не трать ответ на пересказ — продолжай работу сразу.'

echo $$ > "$PID_FILE"
log() {
  echo "$(date -Is) $*" | tee -a "$LOG" >/dev/null
}

# Читает поле верхнего уровня из data объекта сессии.
session_field() {
  "$OPENCODE" api get "/api/session/$SID" 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)['data']
    print(d$1)
except Exception:
    print('')
"
}

send_probe() {
  local payload
  payload=$(PROBE_TEXT="$PROBE_TEXT" python3 -c '
import json, os
print(json.dumps({"text": os.environ["PROBE_TEXT"]}))
')
  "$OPENCODE" api post "/api/session/$SID/prompt" \
    --data "$payload" >/dev/null 2>&1
}

log "watchdog started: sid=$SID pid=$$"
probes=0
backoff=$BACKOFF_START_SEC

while [ "$SECONDS" -lt "$MAX_LIFETIME_SEC" ]; do
  outcome=$(session_field "['outcome']")
  busy=$(session_field "['time']['busy']")
  idle=$(session_field "['time']['idle']")

  if [ -z "$outcome" ]; then
    log "session unreadable (server restart?), retry in ${backoff}s"
    sleep "$backoff"
    continue
  fi

  # Сессия работает прямо сейчас: busy свежее idle.
  if [ -n "$busy" ] && [ -n "$idle" ] && [ "$busy" -gt "$idle" ]; then
    sleep "$POLL_HEALTHY_SEC"
    continue
  fi

  if [ "$outcome" = "succeeded" ]; then
    sleep "$POLL_HEALTHY_SEC"
    continue
  fi

  # Сессия простаивает в состоянии ошибки: пробуем разбудить.
  probes=$((probes + 1))
  if [ "$probes" -gt "$MAX_PROBES" ]; then
    log "probe limit reached ($MAX_PROBES), giving up"
    exit 1
  fi

  log "idle with outcome=$outcome: probe #$probes"
  if send_probe; then
    sleep "$PROBE_GRACE_SEC"
    new_busy=$(session_field "['time']['busy']")
    new_outcome=$(session_field "['outcome']")
    if { [ -n "$new_busy" ] && [ -n "$idle" ] && [ "$new_busy" -gt "$idle" ]; } \
      || [ "$new_outcome" = "succeeded" ]; then
      log "session woke up after probe #$probes, watchdog done"
      exit 0
    fi
  fi

  log "probe #$probes did not wake session, backoff ${backoff}s"
  sleep "$backoff"
  backoff=$((backoff * 2))
  [ "$backoff" -gt "$BACKOFF_MAX_SEC" ] && backoff=$BACKOFF_MAX_SEC
done

log "lifetime limit reached, giving up"
exit 1
