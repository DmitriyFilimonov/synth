# Анализ проекта Synth

## Что делает проект

**Synth** — генератор `.wav` файлов (44 100 Гц, 16 бит, моно) путём аддитивного синтеза. Суммирует до 50 синусоидальных осцилляторов, каждый со своей независимой огибающей частоты и амплитуды.

Формулы:

- **Огибающая**: `E = e^(ln(min) * (t / duration)^slope)`
- **Осциллятор**: `y = sin(t * f * 2π + φ) * a`

Итоговый сигнал — сумма всех осцилляторов с клиппингом в [-1, 1].

## Зачем нужен проект

Проект — это **синтезатор-генератор для подбора параметров к эталонным WAV-файлам**. Модули `synth-config-to-vector.ts` и `vector-to-synth-config.ts` нормализуют параметры осцилляторов в числовые векторы `[0, 1]` и обратно — это паттерн genotype для оптимизации.

**Предполагаемый сценарий:**

1. Берётся эталонный WAV-файл (качественный 16-битный моно)
2. Оптимизатор подбирает числовой вектор, минимизируя разницу между эталоном и сгенерированным звуком
3. Результат — набор параметров синтеза, воспроизводящих эталон
4. Выявление зависимостей между параметрами → генерация новых качественных звуков

---

## Пайплайн подбора параметров

```
External WAV → Parse samples → Analyze signal → Define loss → Optimize → Generate → Compare
```

### Что реализовано

| Этап | Статус | Файлы |
|---|---|---|
| Generate wav | ✔ Готово | `src/synth.ts`, `src/oscillator.ts`, `src/envelope.ts`, `src/write-wav.ts` |
| Config ↔ Vector mapping | ✔ Готово (с багами) | `src/synth-config-to-vector.ts`, `src/vector-to-synth-config.ts` |
| Визуализация функций | ✔ Готово | `src/visualize.ts`, `src/visualize-envelopes.ts` |
| Чтение WAV | ✔ Готово | `src/read-wav.ts` |
| Оценка качества (RMS cancellation %) | ✔ Готово | `src/cancellation-assessment.ts`, `src/rms.ts` |
| Оптимизатор (coordinate descent) | ✔ Готово | `src/optimize.ts` |

### Что отсутствует (нужно построить с нуля)

| # | Компонент | Что делает | Приоритет |
|---|---|---|---|
| 1 | **Оркестратор мэтчинга** (`src/match.ts`) | Связывает всё: read WAV → init vector → optimize → generate → save result | Критично |
| 2 | **Визуализатор сравнения** | SVG: оригинал, синтез, остаток (разница), график прогресса оптимизации | Средне |

Замечание: в репозитории лежат артефакты прототипного мэтчинга (`match-result-*.svg`), но сам код оркестратора не закоммичен. По названиям видно, что прототип использовал «cancellation %» как метрику качества.

Проект **не использует FFT** — сравнение сигналов идёт через RMS-based cancellation assessment (`cancellation-assessment.ts`), что достаточно для задачи подбора параметров.

---

## Баги текущего кода

### Критический

**`src/synth.ts`, строка 155** — частотная огибающая не работает:

```typescript
modulation: config.osc.freqStart - config.osc.freqStart,
```

Всегда даёт `0`. Частота остаётся постоянной (`freqBase`), параметр `freqStart` игнорируется. Должно быть:

```typescript
modulation: config.osc.freqStart - config.osc.freqBase,
```

Доказательство того, что автор хотел именно это: в `src/visualize-envelopes.ts:36` та же формула написана правильно:

```typescript
const mod = firstOsc.osc.freqStart - firstOsc.osc.freqBase;
```

### Средние

| Файл | Проблема |
|---|---|
| `src/synth-config-to-vector.ts:52-56` | `endLevel ?? 0` нормализуется от нуля вместо `min` (`ampEnvNormales.endLevel.min`), что даёт некорректное значение при `undefined` |
| `src/vector-to-synth-config.ts` | Денормализованные значения не клиппируются в `[min, max]` — оптимизатор может выдать значения за пределами диапазона |
| `src/index.ts:6-7, 23` | `SAMPLE_RATE = 44100` дублируется из `consts.ts`; `DURATION_SECONDS = 0.5` и имя файла `output15.wav` захардкожены |
| Репозиторий | Генерации (`.wav`, `.asd`, `.svg`) лежат в корне, но добавлены в `.gitignore` и не отслеживаются git |

### Мелкие

| Проблема | Файл |
|---|---|
| Опечатки в именах типов (`Frequncy`, `Envelop`, `Evelop`) | `synth.ts`, `envelope.ts` |
| Пустой интерфейс `ArgOscillatorCreator` (ESLint warning) | `oscillator.ts:7` |
| Нет тестов. `npm test` — stub | `package.json:11` |
| `AGENTS.md` расходится с `tsconfig.json` (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`) | Документация |

---

## Асимметрия в маппинге вектора

`mapSynthConfigToVector()` возвращает `10 * N` кортежей (где `N` — число осцилляторов в конфиге). `mapVectorToSynthConfig()` **всегда** создаёт ровно 50 осцилляторов. Round-trip (config → vector → config) расширяет 2-осцилляторный пресет до 50 (48 будут `on: false`). Это штатное поведение для эволюционного алгоритма (фиксированный генотип), но требует документации.

---

## Что нужно исправить перед началом работ

1. **Критический баг** `synth.ts:155` — без него частотная огибающая не работает, оптимизация бессмысленна
2. **Клиппинг денормализации** в `vector-to-synth-config.ts`
3. **`endLevel ?? MIN`** вместо `?? 0` в `synth-config-to-vector.ts`
4. **Убрать `SAMPLE_RATE` дублирование** в `index.ts`, импортировать из `consts.ts`
