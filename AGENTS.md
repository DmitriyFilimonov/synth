# AGENTS.md

## Общее правило

Перед внесением изменений в любой файл проверяй его актуальное
содержимое. Не полагайся на память: в файл могли внести правку
другие агенты или разработчики.

Если твои изменения меняют поведение, описанное в этом файле, —
обнови соответствующую секцию AGENTS.md в том же коммите.

## Цель проекта и критерии достижения

Приоритетное направление — реверс-синтез: по эталонному WAV-файлу
подобрать конфигурацию осцилляторов аддитивного синтезатора проекта,
максимизирующую RMS-based suppressionPercent. Генерация по пресету —
вспомогательная функция, не приоритет.

### Артефакты каждого запуска реверс-синтеза

1. **JSON параметров для синтезатора** — главный (приоритетный)
   артефакт: конфигурация осцилляторов в формате `ArgCreateSynth`
   (как пресеты в `src/presets.ts`), пригодная для повторного синтеза
   без конвертации.
2. **WAV, синтезированный по подобранным параметрам** — обязателен,
   возвращается как и сейчас: пользователю нужна быстрая субъективная
   оценка результата.
3. Метаданные запуска: `suppressionPercent`, история прогресса,
   `targetInfo`.

### Автоинициализация («без ручного ввода параметров»)

Стартовая конфигурация осцилляторов (частоты, фазы, амплитуды)
формируется автоматически из анализа сигнала (FFT / Goertzel /
simple-init-vector). Пользователь задаёт только параметры прогона
(`maxIterations`, `numOscillators`, HPO-флаги и т.п.), но не начальные
значения осцилляторов.

### Целевая метрика

- Цель: `suppressionPercent ≥ 98%` (порог совпадает с early-exit
  coordinate descent).
- 100% (посэмпловое совпадение) — идеал, но маловероятен и не является
  обязательным критерием.
- Текущее состояние: ~63% J (windowed surrogate) на реальных таргетах
  после residual-guided relocation (историческое плато ~50%; анализ в
  `README.md`) — известное промежуточное состояние, а не цель: изменения
  не должны его деградировать, приоритет — приближение к 98%.
  Важно: J занижен относительно честного глобального suppression
  (оконное усреднение + спектральный член + шкала по амплитуде) —
  субъективное качество результата систематически лучше числа в job.

## Команды разработки

| Команда                  | Действие                                          |
| ------------------------ | ------------------------------------------------- |
| `npm run dev`            | Запуск через `tsx` без сборки                     |
| `npm run build`          | Компиляция в `dist/`                              |
| `npm run start`          | Запуск собранного `dist/index.js`                 |
| `npm run serve`          | Запуск собранного HTTP-сервера (`dist/server.js`) |
| `npm run serve:dev`      | Запуск HTTP-сервера через `tsx` без сборки        |
| `npm run viz`            | Визуализация огибающих (SVG)                      |
| `npm run prettier`       | Форматирование источников через Prettier          |
| `npm run prettier:check` | Проверка форматирования (без изменений)           |
| `npm run lint`           | Проверка ESLint                                   |
| `npm run lint:fix`       | Автофикс ESLint                                   |
| `npm run test`           | Заглушка тестов (not specified)                   |

### Веб-интерфейс (`web/`)

| Команда                     | Действие                                  |
| --------------------------- | ----------------------------------------- |
| `cd web && npm run dev`     | Vite dev-сервер (`http://localhost:5173`) |
| `cd web && npm run build`   | Сборка в `web/dist/`                      |
| `cd web && npm run preview` | Превью собранной сборки                   |

Dev-сервер проксирует `/api`, `/health`, `/presets` на бэкенд
`localhost:3000`.

## Порядок работы

1. `npm run prettier` — отформатировать код
2. `npm run build` — убедиться, что типы проходят проверку
3. `npm run dev` (или `npm run start`) — запустить и проверить результат

Для веб-интерфейса:

1. `cd web && npm run build` — убедиться, что типы проходят проверку
2. `cd web && npm run dev` — запустить dev-сервер

### Прогресс в чате (живой вывод команд)

opencode показывает вывод bash-команд в чате сессии вживую: чанки
stdout доставляются в карточку tool-вызова по мере поступления
(streaming metadata), пока команда выполняется. Чтобы прогресс
длинных операций (бенчи, оптимизация, подбор параметров) был виден
в чате:

- **НЕ используй `| tail` и `| head` для длинных команд** — они
  отдают строки только после завершения команды: в чате нет ничего,
  пока команда не закончится.
- Фильтруй построчно: `grep --line-buffered -E '...'` (или
  `stdbuf -oL ...`) — каждая подходящая строка сразу уходит в чат.
  Без `--line-buffered` grep буферизует вывод в пайп.
- Если нужен только итог — выведи его отдельной строкой/командой
  в конце, а не хвостом через `tail`.
- Для команд дольше ~1-2 минут задавай явный `timeout` (мс):
  дефолт bash-инструмента — 2 минуты, команда будет убита
  по таймауту.
- Скрипты и бенчи печатай построчно (`console.log`), не перезаписывай
  одну строку через `\r` — в чате останется только последнее
  состояние.
- В TUI карточку tool-вызова можно развернуть командой `/details`.

Пример правильного запуска бенча (виден живой прогресс итераций):

```bash
npx tsx /tmp/opencode/bench-full.ts 2>&1 | \
  grep --line-buffered -E 'RESULT|Iteration|Random restart|Post-pruning|After scale'
```

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

| Файл                             | Назначение                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                   | Точка входа, генерация WAV из пресета                                                                                                                                                                                                                                                               |
| `src/consts.ts`                  | Константы: `SAMPLE_RATE`, `SAMPLE_LENGTH_IN_SECONDS`, `MAX_AMPLITUDE_16_BIT_WAV_ENCODED`, `VOLUME_MIN`, `VOLUME_PRUNE_THRESHOLD`                                                                                                                                                                    |
| `src/synth.ts`                   | Создание синтезатора из конфигурации осцилляторов                                                                                                                                                                                                                                                   |
| `src/envelope.ts`                | Экспоненциальная функция огибающей: `max * (e ^ (ln(min) * (x/duration)^slope))`. `max` — начальный уровень при x=0; `min` — относительный множитель, конечный уровень при x=duration равен `max * min`. При `x > duration` время clamp'ится к `duration` (огибающая остаётся на последнем уровне). |
| `src/oscillator.ts`              | Расчёт сигнала осциллятора                                                                                                                                                                                                                                                                          |
| `src/presets.ts`                 | Пресеты конфигураций осцилляторов                                                                                                                                                                                                                                                                   |
| `src/read-wav.ts`                | Чтение 16-битного WAV → `Int16Array` + метаданные (строго моно/16-бит/PCM)                                                                                                                                                                                                                          |
| `src/write-wav.ts`               | Запись `Int16Array` в WAV-файл                                                                                                                                                                                                                                                                      |
| `src/synth-config-to-vector.ts`  | Нормализация конфига → вектор `number[]` `[0, 1]`                                                                                                                                                                                                                                                   |
| `src/vector-to-synth-config.ts`  | Денормализация вектора → конфиг (50 осцилляторов)                                                                                                                                                                                                                                                   |
| `src/optimize/`                  | Модуль оптимизации: `index.ts` (реэкспорт), `coordinate-descent.ts` (алгоритм), `evaluate.ts` (оценка suppression), `consts.ts` (константы), `types.ts` (типы), `staged.ts` (поэтапная или плоская оптимизация), `residual-relocation.ts` (relocation слабых осцилляторов на пики остатка)          |
| `src/optimize/hpo/`              | Hyperparameter optimization (Optuna-style): `run-hpo.ts` (координатор), `study.ts` (Study), `trial.ts` (Trial), `sampler.ts` (Sampler + RandomSampler), `sampler-tpe.ts` (TPE), `param-space.ts` (пространство гиперпараметров), `types.ts`                                                         |
| `src/signal-analysis.ts`         | Анализ сигналов: автокорреляция (фундаментальная частота), amplitude envelope (RMS-окна), freqOverTime (zero-crossing)                                                                                                                                                                              |
| `src/spectrogram.ts`             | STFT-анализ: Hanning window, FFT, peak detection, кластеризация гармоник в траектории, fit osc envelopes                                                                                                                                                                                            |
| `src/fft.ts`                     | Cooley-Tukey radix-2 FFT, extraction доминантных гармоник с bias к фундаментальным                                                                                                                                                                                                                  |
| `src/simple-init-vector.ts`      | Инициализация: Goertzel + STFT-гармоники для начальной точки оптимизации                                                                                                                                                                                                                            |
| `src/fft-init-vector.ts`         | FFT-инициализация на коротком окне (~23ms)                                                                                                                                                                                                                                                          |
| `src/stft-init-vector.ts`        | STFT-инициализация с траекториями (autocorr fundamental + STFT clustering)                                                                                                                                                                                                                          |
| `src/adaptive-init-vector.ts`    | Адаптивная иницализация: детекция биений через amplitude modulation, разбиение фундаментального на два близких тона                                                                                                                                                                                 |
| `src/cancellation-assessment.ts` | Оценка качества подавления (RMS-based)                                                                                                                                                                                                                                                              |
| `src/rms.ts`                     | Расчёт RMS энергии сигнала                                                                                                                                                                                                                                                                          |
| `src/visualize.ts`               | Генерация SVG-графиков                                                                                                                                                                                                                                                                              |
| `src/visualize-envelopes.ts`     | Визуализация огибающих первого осциллятора                                                                                                                                                                                                                                                          |
| `src/match.ts`                   | Оркестратор мэтчинга: read → optimize → generate → visualize                                                                                                                                                                                                                                        |
| `src/match-worker.ts`            | Обёртка для запуска оптимизации в worker-потоке                                                                                                                                                                                                                                                     |
| `src/optimizer-worker.ts`        | Реализация worker-потока: запускает optimize, генерирует WAV, визуализацию                                                                                                                                                                                                                          |
| `src/match-preset.ts`            | Начальная конфигурация для оптимизации                                                                                                                                                                                                                                                              |
| `src/match-visualize.ts`         | Визуализация результатов мэтчинга (сигналы + прогресс)                                                                                                                                                                                                                                              |
| `src/match-entry.ts`             | Точка входа для запуска подбора параметров                                                                                                                                                                                                                                                          |

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

- Мульти-цикловый подход (дефолты `DEFAULT_COORD_DESCENT_CONFIG`): `EXPLORATION` (0.025→0.01) → `REFINEMENT` (0.01→0.003) → `PRECISION` (0.0025→0.0001) — применяется к non-freq/phase параметрам
- Бюджет итераций распределяется по циклам долями от `maxIterations`: не-последние циклы получают 0.7/(n-1) бюджета каждый, финальный (PRECISION) — резерв 0.3; цикл, завершившийся по `minStep` раньше своей доли, освобождает итерации следующим циклам
- Пошаговые размеры по типам параметров: частота — трёхскоростной шаг: `frequencyStepCoarse` (0.0001 ≈ 2 Гц) в EXPLORATION, `frequencyStepRefine` (0.000005 ≈ 0.1 Гц) в REFINEMENT и `frequencyStep` (0.0000001 ≈ 0.002 Гц) в PRECISION (offsets 1-2); фаза — трёхскоростной шаг: `phaseStep` (0.003125 ≈ 1.1°) в EXPLORATION, `phaseStepRefine` (0.00078 ≈ 0.3°) в REFINEMENT, `phaseStepPrecision` (0.0002 ≈ 0.07°) в PRECISION; остальные параметры используют шаг из текущего цикла
- Плато-пинки: при `3` итерациях без улучшения — случайный пинк одного параметра; после `5` пинков — полный рандомный рестарт
- **Simulated annealing**: в `optimizeSingleParameter` кандидат, ухудшающий score на Δ п.п., принимается с вероятностью `exp(-Δ / T)`. Температура `saInitialTemp` (дефолт `3`) охлаждается геометрически `saCoolingRate` (дефолт `0.99`) **раз в итерацию, непрерывно через все циклы** (не сбрасывается на каждом цикле). В финальном цикле (PRECISION) `T = 0` — чистый greedy local search; перед входом в PRECISION геном откатывается к best-ever (SA мог уйти в худшую точку). `saInitialTemp: 0` полностью отключает SA. Эффект на честной windowed-метрике (0.1s synthPreset1, 10 osc): 300 iter — 14.9% → 32.7% (×2.2), 600 iter — 25.9% → 29.1%
- Затухание шага: при `4` итерациях без улучшения шаг × `0.9` (`stagnationStepDecayFactor`); выход из цикла, если шаг < minStep (только для non-freq/phase; частота/фаза на minStep цикла не завязаны)
- Ранний выход при достижении `98%` suppression
- Флаг-оптимизация: после каждого осциллятора в CD проверяется кандидат `flag=0`, если `volume ≤ VOLUME_PRUNE_THRESHOLD` и score улучшается — осциллятор отключается. Первый осциллятор (osc[0]) всегда остаётся включённым. `enforceFlagInvariant` удалён — состояния флагов полностью управляются CD.
- **Residual-guided relocation** (`residual-relocation.ts`): прежде чем выключать слабый осциллятор (`volume ≤ VOLUME_PRUNE_THRESHOLD`), CD пробует переставить его на доминантную частоту остатка `target − synth` (двухпроходный скан 5 Гц → 0.5 Гц, диапазон 40 Гц–10 кГц). Мотивация: CD локален (шаг частоты ~2 Гц), осциллятор с неверной стартовой частотой иначе неизбежно деградирует в `volume→0` → выключение, и сложный таргет аппроксимируется 2–5 осцилляторами вместо реального числа. Правила relocation: скан остатка — рекуррентный Goertzel (только magnitude — быстро и точно при любом k); фаза пика — прямая DFT-проекция (фаза рекуррентного Goertzel при нецелом k смещена на `frac(k)·2π` рад — relocate иначе ставит осциллятор почти в противофазу и отвергается); exclusion — только активные осцилляторы (`volume > VOLUME_PRUNE_THRESHOLD`), separation 8 Гц (плотные гребёнки покрываются полностью); минимальная амплитуда пика ~0.002 полной шкалы (слабые компоненты богатых спектров суммарно значимы для тембра); стартовая громкость = амплитуда пика, но не ниже `VOLUME_PRUNE_THRESHOLD + 0.005` (иначе relocate-нутый осциллятор сразу снова prune-кандидат); принятие — по windowed-score ПОСЛЕ greedy-прохода по 9 параметрам осциллятора (оценка потенциала, а не сырого скачка — ровная стартовая огибающая занижает немедленный выигрыш реального пика), порог `relocationMinImprovement` (дефолт 0.001 п.п.); попытки лимитированы `maxRelocationAttemptsPerOsc` (дефолт 3) — anti-cycle против relocate→mute→relocate на призрачных пиках. При отказе осциллятор проходит обычный prune-путь. `maxRelocationAttemptsPerOsc: 0` отключает relocation полностью
- Финальный прунинг и все prune-решения используют ту же windowed-метрику, что и основной цикл CD (ранее `finalPruneOscillators` считал по глобальной RMS-метрике — несовместимой шкале, и «восстановление best genome» могло вернуть вектор с худшим windowed-score)
- После completion — финальный прунинг: осцилляторы с `startLevel < VOLUME_PRUNE_THRESHOLD` (≈ 0.02) отключаются; откат если score падает > 0.05 п.п.
- Scale fitting: подбор оптимального масштаба громкости (`findOptimalScale`) после оптимизации; множитель пишется в `startLevel`, затем геном **пересинтезируется и переоценивается** (score с отмасштабированного waveform не переиспользуется)
- Volume (offset 9): мультипликативный шаг (`center * (1 ± step)`), ограничен `clampVolume` → `[VOLUME_MIN, 1]`
- Все константы алгоритма вынесены в `CoordinateDescentConfig` и могут быть переопределены через HPO. Значения по умолчанию — `DEFAULT_COORD_DESCENT_CONFIG`.
- Логи `[CoordDescent]` (Plateau kick, Step grown/decayed) выводятся через
  `optimizer-worker.ts` с отдельным троттлингом: important-сообщения `[...]`
  идут через 5ms, а `Iteration X:` прогресс — через 50ms.

### Поэтапная и плоская оптимизация (src/optimize/staged.ts)

**Режимы работы:**
Параметр `staged` (дефолт `true`) управляет режимом оптимизации.

**Staged mode (`staged: true`):**
Оптимизация идёт по нарастающим стадиям длительности сигнала (от
вычисленной `computeInitialStageMs(fundamentalHz)` до полного сигнала).
Перед каждым CD-этапом HPO на коротком сигнале подбирает
hyperparameters (шаги, пороги, decay).

```
Stage 1 (computeInitialStageMs): HPO → CD → extrapolate durations
Stage 2 (...): HPO → CD → extrapolate durations
...
Stage N (full): HPO → CD → final vector
```

**Flat mode (`staged: false`):**
Один проход HPO на полном сигнале, затем один проход CD на полном сигнале.
Без стадий, без экстраполяции длительностей. `stageDurationMultiplier` и
`initialStageMs` игнорируются.

```
Full signal: HPO → CD → final vector
```

**Параметры HPO в стадиях (staged mode):**

Стадии генерируются группами до 3 длительностей (base, base+10ms,
base+20ms), затем base × `stageDurationMultiplier`. Множитель
клампится снизу к 2.0 (иначе экспоненциальная proliferation стадий);
дефолт из `match-defaults.ts` — 2.

`computeInitialStageMs` вычисляет первую стадию из периода фундаментальной
частоты: 4..10 полных циклов, кламп [10, 100] мс. Вызывается в `match.ts`
через `estimateFundamentalFreq()` из `signal-analysis.ts` (автокорреляция).
Результат прокидывается через `stagedOptimize.fundamentalHz` →
`optimizer-worker.ts` (worker thread) → `synth-service.ts` (HTTP API, sync
и async job). Если `fundamentalHz` не определена или ≤ 0, используется
дефолт 10 мс.

- `hpoTrials` — число trials на стадию (дефолт `MATCH_DEFAULT_HPO_TRIALS = 2`;
  standalone-путь в `match.ts` дефолтит 30)
- `hpo` — вкл/выкл HPO (по умолчанию `true`). При `false` HPO полностью
  пропускается в обоих режимах (staged и flat), идёт только CD с дефолтными
  гиперпараметрами — даже если `hpoTrials` задан
- Реальное число trials на стадию масштабируется вниз для длинных стадий:
  `computeHpoTrialsForStage` (база 441 сэмпл ≈ 10ms, диапазон 3..25)
- `cdIterationsPerTrial` — фиксированные CD-итерации внутри HPO trial (дефолт 7)
- `maxIterations` — CD после HPO, управляется пользователем (дефолт 100)
- `staged` — режим оптимизации: `true` (по умолчанию) = поэтапный, `false` = один HPO + один CD на полном сигнале без стадий; при `false` `stageDurationMultiplier` и `initialStageMs` игнорируются
- `stageDurationMultiplier` — передаётся извне, множитель роста длительностей стадий, НЕ входит в пространство HPO; игнорируется при `staged: false`
- `initialStageMs` — длительность первой стадии (мс), передаётся извне, НЕ входит в HPO; если не задана, вычисляется из `fundamentalHz` через `computeInitialStageMs`; расписание стадий строится один раз до старта и не меняется
- `fundamentalHz` — фундаментальная частота (Гц), извлекается автокорреляцией (`signal-analysis.ts`); если передана, `initialStageMs` вычисляется автоматически: 4..10 циклов, кламп [10, 100] мс
- `hasUserOverride` — оба `stepGrowthAdd` И `stepDecayFactor` заданы,
  либо `hpo === false` → HPO полностью отключается, идёт чистый CD
  с дефолтными гиперпараметрами; при `hpo: false` HPO не запускается
  ни в staged, ни в flat режиме
- Guard от регрессии HPO: `bestVector` принимается только если его
  windowed-score на окне стадии ≥ score входного (экстраполированного)
  вектора; иначе CD стартует с входного вектора
- Экстраполяция длительностей между стадиями использует диапазоны
  нормализации из `synth.ts` (`[1/44100, 0.5]` с) — тот же источник
  истины, что и `vector-to-synth-config.ts`
- Наблюдения (params → value) кумулятивно передаются между стадиями через
  `initialObservations` — TPE строит модель на всей истории, не теряя данные
- `nStartupTrials` адаптивен: 1 при ≤3 trials, 2 при ≤8, 5 при ≤20, иначе 10
- `bandwidth` адаптивен: 2.5x при 2 наблюдениях, 1.8x при ≤5, 1.3x при ≤15, 1x при 15+

**ProgressEntry поля:**

- `phase` — `'hpo'` или `'cd'` (разделение в UI)
- `iterationOffset` — кумулятивный сдвиг итераций между стадиями (только CD, HPO не считается)

### HPO (src/optimize/hpo/)

Оптимизация гиперпараметров координатного спуска в стиле Optuna.
Используется как внутри staged optimization (per-stage), так и самостоятельно.

**Принцип работы (standalone):**

1. FFT инициализирует параметры осцилляторов (начальный вектор)
2. HPO-координатор запускает N trials
3. В каждом trial TPE-сэмплер предлагает гиперпараметры (шаги, пороги, decay factors)
4. Coordinate descent запускается с `cdIterationsPerTrial` (дефолт 7)
5. Полученный suppressionPercent возвращается в TPE для обновления модели
6. После всех trials возвращается лучшая комбинация гиперпараметров + вектор
7. Финальный CD запускается с лучшими гиперпараметрами на `cdIterationsPerTrial`

**Компоненты:**

- `Study` + `Trial` — управление trials, Optuna-style API (`suggestFloat`, `suggestInt`, `suggestCategorical`)
- `Sampler` — интерфейс алгоритмов выборки
- `RandomSampler` — равномерная выборка (baseline + warmup)
- `TPESampler` — Tree-structured Parzen Estimator (основной алгоритм)
- `runHPO` — координатор: trial → hyperparams → coordinateDescent → suppression → TPE update
- `param-space.ts` — пространство гиперпараметров с диапазонами и дефолтами

**Архитектура TPE:**

- Разделяет trials на «good» (лучшие γ%) и «bad» (остальные)
- Строит KDE l(x) = P(x|good) и g(x) = P(x|bad) для каждого параметра
- Сэмплирует кандидатов из l(x), выбирает по max l(x)/g(x) ratio
- `nStartupTrials` адаптивен: зависит от числа trials (см. ниже), НЕ фиксирован
- `bandwidth` адаптивен: зависит от числа accumulated observations

**Кумулятивные наблюдения между стадиями:**
При staged-оптимизации каждое завершённое HPO-наблюдение (params → value)
передаётся в следующую стадию через `initialObservations`. TPE строит модель
по всей истории, а не только по текущей стадии — это предотвращает сужение
диапазона гиперпараметров на поздних этапах.

**Адаптивные параметры TPE:**

- `nStartupTrials`: 1 при ≤3 trials, 2 при ≤8, 5 при ≤20, иначе 10
  (вместо фиксированных 10, что блокировало TPE при nTrials=2)
- `bandwidth` (KDE kernel): 2.5×base при 2 наблюдениях, 1.8× при ≤5,
  1.3× при ≤15, 1× при 15+ (шире на ранних стадиях для эксплорации)

**Пространство гиперпараметров (HYPERPARAM_SPACE):**

- `stepGrowthAdd` — [0.0001, 0.01] (log)
- `stepDecayFactor` — [0.85, 0.995]
- `explorationStartStep` — [0.005, 0.1]
- `explorationMinStep` — [0.001, 0.05]
- `refinementStartStep` — [0.001, 0.05]
- `refinementMinStep` — [0.0005, 0.02]
- `precisionStartStep` — [0.0005, 0.02]
- `precisionMinStep` — [1e-6, 0.002] (log)
- `stagnationExitThreshold` — 2..12
- `stagnationDecayFactor` — [0.5, 0.95]
- `plateauRestartThreshold` — 2..10
- `stepGrowthThreshold` — 2..15
- `significantImprovementThreshold` — [0.0005, 0.1] (log)
- `earlyExitSuppression` — [90, 99.9]
- `maxRestartsBeforeRandomRestart` — 2..10
- `kickFallbackThreshold` — [0.5, 0.95]
- `frequencyStep` — [5e-8, 5e-7] (log) — мелкий шаг freqBase/freqStart в PRECISION, дефолт 0.0000001
- `frequencyStepCoarse` — [1e-5, 5e-4] (log) — грубый шаг freqBase/freqStart в EXPLORATION, дефолт 0.0001
- `frequencyStepRefine` — [1e-6, 1e-5] (log) — средний шаг freqBase/freqStart в REFINEMENT, дефолт 0.000005
- `phaseStep` — [0.0015, 0.006] — шаг для phase (offset 5) в EXPLORATION, дефолт 0.003125 ≈ 1.1°
- `phaseStepRefine` — [0.0003, 0.002] — шаг для phase в REFINEMENT, дефолт 0.00078 ≈ 0.3°
- `phaseStepPrecision` — [0.00005, 0.0005] — шаг для phase в PRECISION, дефолт 0.0002 ≈ 0.07°
- `saInitialTemp` — [0.5, 8] — начальная температура simulated annealing (в п.п. score), дефолт 3
- `saCoolingRate` — [0.95, 0.999] — геометрический коэффициент охлаждения SA за итерацию, дефолт 0.99

> `iterations` НЕ является гиперпараметром — пользователь контролирует через
> `maxIterations`. `stageDurationMultiplier`, `initialStageMs` и `staged` также
> исключены из HPO и передаются независимо. Внутри HPO trial CD запускается
> на `cdIterationsPerTrial` (дефолт 7).

#### Стоимость оценки кандидата

`WaveformCache` (`evaluate.ts`) пересинтезирует только вклад
затронутого осциллятора (O(n) вместо O(n·m) полного ресинтеза) —
инкрементальная сумма поддерживается в актуальном состоянии.
Спектральный профиль таргета (`SpectralProfile`, 5 доминантных
частот Goertzel-сканом 20–5000 Гц) инвариантен и вычисляется один раз
на запуск оптимизации. Оставшаяся стоимость одной пробы: синтез одного
осциллятора O(n) + windowed-оценка O(n) — сотни проб на итерацию
(~540 при 30 активных осцилляторах). Любая правка оптимизатора не
должна увеличивать число проб кандидатов без необходимости.

#### Параметры coordinate descent

Все константы алгоритма параметризованы через `CoordinateDescentConfig`
и могут быть переопределены при вызове `coordinateDescent()`. Значения
по умолчанию — `DEFAULT_COORD_DESCENT_CONFIG`. HPO подбирает оптимальные
значения этих параметров через TPE-сэмплер.

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

| Файл                                      | Назначение                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server.ts`                           | Точка входа HTTP-сервера. Только `createApp()` + `listen(PORT)`. Не должен содержать роутов, контроллеров, бизнес-логики                                           |
| `src/api/app.ts`                          | Создаёт Express-приложение. Регистрирует middleware (`json`, `raw`), health-эндпоинты, подключает `src/api/routes/`, отдаёт статику из `web/dist/` (SPA fallback)  |
| `src/api/types.ts`                        | Все DTO-интерфейсы для API: `GenerateRequest`, `MatchRequestBody`, `MatchResult`, `CreateMatchJobRequest`, `JobStatusResponse`, `JobListItem`, хелперы конвертации |
| `src/api/services/synth-service.ts`       | Бизнес-логика: `generateWav()`, `matchWav()`, `matchWavWithJob()`. Работают с файловой системой, вызывают core-модули и worker-потоки. Ничего не знают про HTTP    |
| `src/api/services/job-store.ts`           | Хранение job-ов в `jobs/`: создание, обновление статуса, CRUD. Файлы: `<id>.json`, `<id>_input.wav`, `<id>_result.wav`                                             |
| `src/api/controllers/synth-controller.ts` | Контроллеры: принимают `Request`, вызывают сервисы, формируют `Response`. Маппинг ошибок на HTTP-статусы                                                           |
| `src/api/routes/synth-routes.ts`          | Express Router: определяет URL → controller. Только маршрутизация                                                                                                  |

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

| Слой                        | Назначение                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- |
| `shared/ui/`                | Примитивы: `Button`, `Input`, `Select`, `AudioPlayer`                         |
| `shared/api/`               | `fetchApi<T>` (JSON), `fetchBlob` (binary)                                    |
| `features/synth-generator/` | Форма генерации: выбор пресета, настройка осцилляторов                        |
| `features/wav-matcher/`     | Форма подбора: загрузка WAV, создание job, отслеживание прогресса, скачивание |
| `app/`                      | Точка входа, корневой компонент                                               |

**Правила:**

1. `features` может импортировать из `shared`, но не из других `features`
2. `shared` не зависит от `features` и `app`
3. UI-компоненты используют CSS Modules (`*.module.css`)

### Дизайн-система веб-интерфейса

UI построен на основе тёмной инженерной темы (Ableton-стиль):

- Корневые цвета: `#121212`, поверхности `#1e1e1e` / `#2a2a2a`
- Акцент: `#e67e22` (оранжевый)
- Шрифты: `Inter` (UI), `JetBrains Mono` (значения/данные)
- Компактная, плотная компоновка с радиусами `2px`
- Все токены через CSS custom properties в `web/src/global.css`
- При изменениях UI — используй токены из `global.css`, не хардкодь цвета

| Файл                                                    | Назначение                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `web/src/global.css`                                    | Токены, глобальный ресет, тёмная тема (CSS variables)         |
| `web/src/app/App.tsx` / `.module.css`                   | Корневой лейаут, тёмный хедер, секции                         |
| `web/src/shared/ui/`                                    | Shared-компоненты: `Button`, `Input`, `Select`, `AudioPlayer` |
| `web/src/features/synth-generator/ui/GeneratorForm.tsx` | Форма генерации (тёмные карточки, OSC-карточки)               |
| `web/src/features/wav-matcher/ui/MatcherForm.tsx`       | Форма подбора (тёмные job-карточки, прогресс-бары, графики)   |

### Деплой (Timeweb Cloud)

Проект поддерживает контейнеризацию через Docker для деплоя
на timeweb.cloud:

| Файл            | Назначение                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------ |
| `Dockerfile`    | Мультисборка: бэкенд `npm ci` + `tsc`, веб `npm ci` + `vite build` → `node dist/server.js` |
| `.dockerignore` | Исключает `node_modules`, `dist`, `web/node_modules`, `web/dist`, `*.wav`, `*.svg`         |

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

| Метод  | Путь                | Описание                                                                                    |
| ------ | ------------------- | ------------------------------------------------------------------------------------------- |
| `GET`  | `/health`           | Health check                                                                                |
| `GET`  | `/presets`          | Список доступных пресетов                                                                   |
| `POST` | `/api/generate`     | Генерация WAV (JSON: `preset` или `oscillators`) → WAV binary                               |
| `POST` | `/api/match`        | Подбор параметров (JSON: `wavBase64`) → JSON с `wavBase64`, `history`, `suppressionPercent` |
| `POST` | `/api/match/binary` | Подбор параметров (raw `audio/wav`) → WAV binary                                            |

#### Асинхронный мэтчинг (job-очередь)

| Метод    | Путь                                  | Описание                                        |
| -------- | ------------------------------------- | ----------------------------------------------- |
| `POST`   | `/api/match/job`                      | Создать job подбора (base64 WAV) → `{ id }`     |
| `POST`   | `/api/match/job/json`                 | Создать job подбора (raw WAV binary) → `{ id }` |
| `GET`    | `/api/match/jobs`                     | Список всех job                                 |
| `GET`    | `/api/match/jobs/:id`                 | Статус конкретного job                          |
| `GET`    | `/api/match/jobs/:id/download`        | Скачать результат WAV (completed job)           |
| `GET`    | `/api/match/jobs/:id/download-params` | Скачать параметры подбора JSON (completed job)  |
| `DELETE` | `/api/match/jobs/:id`                 | Удалить job и связанные файлы                   |

## Соглашения

### TypeScript (`tsconfig.json`)

- `strict: true`
- `verbatimModuleSyntax: false`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: false`

### Субагенты

Полные инструкции субагентов — в `.opencode/agent/`.

Команда `/develop` — инструмент запуска цикла: criteria-match →
исправление FAIL/WARN → повтор до `READY` (см.
`.opencode/command/develop.md`).

| Триггер                                              | Субагент                          | Цель                                           |
| ---------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| Создана/изменена функция                             | `function-decomposition-reviewer` | Ревью single responsibility                    |
| Новая функция / изменена сигнатура / изменена логика | `jsdoc`                           | Добавить JSDoc                                 |
| Правки `src/optimize/` или смежных core-модулей      | `optimizer-reviewer`              | Проверка контрактов + A/B качества (read-only) |
| После каждого выполненного задания                   | `criteria-match`                  | Сводная проверка критериев + коммит изменений итерации |
| Из `criteria-match` (primary) или напрямую от основного агента (fallback по файловому протоколу) | `single-criteria-*` (5 шт.) | Проверка одного конкретного критерия |
| Задачи окружения (Docker, логи, инструменты)         | `infra-agent`                     | Деплой в локальный Docker, сбор логов, свои LLM-инструменты |

#### Цикл проверки целей (criteria-match)

Связь не зависит от конфиг-ключей opencode (типа `subagent_depth`):
это два пути — запуск через task (primary) и файловый протокол
(fallback) через `.opencode/criteria/`.

1. **Запуск**: после каждого выполненного задания основной агент
   вызывает субагента `criteria-match`, передавая описание изменений.
2. **Проверка**: `criteria-match` запускает всех `single-criteria-*`
   субагентов (по одному на критерий из секции «Цель проекта и
   критерии достижения») параллельно через task. Если task для него
   недоступен (версия opencode не позволяет субагентам запускать
   субагентов) — используется файловый протокол: `criteria-match`
   пишет файл-заявку в `.opencode/criteria/requests/` и возвращает
   `NEEDS_RUN`; основной агент запускает `single-criteria-*`
   напрямую, те записывают отчёты в `.opencode/criteria/reports/`,
   а `criteria-match` при повторном вызове читает эти файлы.
   Каждый `single-criteria-*` субагент всегда записывает отчёт
   в `.opencode/criteria/reports/<id>.md` (PASS/WARN/FAIL),
   независимо от того, кто его вызвал.
3. **Агрегация**: `criteria-match` собирает отчёты (из возвратов
   task или из файлов) и возвращает сводный вердикт: `READY`
   или `NOT READY`.
4. **Цикл**: при `NOT READY` основной агент исправляет указанные
   нарушения и снова вызывает `criteria-match` — цикл повторяется
   до `READY` (полное соответствие критериям проекта).
5. Отчёты и состояние (baseline suppressionPercent, вердикты)
   хранятся в `.opencode/criteria/` и не коммитятся.
6. **Критерии/цели проекта не могут быть изменены ни одним агентом,
   субагентом или инструментом без явного согласования с
   пользователем.** `criteria-match` лишь фиксирует расхождения.
7. **Коммит делает criteria-match**: субагент `criteria-match`
   коммитит изменения итерации после каждого цикла проверки
   (`git add` + `git commit`, сообщение — по стилю репозитория,
   см. `git log`), не дожидаясь достижения целей проекта. Вердикт
   коммит не блокирует: при `NOT READY` изменения итерации всё равно
   коммитятся (это прогресс), а цикл проверки продолжается. Если
   изменений вне `.opencode/criteria/` нет — коммит не делается.
   `.opencode/criteria/` (отчёты, заявки, состояние) никогда не
   коммитится. В коммит входит и обновление AGENTS.md, если
   поведение, описанное в нём, менялось (см. «Общее правило»).

#### Права доступа субагентов (анти-зависание)

Сервер opencode работает headless (`opencode serve`): пользователь
подключается удалённо, и permission-запросы (`ask`) в момент разрыва
соединения никто не может подтвердить — субагент зависает навсегда.
Поэтому:

- Глобально (`opencode.json`): `external_directory: "allow"` — внешние
  пути (вне рабочей директории) не запрашивают подтверждения.
- У **каждого** субагента (frontmatter в `.opencode/agent/*.md`):
  - `external_directory`: allow только `/tmp/**`, `/etc/**`, `/proc/**`,
    всё остальное — `deny` (мгновенная ошибка инструмента вместо
    бесконечного ожидания; субагент адаптируется, например, пишет
    в `/tmp`);
  - `question: deny` — субагенты не спрашивают пользователя;
  - свои `edit`/`bash` ограничения (см. файлы агентов).
- `criteria-match` — единственный субагент с bash: allow-лист
  git-команд (`git add`/`commit`/`status`/`diff`/`log`), всё
  остальное — `deny`: он делает коммиты изменений итерации.
- Правила применяются при старте opencode: после изменения конфига
  или frontmatter нужен рестарт `opencode serve`.

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

### Мусор в корне репозитория

- `*.wav`, `*.asd`, `*.svg`, `jobs/` — генерируемые артефакты,
  в `.gitignore`. Не коммить и не опирайся на их наличие.
  Исключение: `docs/img/*.svg` — статические иллюстрации для
  README (графики чувствительности метрики), они в git.
- `test-*.ts` и `tmp_opt_test.js` в корне — одноразовые
  отладочные скрипты (закоммичены, но вне `tsconfig` `include: ["src"]`).
  Это НЕ тестовый набор: `npm run test` — заглушка. Не добавляй туда
  новые файлы; новый код — только в `src/`.
- Prettier/ESLint покрывают только `src/**/*.ts` (см. scripts).

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
