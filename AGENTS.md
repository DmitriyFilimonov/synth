# AGENTS.md

## Общее правило
Перед внесением изменений в любой файл проверяй его актуальное
содержимое. Не полагайся на память: в файл могли внести правку
другие агенты или разработчики.

Если твои изменения меняют поведение, описанное в этом файле, —
обнови соответствующую секцию AGENTS.md в том же коммите.

## Команды разработки

| Команда | Действие |
|---|---|
| `npm run dev` | Запуск через `tsx` без сборки |
| `npm run build` | Компиляция в `dist/` |
| `npm run start` | Запуск собранного `dist/index.js` |
| `npm run serve` | Запуск собранного HTTP-сервера (`dist/server.js`) |
| `npm run serve:dev` | Запуск HTTP-сервера через `tsx` без сборки |
| `npm run viz` | Визуализация огибающих (SVG) |
| `npm run prettier` | Форматирование источников через Prettier |
| `npm run prettier:check` | Проверка форматирования (без изменений) |
| `npm run lint` | Проверка ESLint |
| `npm run lint:fix` | Автофикс ESLint |
| `npm run test` | Заглушка тестов (not specified) |

### Веб-интерфейс (`web/`)

| Команда | Действие |
|---|---|
| `cd web && npm run dev` | Vite dev-сервер (`http://localhost:5173`) |
| `cd web && npm run build` | Сборка в `web/dist/` |
| `cd web && npm run preview` | Превью собранной сборки |

Dev-сервер проксирует `/api`, `/health`, `/presets` на бэкенд
`localhost:3000`.

## Порядок работы
1. `npm run prettier` — отформатировать код
2. `npm run build` — убедиться, что типы проходят проверку
3. `npm run dev` (или `npm run start`) — запустить и проверить результат

Для веб-интерфейса:
1. `cd web && npm run build` — убедиться, что типы проходят проверку
2. `cd web && npm run dev` — запустить dev-сервер

## Архитектура
Проект — генератор-синтезатор. Создаёт файл `.wav` (44 100 Гц, 16 бит,
моно) путём аддитивного синтеза до 50 осцилляторов. Включает пайплайн
подбора параметров: оптимизатор находит конфигурацию осцилляторов,
воспроизводящую заданный WAV-файл, максимизируя RMS-based
cancellation % (suppressionPercent).

FFT не используется в рантайм-синтезе. Использование спектрального
анализа для инициализации или метрики оптимизатора — допустимо.

Оптимизация выполняется в worker-потоке (`optimizer-worker.ts`),
API поддерживает асинхронный режим через job-очередь.

### Пайплайн подбора параметров
```
External WAV → Parse samples → Init vector →
Optimize (coordinate descent, worker thread) →
Generate → Compare → Save WAV + SVG
```

### Core-модули (синтез и обработка)

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа, генерация WAV из пресета |
| `src/consts.ts` | Константы: `SAMPLE_RATE`, `SAMPLE_LENGTH_IN_SECONDS`, `MAX_AMPLITUDE_16_BIT_WAV_ENCODED`, `VOLUME_MIN`, `VOLUME_PRUNE_THRESHOLD` |
| `src/synth.ts` | Создание синтезатора из конфигурации осцилляторов |
| `src/envelope.ts` | Экспоненциальная функция огибающей. При `x > duration` значение clamp'ится к `duration` (огибающая остаётся на последнем вычисленном уровне) |
| `src/oscillator.ts` | Расчёт сигнала осциллятора |
| `src/presets.ts` | Пресеты конфигураций осцилляторов |
| `src/read-wav.ts` | Чтение 16-битного WAV → `Int16Array` + метаданные (строго моно/16-бит/PCM) |
| `src/write-wav.ts` | Запись `Int16Array` в WAV-файл |
| `src/synth-config-to-vector.ts` | Нормализация конфига → вектор `number[]` `[0, 1]` |
| `src/vector-to-synth-config.ts` | Денормализация вектора → конфиг (50 осцилляторов) |
| `src/optimize/` | Модуль оптимизации: `index.ts` (реэкспорт), `coordinate-descent.ts` (алгоритм), `evaluate.ts` (оценка suppression), `consts.ts` (константы), `types.ts` (типы) |
| `src/signal-analysis.ts` | Анализ сигналов: автокорреляция (фундаментальная частота), amplitude envelope (RMS-окна), freqOverTime (zero-crossing) |
| `src/spectrogram.ts` | STFT-анализ: Hanning window, FFT, peak detection, кластеризация гармоник в траектории, fit osc envelopes |
| `src/fft.ts` | Cooley-Tukey radix-2 FFT, extraction доминантных гармоник с bias к фундаментальным |
| `src/simple-init-vector.ts` | Инициализация: Goertzel + STFT-гармоники для начальной точки оптимизации |
| `src/fft-init-vector.ts` | FFT-инициализация на коротком окне (~23ms) |
| `src/stft-init-vector.ts` | STFT-инициализация с траекториями (autocorr fundamental + STFT clustering) |
| `src/adaptive-init-vector.ts` | Адаптивная иницализация: детекция биений через amplitude modulation, разбиение фундаментального на два близких тона |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS-based) |
| `src/rms.ts` | Расчёт RMS энергии сигнала |
| `src/visualize.ts` | Генерация SVG-графиков |
| `src/visualize-envelopes.ts` | Визуализация огибающих первого осциллятора |
| `src/match.ts` | Оркестратор мэтчинга: read → optimize → generate → visualize |
| `src/match-worker.ts` | Обёртка для запуска оптимизации в worker-потоке |
| `src/optimizer-worker.ts` | Реализация worker-потока: запускает optimize, генерирует WAV, визуализацию |
| `src/match-preset.ts` | Начальная конфигурация для оптимизации |
| `src/match-visualize.ts` | Визуализация результатов мэтчинга (сигналы + прогресс) |
| `src/match-entry.ts` | Точка входа для запуска подбора параметров |

### Оптимизатор (src/optimize/)

#### Раскладка вектора
50 осцилляторов × 10 параметров (`OSC_PARAMS = 10`).
Смещение `[0]` каждого осциллятора — флаг on/off, `[1..9]` —
непрерывные параметры. Точный маппинг — см.
`src/vector-to-synth-config.ts` (единственный источник истины).

#### Инварианты (НЕ нарушать)
- Сигнатуры `ArgOptimize`, `ProgressCallback` и возврат
  `{ vector, history }` — публичный контракт (используются в
  `optimizer-worker.ts`, `match-visualize.ts`)
- `onProgress` вызывается каждую итерацию — от этого зависят
  job-статусы и UI
- Все значения вектора остаются в `[0, 1]`
- Код синхронный, без внешних зависимостей (работает внутри
  `worker_threads`)
- В возвращаемом векторе флаг `[0]` каждого осциллятора приведён
  к строго `0` или `1`

#### Текущее поведение (изменяемое, НЕ инвариант)
- Мульти-цикловый подход: `EXPLORATION` (0.05→0.01) → `REFINEMENT` (0.02→0.005) → `PRECISION` (0.005→0.001)
- Плато-пинки: при `3` итерациях без улучшения — случайный пинк одного параметра; после `5` пинков — полный рандомный рестарт
- Затухание шага: при `4` итерациях без улучшения шаг × `0.8`; выход из цикла, если шаг < minStep
- Ранний выход при достижении `98%` suppression
- Флаг `on` всегда `1` в процессе оптимизации; `enforceFlagInvariant` включает осцилляторы с `volume > VOLUME_MIN` и все до rightmostEnabled
- После completion — финальный прунинг: осцилляторы с `startLevel < VOLUME_PRUNE_THRESHOLD` (≈ 0.02) отключаются; откат если score падает > 0.05 п.п.
- Scale fitting: подбор оптимального масштаба громкости (`findOptimalScale`) после оптимизации
- Volume (offset 9): мультипликативный шаг (`center * (1 ± step)`), ограничен `clampVolume` → `[VOLUME_MIN, 1]`

#### Известное узкое место
`evaluateSuppression` пересинтезирует весь сигнал на каждую пробу
кандидата — тысячи полных синтезов за итерацию. Любая правка
оптимизатора не должна ухудшать число вызовов evaluate; уменьшение
их стоимости (инкрементальный пересчёт, кэш waveform на осциллятор) —
приоритетное направление.

### HTTP-сервер (`src/api/`)
```
src/server.ts                        → Точка входа: только `createApp()` + `listen()`
src/api/app.ts                       → Создание Express, middleware, регистрация роутов
src/api/types.ts                     → DTO и интерфейсы запросов/ответов
src/api/services/synth-service.ts    → Бизнес-логика: генерация и мэтчинг WAV
src/api/services/job-store.ts        → Хранилище job-ов: CRUD для асинхронных задач
src/api/controllers/                 → Request → Service → Response (валидация, ответы)
src/api/routes/                      → Express Router (маршрутизация)
```

| Файл | Назначение |
|---|---|
| `src/server.ts` | Точка входа HTTP-сервера. Только `createApp()` + `listen(PORT)`. Не должен содержать роутов, контроллеров, бизнес-логики |
| `src/api/app.ts` | Создаёт Express-приложение. Регистрирует middleware (`json`, `raw`), health-эндпоинты, подключает `src/api/routes/`, отдаёт статику из `web/dist/` (SPA fallback) |
| `src/api/types.ts` | Все DTO-интерфейсы для API: `GenerateRequest`, `MatchRequestBody`, `MatchResult`, `CreateMatchJobRequest`, `JobStatusResponse`, `JobListItem`, хелперы конвертации |
| `src/api/services/synth-service.ts` | Бизнес-логика: `generateWav()`, `matchWav()`, `matchWavWithJob()`. Работают с файловой системой, вызывают core-модули и worker-потоки. Ничего не знают про HTTP |
| `src/api/services/job-store.ts` | Хранение job-ов в `jobs/`: создание, обновление статуса, CRUD. Файлы: `<id>.json`, `<id>_input.wav`, `<id>_result.wav` |
| `src/api/controllers/synth-controller.ts` | Контроллеры: принимают `Request`, вызывают сервисы, формируют `Response`. Маппинг ошибок на HTTP-статусы |
| `src/api/routes/synth-routes.ts` | Express Router: определяет URL → controller. Только маршрутизация |

### Правила создания API
1. **server.ts не трогать для добавления роутов.** Он только запускает приложение
2. **Новый эндпоинт** → добавить контроллер → добавить роут → сервис, если бизнес-логика новая
3. **Контроллеры** — тонкие: только маппинг `Request → Service` и `Service output → Response`. Вся аудио-логика в `services/`
4. **Сервисы** не должны зависеть от Express (`req`, `res`). Чистый ввод/вывод
5. **Типы запросов/ответов** — всегда в `src/api/types.ts`

### Веб-интерфейс (`web/src/`)

Приложение построено по **Feature-Sliced Design (FSD)**:

```
web/src/
├── app/                    # Инициализация (App.tsx, index.tsx)
├── features/
│   ├── synth-generator/    # Фича генерации WAV
│   │   ├── api/            # Вызовы Backend API
│   │   ├── model/          # Типы и интерфейсы
│   │   └── ui/             # Компоненты UI
│   └── wav-matcher/        # Фича подбора параметров к WAV
│       ├── api/            # Вызовы Backend API (job CRUD)
│       ├── model/          # Типы и интерфейсы
│       └── ui/             # Компоненты UI
└── shared/
    ├── api/                # Базовый HTTP-клиент
    └── ui/                 # Переиспользуемые UI-компоненты
```

| Слой | Назначение |
|---|---|
| `shared/ui/` | Примитивы: `Button`, `Input`, `Select` |
| `shared/api/` | `fetchApi<T>` (JSON), `fetchBlob` (binary) |
| `features/synth-generator/` | Форма генерации: выбор пресета, настройка осцилляторов, плеер |
| `features/wav-matcher/` | Форма подбора: загрузка WAV, создание job, отслеживание прогресса, скачивание |
| `app/` | Точка входа, корневой компонент |

**Правила:**
1. `features` может импортировать из `shared`, но не из других `features`
2. `shared` не зависит от `features` и `app`
3. UI-компоненты используют CSS Modules (`*.module.css`)

### Деплой (Timeweb Cloud)

Проект поддерживает контейнеризацию через Docker для деплоя
на timeweb.cloud:

| Файл | Назначение |
|---|---|
| `Dockerfile` | Мультисборка: бэкенд `npm ci` + `tsc`, веб `npm ci` + `vite build` → `node dist/server.js` |
| `.dockerignore` | Исключает `node_modules`, `dist`, `web/node_modules`, `web/dist`, `*.wav`, `*.svg` |

```
docker build -t synth .
docker run -p 3000:3000 synth
```

Порт сервера управляется через переменную окружения `PORT`
(по умолчанию `3000`).

Express отдаёт статику из `web/dist/` и настроен как SPA-сервер
(fallback на `index.html`). API эндпоинты `/api/*` имеют приоритет
над статикой.

### HTTP API эндпоинты

#### Генерация и синхронный мэтчинг

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/presets` | Список доступных пресетов |
| `POST` | `/api/generate` | Генерация WAV (JSON: `preset` или `oscillators`) → WAV binary |
| `POST` | `/api/match` | Подбор параметров (JSON: `wavBase64`) → JSON с `wavBase64`, `history`, `suppressionPercent` |
| `POST` | `/api/match/binary` | Подбор параметров (raw `audio/wav`) → WAV binary |

#### Асинхронный мэтчинг (job-очередь)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/match/job` | Создать job подбора (base64 WAV) → `{ id }` |
| `POST` | `/api/match/job/json` | Создать job подбора (raw WAV binary) → `{ id }` |
| `GET` | `/api/match/jobs` | Список всех job |
| `GET` | `/api/match/jobs/:id` | Статус конкретного job |
| `GET` | `/api/match/jobs/:id/download` | Скачать результат WAV (completed job) |
| `GET` | `/api/match/jobs/:id/download-params` | Скачать параметры подбора JSON (completed job) |
| `DELETE` | `/api/match/jobs/:id` | Удалить job и связанные файлы |

## Соглашения

### TypeScript (`tsconfig.json`)
- `strict: true`
- `verbatimModuleSyntax: false`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: false`

### Субагенты
Полные инструкции субагентов — в `.opencode/agent/`.

| Триггер | Субагент | Цель |
|---|---|---|
| Создана/изменена функция | `function-decomposition-reviewer` | Ревью single responsibility |
| Новая функция / изменена сигнатура / изменена логика | `jsdoc` | Добавить JSDoc |

### Запреты
- **Non-null assertion (`!`) запрещён.** Вместо `arr[i]!` читай значение в локальную переменную с fallback (`?? 0`) или перепиши код так, чтобы тип вывелся корректно.

### Принцип защиты побочных операций
**Любой ввод/вывод, логирование, запись статуса, обновление прогресса —
может упасть в любой момент.** Файловая система, сеть, база данных,
воркер-каналы — всё это не надёжно по определению.

**Правила:**
1. **Критический путь не зависит от не-критического.** Прогресс-репорт,
   логирование, запись метаданных — не-критичны. Синтез, оптимизация,
   результат — критичны. Ошибка не-критичной операции не должна ронять
   критический процесс.
2. **Все побочные I/O на горячем пути оборачивай в try/catch.**
   Логируй ошибку, но продолжай работу. Пример: `onProgress` внутри
   `runMatchJob` вызывает `updateJobStatus` — эта запись может упасть,
   но оптимизация должна продолжаться.
3. **Файлы пиши атомарно.** Write to `.tmp` → `rename()`. При обрыве
   процесса на середине записи оригинальный файл остаётся валидным
   (или его можно восстановить из fallback).
4. **Всегда читай fallback при повреждении.** Если файл пустой,
   содержит невалидный JSON, отсутствует — создавай дефолтный record,
   а не падай с `SyntaxError` или `ENOENT`.

### Prettier (`.prettierrc`)
- `semi: true`
- `singleQuote: true`
- `trailingComma: "all"`
- `printWidth: 70`
- `tabWidth: 2`

## Важные детали

### Асимметрия маппинга
`mapSynthConfigToVector()` возвращает `10 * N` значений (N — число
осцилляторов). `mapVectorToSynthConfig()` всегда создаёт
50 осцилляторов. Round-trip расширяет 2-осцилляторный пресет до 50
(оставшиеся `on: false`). Это штатное поведение для фиксированного
генотипа.

### Worker-потоки
Оптимизация выполняется в отдельном worker-потоке
(`optimizer-worker.ts`) через `worker_threads`. `match-worker.ts`
предоставляет промис-обёртку для удобного вызова. Фронтенд использует
асинхронный job API для длительных подборов. Таймаутов нет — остановка
только по `maxIterations` или ошибке.