# Синтезатор

## Что это

**Synth** — генератор `.wav` файлов (44 100 Гц, 16 бит, моно) путём аддитивного синтеза. Суммирует до 50 синусоидальных осцилляторов, каждый со своей независимой огибающей частоты и амплитуды.

Также включает **пайплайн подбора параметров** к эталонным WAV-файлам: оптимизатор находит конфигурацию осцилляторов, воспроизводящую заданный звук, минимизируя RMS-based cancellation %.

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

Анализирует целевой WAV-файл, оптимизирует конфигурацию осцилляторов (гибридный GA + fine-tune) и создаёт воссозданный WAV + визуализацию сравнения.

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

Двухфазный workflow:

| Фаза | Доля итераций | Что делает |
|---|---|---|
| GA (генетический алгоритм) | 40% | Исследует пространство через популяцию (40 особей, blend-crossover, adaptive mutation). Быстро находит хороший район (~5% suppression). |
| Fine-tune (micron-step descent) | 60% | Точная подстройка координат (шаг `0.005`) с stagnation-driven perturbation. Медленно улучшает до ~7%+. |

> **Важно:** оптимизация вычислительно затратна. Каждая оценка параметра генерирует полный сигнал. 500 итераций на 22 050 сэмплах — десятки минут. Рекомендуется начинать с малого `maxIterations`, постепенно увеличивая.

#### Пресеты для подбора

В `src/match-preset.ts`:

| Пресет | Описание |
|---|---|
| `SYNTH_DEFAULT_PRESET` | Один осциллятор 440 Гц |
| `SYNTH_MULTI_PRESET(n)` | `n` осцилляторов с гармониками и убывающей амплитудой |

### 4. Веб-интерес

React-приложение (Feature-Sliced Design) для генерации WAV через браузер.

```bash
# Из корня — dev-сервер (Vite) с прокси на бэкенд:3000
cd web && npm install
cd web && npm run dev    # http://localhost:5173

# Production build
cd web && npm run build  # → web/dist/
```

Функциональность:
- Генерация WAV из пресета или ручной настройки осцилляторов
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
| `src/match-preset.ts` | Пресеты для начальной точки оптимизации |
| `src/match-visualize.ts` | SVG сравнения сигналов + прогресс |
| `src/optimize.ts` | Гибридный оптимизатор: GA → fine-tune (micron-step descent) |
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
| `web/src/features/` | Фичи (синтез-генератор) |
| `web/src/shared/` | Переиспользуемые компоненты и API-клиент |