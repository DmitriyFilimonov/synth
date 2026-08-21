# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Цель проекта

Реверс-синтез: по эталонному WAV подобрать конфигурацию осцилляторов
аддитивного синтезатора (до 50 осцилляторов), максимизируя RMS-based
`suppressionPercent`. Генерация по пресету (конфиг → WAV) — вспомогательная
функция. Цель: `suppressionPercent ≥ 98%` (порог совпадает с early-exit
coordinate descent); текущее состояние на реальных таргетах — ~80% по
внутренней multi-scale surrogate-метрике — считай это промежуточным
состоянием, а не потолком: изменения не должны его деградировать.

В корне репозитория лежит гораздо более подробный **`AGENTS.md`** —
авторитетная, постоянно обновляемая спецификация внутренностей оптимизатора,
инвариантов и контрактов API. Для любых алгоритмических деталей смотри туда.
**Если изменение меняет поведение, описанное в AGENTS.md, — обнови
соответствующую секцию в том же коммите** (это правило репозитория,
применимое ко всем агентам, не только к opencode).

`.opencode/` содержит отдельный opencode-специфичный workflow субагентов и
проверки критериев (`criteria-match`, `single-criteria-*`,
`optimizer-reviewer` и т.д.) — этот инструментарий не используется Claude
Code, игнорируй его, если явно не спросят.

## Команды

Бэкенд (корень):
```
npm run dev            # запуск через tsx без сборки (src/index.ts — пресет → WAV)
npm run build           # tsc -> dist/
npm run start            # запуск собранного dist/index.js
npm run serve:dev        # HTTP API через tsx без сборки (src/server.ts)
npm run serve             # запуск собранного HTTP API (dist/server.js)
npm run viz               # SVG-визуализация огибающих
npm run prettier          # форматирование src/**/*.ts
npm run prettier:check
npm run lint               # eslint src/**/*.ts
npm run lint:fix
```
Автотестов нет (`npm run test` — заглушка, завершается с exit 1).
Файлы `test-*.ts` в корне репозитория — одноразовые отладочные скрипты, они
исключены из `tsconfig.json` (`include: ["src"]`) — не добавляй туда новый
код, весь новый код — только в `src/`.

Веб-интерфейс (`web/`):
```
cd web && npm run dev      # Vite dev-сервер, http://localhost:5173
cd web && npm run build    # tsc -b && vite build -> web/dist/
cd web && npm run preview
```
Dev-сервер проксирует `/api`, `/health`, `/presets` на бэкенд
`localhost:3000`.

Стандартный порядок работы (бэкенд): `npm run prettier` → `npm run build`
(проверка типов) → `npm run dev`/`npm run start` для проверки результата.
Для веба: `cd web && npm run build` (проверка типов) → `cd web && npm run dev`.

Docker: `docker build -t synth .` / `docker run -p 3000:3000 synth`.
Мультисборка (бэкенд `tsc` + веб `vite build` → `node dist/server.js`);
порт через переменную окружения `PORT` (по умолчанию 3000).

## Архитектура

FFT не используется в рантайм-синтезе (спектральный анализ допустим только
для инициализации/метрик). Оптимизация выполняется в worker-потоке
(`optimizer-worker.ts`); HTTP API поддерживает как синхронный, так и
асинхронный (job-очередь) режим мэтчинга.

```
External WAV → parse samples → init vector →
optimize (coordinate descent, worker thread) →
generate → compare → save WAV + SVG
```

### Core-модули (`src/`)

- `index.ts` — точка входа, генерация WAV из пресета
- `consts.ts` — `SAMPLE_RATE`, `SAMPLE_LENGTH_IN_SECONDS`, пороги громкости
- `synth.ts` / `oscillator.ts` / `envelope.ts` — движок синтеза
- `presets.ts` — именованные конфигурации осцилляторов (формат `ArgCreateSynth`)
- `read-wav.ts` / `write-wav.ts` — чтение/запись 16-битного моно PCM WAV
- `synth-config-to-vector.ts` / `vector-to-synth-config.ts` — конфиг ↔
  нормализованный `number[]` в `[0,1]` (50 осцилляторов × 10 параметров;
  `vector-to-synth-config.ts` — единственный источник истины для маппинга)
- `src/optimize/` — оптимизатор coordinate descent: `coordinate-descent.ts`
  (алгоритм), `evaluate.ts` (multi-scale windowed-метрика suppression +
  `WaveformCache` для инкрементального ресинтеза), `staged.ts` (тонкая
  обёртка, стадийность удалена), `residual-relocation.ts` (переставляет
  слабые осцилляторы на пики остатка вместо выключения), `consts.ts`, `types.ts`
- `dual-window-init-vector.ts` — **основной** автоинит (используется в
  `match.ts` и API), двухоконный Goertzel-анализ (sustain + transient сканы);
  `simple-init-vector.ts`, `fft-init-vector.ts`, `stft-init-vector.ts`,
  `adaptive-init-vector.ts` — legacy/альтернативные стратегии инициализации,
  сохранены для сравнения, в основном пайплайне заменены
- `signal-analysis.ts`, `spectrogram.ts`, `fft.ts` — утилиты анализа
  (автокорреляция, STFT, Cooley-Tukey FFT)
- `cancellation-assessment.ts`, `rms.ts` — оценка качества
- `match.ts` — оркестратор (read → optimize → generate → visualize);
  `match-worker.ts` / `optimizer-worker.ts` — обвязка worker-потока
- `visualize.ts`, `visualize-envelopes.ts`, `match-visualize.ts` — SVG-вывод

**Инварианты (не нарушать):** сигнатуры `ArgOptimize`/`ProgressCallback` и
форма возврата `{ vector, history }` — публичный контракт, используемый в
`optimizer-worker.ts` и `match-visualize.ts`. `onProgress` обязан вызываться
каждую итерацию (от этого зависят job-статусы и UI). Значения вектора всегда
в `[0,1]`. Оптимизатор должен оставаться синхронным без внешних зависимостей
(работает внутри `worker_threads`). Non-null assertion (`!`) запрещён во всём
репозитории — читай значение в локальную переменную с fallback через `??`.

### HTTP API (`src/api/`)

Слои: `server.ts` (только `createApp()` + `listen()`, без роутов/логики) →
`api/routes/` (Express Router, только маршрутизация) → `api/controllers/`
(тонкие: Request → Service → Response, маппинг ошибок на статусы) →
`api/services/` (бизнес-логика, без зависимости от Express) → core-модули.
DTO — в `api/types.ts`. `synth-service.ts` содержит `generateWav()`/
`matchWav()`/`matchWavWithJob()`; `job-store.ts` — файловое CRUD-хранилище
async job-ов в `jobs/` (`<id>.json`, `<id>_input.wav`, `<id>_result.wav`).

Ключевые эндпоинты: `POST /api/generate`, `POST /api/match` (синхронный),
`POST /api/match/job(/json)` + `GET /api/match/jobs(/:id)` +
`GET /api/match/jobs/:id/download(-params)` + `DELETE` (async job-очередь).
`app.ts` также отдаёт `web/dist/` как SPA, `/api/*` имеет приоритет над статикой.

### Веб-интерфейс (`web/src/`)

Feature-Sliced Design: `app/` (точка входа/корень), `features/synth-generator/`
и `features/wav-matcher/` (в каждой — `api/`, `model/`, `ui/`), `shared/api/`
(`fetchApi<T>`, `fetchBlob`) и `shared/ui/` (`Button`, `Input`, `Select`,
`AudioPlayer`). Правило: `features` может импортировать `shared`, но никогда
другие `features`; `shared` не зависит ни от чего. Тёмная Ableton-style тема
целиком через CSS custom properties в `web/src/global.css` (поверхности
`#121212`/`#1e1e1e`, акцент `#e67e22`, шрифты Inter + JetBrains Mono) —
используй эти токены, не хардкодь цвета. Компоненты используют CSS Modules
(`*.module.css`).

## Соглашения

- Prettier: одинарные кавычки, точки с запятой, trailing comma,
  `printWidth: 70`, табы по 2 пробела. Покрывает только `src/**/*.ts`
  (не `web/`, не корневые `test-*.ts`).
- TypeScript strict mode, `noUncheckedIndexedAccess: true`.
- Побочный I/O (репорт прогресса, запись статуса, логирование) никогда не
  должен ронять критический путь (синтез/оптимизация). Оборачивай hot-path
  I/O в try/catch и продолжай работу; пиши файлы атомарно (`.tmp` + rename);
  всегда имей fallback для отсутствующего/повреждённого состояния вместо
  падения с исключением.
- Корневые `*.wav`, `*.asd`, `*.svg` и `jobs/` — генерируемые артефакты,
  в `.gitignore` — не коммить их и не полагайся на их наличие (исключение:
  `docs/img/*.svg` — статические иллюстрации для README, они закоммичены).
