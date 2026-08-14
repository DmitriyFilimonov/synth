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

Оптимизатор использует coordinate descent с мульти-цикловым подходом:

| Особенность | Описание |
|---|---|
| Циклы оптимизации | Три фазы: `EXPLORATION` (шаг 0.05→0.01) → `REFINEMENT` (0.02→0.005) → `PRECISION` (0.005→0.001) |
| Плато-пинки | При `3` итерациях без улучшения — случайное изменение одного параметра |
| Random restart | После `5` пинков — полный рандомный перезапуск генома |
| Затухание шага | При `4` итерациях без улучшения шаг умножается на `0.8` |
| `on` параметр | Строго бинарный (`0` или `1`); при `on = 0` параметры `1-9` осциллятора пропускаются |
| `enforceFlagInvariant` | Гарантирует, что осцилляторы с `volume > VOLUME_MIN` включены; все до rightmostEnabled — тоже |
| Оконечная оценка | `evaluateSuppressionWindowed` — score по 100ms окнам + спектральный scoring (Goertzel) + penalty |
| Scale fitting | После оптимизации подбирается оптимальный масштаб громкости |
| Финальный прунинг | Осцилляторы с `startLevel < VOLUME_PRUNE_THRESHOLD` последовательно отключаются |
| Ранний выход | Достижение `98%` suppression или окончание всех циклов |

> **Важно:** оптимизация вычислительно затратна. Каждая оценка параметра пересинтезирует полный сигнал. Windowed-evaluation оценивает качество по коротким окнам (100ms) с оптимальным scale + спектральным score через Goertzel-алгоритм.

#### Инициализация вектора

Для подбора параметров доступны стратегии создания начального вектора:

| Файл | Описание |
|---|---|
| `src/simple-init-vector.ts` | Goertzel-анализ + STFT-гармоники. Определяет sweep (freqOverTime + amplitude envelope), извлекает фазы/амплитуды через Goertzel, дополняет STFT-траекториями |
| `src/fft-init-vector.ts` | FFT на коротком окне (~23ms) — детекция доминантных гармоник для инициализации частот, фаз и амплитуд |
| `src/stft-init-vector.ts` | STFT-анализ + кластеризация гармоник + fit envelope. Авто-фундаментальная частота через автокорреляцию, amplitude envelope через RMS-окна |
| `src/adaptive-init-vector.ts` | Адаптивная инициализация: определяет биения (amplitude modulation), разбивает фундаментальный тон на два близких, добавляет STFT-гармоники |

Вспомогательные модули анализа сигналов:

| Файл | Назначение |
|---|---|
| `src/signal-analysis.ts` | Автокорреляция (фундаментальная частота), amplitude envelope (RMS-окна), freqOverTime (zero-crossing rate) |
| `src/spectrogram.ts` | STFT-анализ: Hanning window, FFT, peak detection, кластеризация гармоник в траектории, fit osc envelopes |
| `src/fft.ts` | Cooley-Tukey radix-2 FFT, extraction доминантных гармоник с bias к фундаментальным частотам |

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

Когда `t > t_end`, время clamp'ится к `t_end` — огибающая остаётся на последнем вычисленном уровне. Частота и громкость осциллятора продолжают использовать это финальное значение до окончания генерации.

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
| `src/optimize/` | Модуль оптимизации: `index.ts` (реэкспорт), `coordinate-descent.ts` (алгоритм), `evaluate.ts` (оценка), `consts.ts` (константы), `types.ts` (типы) |
| `src/signal-analysis.ts` | Анализ сигналов: автокорреляция, amplitude envelope, freqOverTime |
| `src/spectrogram.ts` | STFT-анализ: Hanning window, FFT, peak detection, кластеризация, fit envelopes |
| `src/fft.ts` | Cooley-Tukey radix-2 FFT, extraction доминантных гармоник |
| `src/simple-init-vector.ts` | Инициализация: Goertzel + STFT-гармоники |
| `src/fft-init-vector.ts` | FFT-инициализация на коротком окне (~23ms) |
| `src/stft-init-vector.ts` | STFT-инициализация с траекториями |
| `src/adaptive-init-vector.ts` | Адаптивная инициализация: детекция биений через amplitude modulation |
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
| `src/consts.ts` | Константы: `SAMPLE_RATE`, `VOLUME_MIN`, `VOLUME_PRUNE_THRESHOLD` |
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
Coordinate descent с мульти-цикловым подходом (EXPLORATION → REFINEMENT → PRECISION). На каждой итерации последовательно оптимизируется каждая координата активного осциллятора. Параметр `on` строго бинарный (`0` или `1`); отключённые осцилляторы пропускаются. Оценка через `evaluateSuppressionWindowed`: средний score по 100ms окнам + оптимальный scale + спектральный score (Goertzel на доминантных частотах) + shape penalty. Плато-пинки и random restarts для выхода из локальных оптимумов. Финальный scale fitting и прунинг тихих осцилляторов.

### Worker‑потоки
Оптимизация выполняется в отдельном worker‑потоке (`optimizer‑worker.ts`) через `worker_threads`. `match‑worker.ts` предоставляет промис‑обёртку для удобного вызова. Таймаутов нет — остановка только по `maxIterations` или ошибке.

### Устойчивость к сбоям
Все побочные I/O на горячем пути (прогресс‑репорты, запись статуса, логирование) оборачиваются в `try/catch` — ошибка не‑критичной операции не роняет процесс. Файлы пишутся атомарно через `.tmp` → `rename()`, при повреждении или отсутствии job‑файла создаётся fallback‑record.

