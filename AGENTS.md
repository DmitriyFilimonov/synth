# AGENTS.md

## Общее правило
Перед внесением изменений в любой файл проверяй его актуальное содержимое. Не полагайся на память: в файл могли внести правку другие агенты или разработчики.

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

Dev-сервер проксирует `/api`, `/health`, `/presets` на бэкенд `localhost:3000`.

## Порядок работы
1. `npm run prettier` — отформатировать код
2. `npm run build` — убедиться, что типы проходят проверку
3. `npm run dev` (или `npm run start`) — запустить и проверить результат

Для веб-интерфейса:
1. `cd web && npm run build` — убедиться, что типы проходят проверку
2. `cd web && npm run dev` — запустить dev-сервер

## Архитектура
Проект — генератор-синтезатор. Создаёт файл `.wav` (44 100 Гц, 16 бит, моно) путём аддитивного синтеза до 50 осцилляторов. Включает пайплайн подбора параметров: оптимизатор находит конфигурацию осцилляторов, воспроизводящую заданный WAV-файл, минимизируя RMS-based cancellation %. FFT не используется.

### Пайплайн подбора параметров
```
External WAV → Parse samples → Init vector → Optimize (GA + fine-tune) → Generate → Compare → Save WAV + SVG
```

### Core-модули (синтез и обработка)

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа, генерация WAV из пресета |
| `src/consts.ts` | Константы: `SAMPLE_RATE`, `SAMPLE_LENGTH_IN_SECONDS`, `MAX_AMPLITUDE_16_BIT_WAV_ENCODED` |
| `src/synth.ts` | Создание синтезатора из конфигурации осцилляторов |
| `src/envelope.ts` | Экспоненциальная функция огибающей |
| `src/oscillator.ts` | Расчёт сигнала осциллятора |
| `src/presets.ts` | Пресеты конфигураций осцилляторов |
| `src/read-wav.ts` | Чтение 16-битного WAV → `Int16Array` + метаданные (строго моно/16-бит/PCM) |
| `src/write-wav.ts` | Запись `Int16Array` в WAV-файл |
| `src/synth-config-to-vector.ts` | Нормализация конфига → вектор `number[]` `[0, 1]` |
| `src/vector-to-synth-config.ts` | Денормализация вектора → конфиг (50 осцилляторов) |
| `src/optimize.ts` | Гибридный оптимизатор: GA фаза (генетический алгоритм) → fine-tune фаза (micron-step descent) |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS-based) |
| `src/rms.ts` | Расчёт RMS энергии сигнала |
| `src/visualize.ts` | Генерация SVG-графиков |
| `src/visualize-envelopes.ts` | Визуализация огибающих первого осциллятора |
| `src/match.ts` | Оркестратор мэтчинга: read → optimize → generate → visualize |
| `src/match-preset.ts` | Начальная конфигурация для оптимизации |
| `src/match-visualize.ts` | Визуализация результатов мэтчинга (сигналы + прогресс) |
| `src/match-entry.ts` | Точка входа для запуска подбора параметров |

### HTTP-сервер (`src/api/`)

```
src/server.ts                    → Точка входа: только `createApp()` + `listen()`
src/api/app.ts                   → Создание Express, middleware, регистрация роутов
src/api/types.ts                 → DTO и интерфейсы запросов/ответов
src/api/services/synth-service.ts → Бизнес-логика: генерация и мэтчинг WAV
src/api/controllers/             → Request → Service → Response (валидация, ответы)
src/api/routes/                  → Express Router (маршрутизация)
```

| Файл | Назначение |
|---|---|
| `src/server.ts` | Точка входа HTTP-сервера. Только `createApp()` + `listen(PORT)`. Не должен содержать роутов, контроллеров, бизнес-логики |
| `src/api/app.ts` | Создаёт Express-приложение. Регистрирует middleware (`json`, `raw`), health-эндпоинты, подключает `src/api/routes/`, отдаёт статику из `web/dist/` (SPA fallback) |
| `src/api/types.ts` | Все DTO-интерфейсы для API: `GenerateRequest`, `MatchRequestBody`, `MatchResult`, хелперы конвертации |
| `src/api/services/synth-service.ts` | Бизнес-логика: `generateWav()`, `matchWav()`. Работают с файловой системой, вызывают core-модули. Ничего не знают про HTTP |
| `src/api/controllers/synth-controller.ts` | Контроллеры: принимают `Request`, вызывают сервисы, формируют `Response`. Маппинг ошибок на HTTP-статусы |
| `src/api/routes/synth-routes.ts` | Express Router: определяет URL → controller. Только маршрутизация |

### Правила создания API
1. **server.ts не трогать для добавления роутов.** Он только запускает приложение
2. **Новый эндпоинт** → добавить контроллер → добавить роут → сервис если бизнес-логика новая
3. **Контроллеры** — тонкие: только маппинг `Request → Service` и `Service output → Response`. Вся аудио-логика в `services/`
4. **Сервисы** не должны зависеть от Express (`req`, `res`). Чистый ввод/вывод
5. **Типы запросов/ответов** — всегда в `src/api/types.ts`

### Веб-интерфейс (`web/src/`)

Приложение построено по **Feature-Sliced Design (FSD)**:

```
web/src/
├── app/                    # Инициализация (App.tsx, index.tsx)
├── features/
│   └── synth-generator/    # Фича генерации WAV
│       ├── api/            # Вызовы Backend API
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
| `app/` | Точка входа, корневой компонент |

**Правила:**
1. `features` может импортировать из `shared`, но не из других `features`
2. `shared` не зависит от `features` и `app`
3. UI-компоненты используют CSS Modules (`*.module.css`)

### Деплой (Timeweb Cloud)

Проект поддерживает контейнеризацию через Docker для деплоя на timeweb.cloud:

| Файл | Назначение |
|---|---|
| `Dockerfile` | Мультисборка: бэкенд `npm ci` + `tsc`, веб `npm ci` + `vite build` → `node dist/server.js` |
| `.dockerignore` | Исключает `node_modules`, `dist`, `web/node_modules`, `web/dist`, `*.wav`, `*.svg` |

```
docker build -t synth .
docker run -p 3000:3000 synth
```

Порт сервера управляется через переменную окружения `PORT` (по умолчанию `3000`).

Express отдаёт статику из `web/dist/` и настроен как SPA-сервер (fallback на `index.html`). API эндпоинты `/api/*` имеют приоритет над статикой.

### HTTP API эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/presets` | Список доступных пресетов |
| `POST` | `/api/generate` | Генерация WAV (JSON: `preset` или `oscillators`) → WAV binary |
| `POST` | `/api/match` | Подбор параметров (JSON: `wavBase64`) → JSON с `wavBase64`, `history`, `suppressionPercent` |
| `POST` | `/api/match/binary` | Подбор параметров (raw `audio/wav`) → WAV binary |

## Соглашения

### TypeScript (`tsconfig.json`)
- `strict: true`
- `verbatimModuleSyntax: false`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: false`

### Prettier (`.prettierrc`)
- `semi: true`
- `singleQuote: true`
- `trailingComma: "all"`
- `printWidth: 70`
- `tabWidth: 2`

## Важные детали

### Асимметрия маппинга
`mapSynthConfigToVector()` возвращает `10 * N` значений (N — число осцилляторов). `mapVectorToSynthConfig()` всегда создаёт 50 осцилляторов. Round-trip расширяет 2-осцилляторный пресет до 50 (оставшиеся `on: false`). Это штатное поведение для фиксированного генотипа.

### Производительность оптимизации
Гибридный подход: GA фаза (40% итераций) исследует пространство через популяцию (40 особей, blend-crossover, adaptive mutation). Fine-tune фаза (60%) — coordinate descent с микро-шагами (`0.005` base) и stagnation-driven perturbation. При 22050 сэмплах и 100 параметрах GA быстрее находит хороший район (~5%), fine-tune медленно но стабильно улучшает результат (~7%+).