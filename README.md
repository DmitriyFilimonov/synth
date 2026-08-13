# Синтезатор

## Что это

**Synth** — генератор `.wav` файлов (44 100 Гц, 16 бит, моно) путём аддитивного синтеза. Суммирует до 50 синусоидальных осцилляторов, каждый со своей независимой огибающей частоты и амплитуды.

Также включает **пайплайн подбора параметров** к эталонным WAV-файлам: оптимизатор находит конфигурацию осцилляторов, воспроизводящую заданный звук, минимизируя RMS-based cancellation %. Оптимизация выполняется в worker-потоке, поддерживается асинхронный режим через job-очередь.

Веб-интерфейс (React + Vite) доступен при запуске HTTP-сервера на `http://localhost:3000`.

## Установка

```bash
npm install
```

## Функциональности

### 1. Генерация WAV из пресета

Создаёт WAV-файл из конфигурации осцилляторов, описанной в `src/presets.ts`.

```bash
# Без сборки
npm run dev

# С сборкой
npm run build && npm run start
```

Результат: `output15.wav`. Имя файла настраивается в `src/index.ts`.

#### Как настроить звук

Откройте `src/presets.ts`. Каждый осциллятор имеет:

| Параметр | Описание |
|---|---|
| `freqBase` | Базовая частота (Гц), к которой стремится сигнал |
| `freqStart` | Начальная частота (Гц) при t = 0 |
| `duration` | Длительность огибающей (с) |
| `slope` | Кривизна огибающей |
| `phase` | Начальная фаза (рад), от 0 до 2π |
| `ampEnv.startLevel` | Начальный уровень амплитуды |
| `ampEnv.endLevel` | Конечный уровень амплитуды |
| `ampEnv.duration` | Длительность огибающей амплитуды (с) |
| `ampEnv.slope` | Кривизна огибающей амплитуды |

```ts
import { MIN } from './envelope';

export const synthPreset1 = {
  oscillators: [
    {
      osc: { freqBase: 440, freqStart: 880, duration: 0.5, slope: 0.8, phase: 0, on: true },
      ampEnv: { startLevel: 0.5, endLevel: MIN, duration: 0.5, slope: 0.8 },
    },
  ],
};
```

### 2. Визуализация огибающих

Создаёт SVG-графики огибающих амплитуды и частоты для первого осциллятора из пресета `src/presets.ts`.

```bash
npm run viz
```

Результат: файлы `envelope-amplitude.svg` и `envelope-frequency.svg`.

Чтобы изменить визуализируемый пресет, отредактируйте `src/visualize-envelopes.ts` (строка `synthPreset1`).

### 3. Подбор параметров к WAV

Анализирует целевой WAV-файл, оптимизирует конфигурацию осцилляторов (чистый coordinate descent) и создаёт воссозданный WAV + визуализацию сравнения. Оптимизация выполняется в отдельном worker-потоке (`optimizer-worker.ts`), чтобы не блокировать основной поток.

```bash
# Запуск
npm run dev src/match-entry
```

Результат:
- `output14_reacreation.wav` — сгенерированный файл
- `output14_reacreation.wav-match.svg` — график сравнения сигналов + прогресс оптимизации

#### Как настроить подбор

Откройте `src/match-entry.ts`:

```ts
match({
  targetWavPath: './your-file.wav',      // Целевой WAV
  outputWavPath: './matched-output.wav', // Выходной WAV
  maxIterations: 2000,                   // Макс. итераций (по умолчанию 100)
  initialVector: mapSynthConfigToVector(  // Начальная точка (опционально)
    SYNTH_MULTI_PRESET(5),
  ),
  onProgress: (entry) => {               // Коллбек прогресса (опционально)
    console.log(`Iteration ${entry.iteration}: ${entry.suppressionPercent.toFixed(2)}%`);
  },
});
```

#### Алгоритм оптимизации

Оптимизатор использует чистый coordinate descent:

| Особенность | Описание |
|---|---|
| `on` параметр | Строго бинарный (`0` или `1`); при `on = 0` параметры `1-9` осциллятора пропускаются |
| `countActiveOscillators` | Запрещает отключить последний активный осциллятор |
| Шаг оптимизации | Последовательный перебор каждой координаты вектора с micro-step (`0.005`) |
| Ранний выход | `globalStagnation > 300` итераций без улучшения |

> **Важно:** оптимизация вычислительно затратна. Каждая оценка параметра генерирует полный сигнал. Рекомендуется начинать с малого `maxIterations`, постепенно увеличивая.

#### Пресеты для подбора

В `src/match-preset.ts`:

| Пресет | Описание |
|---|---|
| `SYNTH_DEFAULT_PRESET` | Один осциллятор 440 Гц |
| `SYNTH_MULTI_PRESET(n)` | `n` осцилляторов с гармониками и убывающей амплитудой |

### 4. Веб-интерфейс

React-приложение (Feature-Sliced Design) для генерации WAV и подбора параметров через браузер.

```bash
# Из корня — dev-сервер (Vite) с прокси на бэкенд:3000
cd web && npm install
cd web && npm run dev    # http://localhost:5173

# Production build
cd web && npm run build  # → web/dist/
```

Функциональность:
- **Synth Generator** — генерация WAV из пресета или ручной настройки осцилляторов
- **WAV Matcher** — загрузка WAV-файла и запуск подбора параметров (асинхронный режим через job API)
- Настройка duration и sampleRate
- Прослушивание результата в браузере
- Скачивание сгенерированного `.wav`

### 5. Форматирование и линтинг

```bash
npm run prettier       # Prettier (авто)
npm run prettier:check # Prettier (проверка)
npm run lint           # ESLint (проверка)
npm run lint:fix       # ESLint (автофикс)
```

## Технологии

- Node.js
- TypeScript
- Express (HTTP-сервер, API)
- Worker Threads (фоновая оптимизация)
- React + Vite (веб-интерфейс)
- tsx (dev-рантайм)
- Prettier + ESLint

## Как работает огибающая

`E = e^(ln(a_min) * (t / t_end)^slope)`

| Переменная | Описание |
|---|---|
| `a_min` | Минимальное значение огибающей (`0.001`) |
| `t` | Текущий момент времени (с) |
| `t_end` | Желаемая продолжительность огибающей (с) |
| `slope` | Кривизна |
| `E` | Нормализованное значение `(0; 1]` |

## Структура проекта

| Файл / Папка | Назначение |
|---|---|
| `src/index.ts` | Генерация WAV из `presets.ts` |
| `src/server.ts` | Точка входа HTTP-сервера |
| `src/api/` | Express API (контроллеры, роуты, сервисы) |
| `src/presets.ts` | Пресеты для генерации |
| `src/match-entry.ts` | Точка входа подбора параметров |
| `src/match.ts` | Оркестратор: read → optimize → generate → visualize |
| `src/match-worker.ts` | Обёртка для запуска оптимизации в worker-потоке |
| `src/optimizer-worker.ts` | Реализация worker-потока для оптимизации |
| `src/match-preset.ts` | Пресеты для начальной точки оптимизации |
| `src/match-visualize.ts` | SVG сравнения сигналов + прогресс |
| `src/optimize.ts` | Чистый coordinate descent оптимизатор с ранним выходом по стагнации |
| `src/visualize-envelopes.ts` | Генерация SVG огибающих |
| `src/visualize.ts` | Утилита для построения SVG-графиков |
| `src/synth.ts` | Создатель синтезатора |
| `src/oscillator.ts` | Расчёт сигнала осциллятора |
| `src/envelope.ts` | Экспоненциальная функция огибающей |
| `src/read-wav.ts` | Парсинг 16-бит WAV |
| `src/write-wav.ts` | Запись WAV |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS) |
| `src/rms.ts` | Расчёт RMS энергии |
| `src/synth-config-to-vector.ts` | Нормализация конфига → `[0,1]` |
| `src/vector-to-synth-config.ts` | Денормализация вектора → конфиг (50 осцилляторов) |
| `src/consts.ts` | Константы: `SAMPLE_RATE` и т.д. |
| `web/` | Веб-интерфейс (React + Vite, FSD) |
| `web/src/app/` | Инициализация приложения |
| `web/src/features/synth-generator/` | Фича генерации WAV |
| `web/src/features/wav-matcher/` | Фича подбора параметров к WAV |
 | `web/src/shared/` | Переиспользуемые компоненты и API-клиент |

**Соглашения**

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

**HTTP API эндпоинты**

#### Генерация и синхронный мэтчинг
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/presets` | Список доступных пресетов |
| `POST` | `/api/generate` | Генерация WAV (JSON: `preset` или `oscillators`) → WAV binary |
| `POST` | `/api/match` | Подбор параметров (JSON: `wavBase64`) → JSON с `wavBase64`, `history`, `suppressionPercent` |
| `POST` | `/api/match/binary` | Подбор параметров (raw `audio/wav`) → WAV binary |

#### Асинхронный мэтчинг (job‑очередь)
| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/match/job` | Создать job подбора (base64 WAV) → `{ id }` |
| `POST` | `/api/match/job/json` | Создать job подбора (raw WAV binary) → `{ id }` |
| `GET` | `/api/match/jobs` | Список всех job |
| `GET` | `/api/match/jobs/:id` | Статус конкретного job |
| `GET` | `/api/match/jobs/:id/download` | Скачать результат WAV (completed job) |
| `GET` | `/api/match/jobs/:id/download-params` | Скачать параметры подбора JSON (completed job) |
| `DELETE` | `/api/match/jobs/:id` | Удалить job и связанные файлы |

**Важные детали**

### Асимметрия маппинга
`mapSynthConfigToVector()` возвращает `10 * N` значений (N — число осцилляторов). `mapVectorToSynthConfig()` всегда создаёт 50 осцилляторов. Round‑trip расширяет 2‑осцилляторный пресет до 50 (оставшиеся `on: false`).

### Производительность оптимизации
Чистый coordinate descent: последовательная оптимизация каждой координаты вектора. Параметр `on` строго бинарный (`0` или `1`); если осциллятор выключен, его параметры `1‑9` пропускаются. Защита `countActiveOscillators` запрещает отключить последний активный осциллятор. Ранний выход: `globalStagnation > 300` итераций без улучшения.

### Worker‑потоки
Оптимизация выполняется в отдельном worker‑потоке (`optimizer‑worker.ts`) через `worker_threads`. `match‑worker.ts` предоставляет промис‑обёртку для удобного вызова. Worker имеет таймаут 30 минут.

**Структура проекта (обновлена)**

| Файл / Папка | Назначение |
|---|---|
| `src/index.ts` | Генерация WAV из `presets.ts` |
| `src/server.ts` | Точка входа HTTP‑сервера |
| `src/api/` | Express API (контроллеры, роуты, сервисы) |
| `src/presets.ts` | Пресеты для генерации |
| `src/match-entry.ts` | Точка входа подбора параметров |
| `src/match.ts` | Оркестратор: read → optimize → generate → visualize |
| `src/match-worker.ts` | Обёртка для запуска оптимизации в worker‑потоке |
| `src/optimizer-worker.ts` | Реализация worker‑потока для оптимизации |
| `src/match-preset.ts` | Пресеты для начальной точки оптимизации |
| `src/match-visualize.ts` | SVG сравнения сигналов + прогресс |
| `src/optimize.ts` | Чистый coordinate descent оптимизатор с ранним выходом по стагнации |
| `src/visualize-envelopes.ts` | Генерация SVG огибающих |
| `src/synth.ts` | Создатель синтезатора |
| `src/oscillator.ts` | Расчёт сигнала осциллятора |
| `src/envelope.ts` | Экспоненциальная функция огибающей |
| `src/read-wav.ts` | Парсинг 16‑бит WAV |
| `src/write-wav.ts` | Запись WAV |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS) |
| `src/rms.ts` | Расчёт RMS энергии |
| `src/synth-config-to-vector.ts` | Нормализация конфига → `[0,1]` |
| `src/vector-to-synth-config.ts` | Денормализация вектора → конфиг (50 осцилляторов) |
| `src/consts.ts` | Константы: `SAMPLE_RATE` и т.д. |
| `web/` | Веб‑интерфейс (React + Vite, FSD) |
| `web/src/app/` | Инициализация приложения |
| `web/src/features/synth-generator/` | Фича генерации WAV |
| `web/src/features/wav-matcher/` | Фича подбора параметров к WAV |
| `web/src/shared/` | Переиспользуемые компоненты и API‑клиент |

