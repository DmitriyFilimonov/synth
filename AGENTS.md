# AGENTS.md

## Общее правило
Перед внесением изменений в любой файл проверяй его актуальное содержимое. Не полагайся на память: в файл могли внести правку другие агенты или разработчики.

## Команды разработки

| Команда | Действие |
|---|---|
| `npm run dev` | Запуск через `tsx` без сборки |
| `npm run build` | Компиляция в `dist/` |
| `npm run start` | Запуск собранного `dist/index.js` |
| `npm run viz` | Визуализация огибающих (SVG) |
| `npm run prettier` | Форматирование источников через Prettier |
| `npm run prettier:check` | Проверка форматирования (без изменений) |
| `npm run lint` | Проверка ESLint |
| `npm run lint:fix` | Автофикс ESLint |

## Порядок работы
1. `npm run prettier` — отформатировать код
2. `npm run build` — убедиться, что типы проходят проверку
3. `npm run dev` (или `npm run start`) — запустить и проверить результат

## Архитектура
Проект — генератор-синтезатор. Создаёт файл `.wav` (44 100 Гц, 16 бит, моно) путём аддитивного синтеза до 50 осцилляторов. Оптимизатор подбирает параметры, минимизируя RMS-based cancellation % между эталоном и синтезом. FFT не используется.

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа, генерация WAV из пресета |
| `src/consts.ts` | Константы: `SAMPLE_RATE`, `SAMPLE_LENGTH_IN_SECONDS`, `MAX_AMPLITUDE_16_BIT_WAV_ENCODED` |
| `src/synth.ts` | Создание синтезатора из конфигурации осцилляторов |
| `src/envelope.ts` | Экспоненциальная функция огибающей |
| `src/oscillator.ts` | Расчёт сигнала осциллятора |
| `src/presets.ts` | Пресеты конфигураций осцилляторов |
| `src/read-wav.ts` | Чтение 16-битного WAV → `Int16Array` + метаданные |
| `src/write-wav.ts` | Запись `Int16Array` в WAV-файл |
| `src/synth-config-to-vector.ts` | Нормализация конфига → вектор `[0, 1]` |
| `src/vector-to-synth-config.ts` | Денормализация вектора → конфиг (50 осцилляторов) |
| `src/optimize.ts` | Coordinate descent оптимизатор |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS-based) |
| `src/rms.ts` | Расчёт RMS энергии сигнала |
| `src/visualize.ts` | Генерация SVG-графиков |
| `src/visualize-envelopes.ts` | Визуализация огибающих первого осциллятора |

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
