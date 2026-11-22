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
# Наблюдение постоянное: после успешного пробуждения сторожок НЕ
# завершается, а возвращается к опросу — следующее истечение
# лимитов тоже требует присмотра. Завершается только по лимиту
# проб, по лимиту времени жизни или по kill.
#
# Цель /goal: плагин цели сам ставит её на паузу при падении хода
# (`execution.failed`) и при рестарте сервера, поэтому текстовый
# пробник будит сессию, но не цикл цели. Сторожок читает цель через
# RPC (`POST /api/rpc/opencode.goal/get`) и, если она на паузе
# из-за сбоя, шлёт `/goal resume` через
# `POST /api/session/<id>/command`. Паузы по воле пользователя
# («Paused by the user», «Stopped by the user») и по стоп-критериям
# цикла (нет прогресса, лимит раундов) не трогаем.
#
# Запуск (отсоединённо, переживает рестарт харнесса):
#   setsid nohup .opencode/tools/quota-watchdog.sh <sessionID> \
#     >> /tmp/opencode/quota-watchdog.log 2>&1 < /dev/null &
#
# Лог: /tmp/opencode/quota-watchdog-<sessionID>.log
# Остановка: kill <pid>, pid записан в /tmp/opencode/quota-watchdog-<sessionID>.pid
# Повторный запуск при живом сторожке той же сессии — отказ.
# Тайминги переопределяются переменными QW_* (для тестов).

set -u

SID="${1:?usage: quota-watchdog.sh <sessionID>}"
OPENCODE="${OPENCODE_BIN:-/root/.opencode/bin/opencode}"
LOG="${QUOTA_WATCHDOG_LOG:-/tmp/opencode/quota-watchdog-$SID.log}"
PID_FILE="/tmp/opencode/quota-watchdog-$SID.pid"

POLL_HEALTHY_SEC="${QW_POLL_HEALTHY_SEC:-300}"     # здоровая сессия: опрос раз в 5 минут
BACKOFF_START_SEC="${QW_BACKOFF_START_SEC:-300}"   # первая пауза после неудачной пробы
BACKOFF_MAX_SEC="${QW_BACKOFF_MAX_SEC:-1800}"      # потолок паузы между пробами
PROBE_GRACE_SEC="${QW_PROBE_GRACE_SEC:-90}"        # после пробы ждём пробуждения столько
MAX_PROBES="${QW_MAX_PROBES:-200}"                 # защита от бесконечных проб (на один сбой)
MAX_LIFETIME_SEC="${QW_MAX_LIFETIME_SEC:-172800}"  # 48 часов жизни сторожка

PROBE_TEXT='[quota-watchdog] Автоматический ретрай после исчерпания лимитов провайдера. Прочти реестр задач в docs/plan-kick-enhancement.md, проверь `npx tsx src/dataset/dataset-status.ts --dataset datasets/reference-4` и продолжи работу с текущего незавершённого пункта. Не трать ответ на пересказ — продолжай работу сразу.'

log() {
  echo "$(date -Is) $*" | tee -a "$LOG" >/dev/null
}

# Двойной запуск недопустим: два сторожка одной сессии удваивают пробы.
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$old_pid" ] && [ "$old_pid" != "$$" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "another watchdog is already running (pid $old_pid), refusing to start"
    exit 1
  fi
fi
echo $$ > "$PID_FILE"

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

# Печатает "<status>\t<reason>" цели сессии; пусто, если цели нет
# или RPC недоступен.
goal_state() {
  "$OPENCODE" api post "/api/rpc/opencode.goal/get" \
    --data "{\"input\":{\"sessionID\":\"$SID\"}}" 2>/dev/null | python3 -c "
import json, sys
try:
    g = json.load(sys.stdin).get('output') or {}
    print(g.get('status', '') + '\t' + g.get('reason', ''))
except Exception:
    print('')
"
}

# Цель на паузе из-за сбоя: такую паузу поднимаем. Паузы по воле
# пользователя и по стоп-критериям цикла — не трогаем.
goal_needs_resume() {
  local state status reason
  state=$(goal_state)
  [ -z "$state" ] && return 1
  status="${state%%$'\t'*}"
  reason="${state#*$'\t'}"
  [ "$status" = "paused" ] || return 1
  case "$reason" in
    "The session failed"* | "The server restarted"* | "The goal stopped after an error"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resume_goal() {
  "$OPENCODE" api post "/api/session/$SID/command" \
    --data '{"name":"goal","text":"resume"}' >/dev/null 2>&1
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

  # Ручная остановка пользователем: не трогаем ни сессию, ни цель.
  # Пустой outcome (None/null) — сессия ещё не выполнялась, будить
  # нечего.
  if [ "$outcome" = "interrupted" ] || [ "$outcome" = "None" ] || [ "$outcome" = "null" ]; then
    sleep "$POLL_HEALTHY_SEC"
    continue
  fi

  if [ "$outcome" = "succeeded" ]; then
    # Ход завершился успешно, но цель могла остаться на паузе
    # после прошлого сбоя — поднимаем без текстового пробника.
    if goal_needs_resume && resume_goal; then
      log "goal was paused after a failure, issued /goal resume"
    fi
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
  sent=0
  # Сначала цель: если она на паузе из-за сбоя, /goal resume и
  # будит сессию, и поднимает цикл. Иначе — обычный пробник.
  if goal_needs_resume && resume_goal; then
    log "probe #$probes: issued /goal resume"
    sent=1
  elif send_probe; then
    sent=1
  fi
  if [ "$sent" = "1" ]; then
    sleep "$PROBE_GRACE_SEC"
    new_busy=$(session_field "['time']['busy']")
    new_outcome=$(session_field "['outcome']")
    if { [ -n "$new_busy" ] && [ -n "$idle" ] && [ "$new_busy" -gt "$idle" ]; } \
      || [ "$new_outcome" = "succeeded" ]; then
      # Пробуждение удалось — продолжаем наблюдение: следующее
      # истечение лимитов тоже потребует ретраев.
      log "session woke up after probe #$probes; resuming watch"
      probes=0
      backoff=$BACKOFF_START_SEC
      continue
    fi
  fi

  log "probe #$probes did not wake session, backoff ${backoff}s"
  sleep "$backoff"
  backoff=$((backoff * 2))
  [ "$backoff" -gt "$BACKOFF_MAX_SEC" ] && backoff=$BACKOFF_MAX_SEC
done

log "lifetime limit reached, giving up"
exit 1
