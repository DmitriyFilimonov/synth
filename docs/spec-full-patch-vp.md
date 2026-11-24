# Offline full-patch variable projection с LM

## Статус

Core `src/dataset/full-patch-vp.ts` и offline runner
`src/dataset/full-patch-vp-run.ts` реализованы, но реальный эксперимент ещё
не запускался. Текущие CD, slot-post-pass, frozen-delay и
localized-контролы не достигли 98%. Производственный match, enhance и API
этот документ не подключает. Synthetic known-answer проверяет runner и
solver, но не является результатом на реальных таргетах.

## Что проверяем

Проверяем, может ли согласованное изменение форм всех активных
осцилляторов превзойти покоординатный CD и локальные K1/K2-замены.
Уровень и фазу каждого осциллятора после каждого изменения формы заново
решает совместный solver. Наружный LM-шаг использует аналитический
Jacobian всего патча.

Если локальный бассейн не содержит лучшего решения, отрицательный
результат не доказывает невозможность 98% вообще. Он лишь отклоняет
данный solver при зафиксированном составе и бюджете.

## Параметры

Для каждого активного осциллятора наружные оси:

- `freqBase`;
- `freqStart`;
- `osc.slope`;
- `osc.duration`;
- `ampEnv.duration`;
- `ampEnv.endLevel`;
- `ampEnv.slope`.

Положительные поля представляются в логарифмических координатах с
явными физическими границами. Для каждого осциллятора внутренние
квадратуры:

```
sineCoefficient = startLevel * cos(phase)
cosineCoefficient = startLevel * sin(phase)
```

Обратный переход использует `hypot` и `atan2`. Норма каждой пары лежит
в `[0.001, 1]` с явной ulp-канонизацией только на численной границе.

On/off, off-слоты, `delay`, `attack`, `hardStop` и все другие поля
остаются неизменными. Патч нельзя пропускать через текущий
десятипараметровый вектор: он не представляет localized-поля.

## Аналитический Jacobian

Для каждой наружной оси нужна производная вклада осциллятора при
текущих решённых квадратурах. Значения и производные должны совпадать с
фактическим sample renderer.

- Integral phase использует тот же трапециевидный интеграл и ту же
  интерполяцию между узлами, что `createCyclePhase`.
- Legacy phase использует `2π·t·f(t) + phase`.
- После clamp к `duration` производные по amp duration/slope равны нулю.
- Без hardStop амплитудный хвост равен `startLevel * endLevel`.
- Частотный хвост равен `freqBase + 0.001 * (freqStart - freqBase)`.
- До onset вклад и производные равны нулю.
- До конца attack производные по endLevel/duration/slope равны нулю.
- На kink-границах parity проверяется односторонне, а не через неверную
  центральную разность.

Central differences в гладких точках обеих фазовых моделей обязательны
до начала nonlinear solver.

## Clip-aware inner solve

Для текущего raw sum определяется маска насыщения. На ненасыщенных
отсчётах совместный МНК подбирает все квадратуры. На насыщенных отсчётах
clip делает выход независимым от квадратур внутри текущей маски.

После каждого trial маска пересчитывается, а истинный clipped PCM RSS
считается заново. Raw-only внутренний solver не принимает результат.
Нормированный Gram, rank/condition diagnostics, радиальные границы и
backtracking обязательны. Truncated ridge остаётся диагностикой и не
называется upper bound.

Сбой inner solve, NaN, нарушение границ или исчерпание численного
предела отклоняет outer candidate. Quantized plateau и stationary fit с
ненулевым RSS не считаются сбоем и допускают outer LM. Backtrack-limit
означает, что направление ещё имело raw gain, но разрешённые пробы не дали
ни PCM decrease, ни plateau, ни stationary RSS. Такой fit нельзя считать
успешной variable projection.

## LM outer step

Для остатка `r` сначала строится projected Kaufman Jacobian
`J_K = (I − BB+)J` на текущей clip-маске. `B` — текущий внутренний basis;
normalized Gram и retained eigenvectors задают `B+` без матрицы N×N. На
активной радиальной границе квадратурная пара даёт только tangent-направление.
Затем направление решается из `(J_KᵀJ_K + λD)δ = -g`. Нормировка и MGS
отсекают вырожденные оси уже после проекции и не заменяют её. Если tangent
выпадает из normalized Gram, diagnostics оставляет `droppedQuadratures`
пустым: у одиночного tangent-столбца нет пары sine/cosine, и код не
выводит её номер из `floor(column/2)`. Нулевой rank
останавливает поиск; dense/non-descent отказ повышает lambda и продолжает
работу до maxOuter или численного потолка.

Каждый trial:

1. ограничивает логарифмические координаты физическими нормами и записывает
   точные нативные min/max на границе: `exp(log(20))` может дать
   `19.999999999999996`, но такой принятый patch не должен отклоняться на
   следующем outer-шаге;
2. заново решает все квадратуры;
3. пересчитывает clip-маску;
4. принимает только уменьшение фактического clipped RSS после
   backtracking;
5. отдельно проходит canonical global/J guard.

Используется Kaufman-вариант без отдельной производной квадратур по формам:
их влияние удаляет проекция на orthogonal complement. Exact backtracking
остаётся обязательным защитником от ошибки квадратичной модели. Аудит inner,
RSS и saturation относится к одной атомарной backtrack-пробе.

## Реализованный core API

`runFullPatchVariableProjection` принимает `ArgCreateSynth`, target PCM,
модель фазы и пределы `maxOuter`, `maxInner`, `maxBacktracks`. По умолчанию
они равны 24, 12 и 16. Остановка по wall clock отсутствует. Отдельный
`solveFullPatchClipAwareBasis` вызывает тот же inner solve для
низкоуровневых known-answer; основной patch-native путь не использует
vector converter или `groupFromAtom`. До первого render проверяются лимит
50 слотов, бюджеты, target, active outer/fixed/phase fields. Основная функция
разделена на validate, initial state, outer navigation, outer attempt и
finalization; inner backtracking и MGS также выделены.

Отдельный `projectFullPatchKaufmanColumns` проверяет `(I − BB+)J` на маленьких
базисах без запуска solver. Результат разделяет `proposed` и saved `patch/samples`. В историю входят
rank, число saturated samples, смены clip-маски, backtracking и inner
failures. `cost.sampleWork` считает проходы длины N по категориям synth,
basis, Jacobian, Gram/dot и metric. В Gram входят нормировка Jacobian
columns, вычитание проекций в обоих MGS passes и нормировка independent
basis. На буфере из восьми отсчётов known-count фиксирует Gram 63N и
полный sampleWork 128N, включая Kaufman-проекцию. Также сохраняются числа
вызовов. Используются массивы N×P и dense P×P,
но не N×N. Финальный candidate заново проходит canonical render,
побайтовую проверку patch/WAV и общий global/J guard.

Синтетические тесты покрывают обе фазовые модели, три испорченные формы,
включая delayed localized с hardStop, clip trap 1.1 против 1.5, отличие
projected Kaufman от fixed-coefficient Jacobian, radial boundary, rank,
stationary initial с ненулевым RSS, атомарный trial-аудит, input guards,
восстановление после rejected шага, J-floor fallback, no-op, canonical
roundtrip и известную стоимость. Они подтверждают только механику core.
Реального результата пока нет.

## Offline runner и допустимый контроль

Runner читает GrumU из режима `k2-vp-clip-seed-refit`, а BOg из canonical
`delayed-patches-bog400`. Target берёт только из исходного match через
`run.json` и `manifest.json`; каталог post-pass не подменяет источник
таргета. До solver runner проверяет source patch против source WAV. Модель
фазы и `attackBoost` приходят из manifest исходного датасета. Каждый
`withAttackBoost` восстанавливает прежнее значение в `finally`, включая
ошибку solver.

Примеры команд для будущего явного запуска:

```bash
npx tsx src/dataset/full-patch-vp-run.ts \
  --dataset grumu \
  --grumu-base /opt/synth/datasets/block-pursuit-ab-blocks2-grumu \
  --out datasets/full-patch-grumu \
  --seeds 1,2,3,4 --max-outer 24 --max-inner 12 --max-backtracks 16

npx tsx src/dataset/full-patch-vp-run.ts \
  --dataset bog \
  --bog-base /opt/synth/datasets/delayed-patches-bog400 \
  --out datasets/full-patch-bog \
  --seeds 1,2,3,4 --max-outer 24 --max-inner 12 --max-backtracks 16
```

`--dataset all` требует оба base и обрабатывает наборы последовательно.
`--mode no-op` только проверяет source и сохраняет baseline без VP/CD.
Запрошенный сид без записи или с незавершённым исходным match получает
skip. Битый JSON, потерянный canonical WAV и нарушенный immutable guard
становятся ошибками; CLI завершается с кодом 1, если есть такие ошибки.

Для каждого сида runner сохраняет no-op, VP и control в разных каталогах.
VP получает patch/WAV, `audit.json`, `history.json` и атомарный checkpoint.
Report различает proposed и saved global/J, измеряет фактическое уменьшение
residual RMS, показывает inner/outer, rank, clip, backtracking, sampleWork и
wall time. Runner заново вызывает `measureMetrics` для proposed и saved PCM,
а также для обоих control outcomes; эти измерения идут в guard, gate и report.
Исходные solver metrics лежат отдельно в `audit.solverMetrics` и не заменяют
измерения. Character/bands вычисляются против target и сохраняются вместе с
warnings. Runner никогда не выставляет Q4 PASS.

GrumU control использует обычный десятипараметровый vector. BOg снимает
onset только во временной копии и передаёт его через `fixedDelaySeconds`;
при обратном mapping runner восстанавливает исходные optional-поля. Патч с
`attack` или `hardStop` получает явный `skip-control`: localized-поля не
удаляются ради CD. В этом случае control сохраняет исходные patch/WAV.
CD candidate тоже проходит canonical global/J guard; при отказе saved
остаётся исходным.

## Артефакты и guards

Runner сохраняет исходный no-op и итоговый patch/WAV, историю outer steps,
rank, clip-маски, backtracking, стоимость и character/bands. Proposed
candidate до guard и фактически сохранённый результат разделены.

Финальный WAV заново создаётся из patch через canonical render и
проверяется побайтово. Сохранять можно только рост честного global и
`J >= initialJ - 0.05`. При отказе возвращаются исходные patch/WAV.

Q4 PASS не выставляется без согласованных допусков и слуха. Все
предупреждения по f0, спаду и полосам сохраняются.

## A/B

Сначала проверяются четыре GrumU-сидa от лучшего A+B2 и четыре BOg-сидa
от `delayed-patches-bog400`. Дополнительный CD из того же canonical
patch служит контролем только там, где он поддерживает все поля.
Для localized GrumU контролем служит no-op или допустимый patch-native
solver; удалять localized-поля ради CD нельзя.

Одна CD-итерация не равна одному LM-шагу. Фактический VP
`cost.sampleWork.total` задаёт W для control. В CD необязательный
`config.maxSampleWork` считает проходы длины `N` в synth, evaluation и
cache. Перед итерацией CD резервирует консервативный верхний предел всех
candidate/cache/metric проходов и возможного plateau post-pass. Random
restart дополнительно резервирует rebuild из `initialVector`: при обычном CD
он включает все слоты, даже если current/best уже прошли prune. Перед
последним циклом restore best резервируется безусловно, потому что смена
preview-метрики на полную может изменить порядок scores. Поэтому CD
завершает только целые итерации и не превышает W.

Если финальные стадии не помещаются, CD возвращает лучший геном завершённых
итераций и не выполняет их частично. Финальный progress разделяет два факта:
`workBudgetStop` означает отказ перед итерацией или финальными стадиями, а
`finalStagesSkipped` равен фактическому `!finalStagesFit`. Поэтому остановка
перед следующей итерацией может сочетаться с выполненными prune/scale.
При совсем маленьком W startup не запускается, а история остаётся пустой.
Без `maxSampleWork` алгоритм, возврат `{vector, history}` и golden-хэши не
меняются.

VP finalization и control резервируют одинаковые `6N`: proposed render,
второй render внутри canonical assert, PCM compare, global, J и RSS. Report
control содержит `internalWorkBudget`, `canonicalGuardWork`, фактический
`sampleWork.total` и `unusedWork`, поэтому резерв и недобор видны отдельно.
Known-answer фиксирует 6N в VP и control. Отчёт показывает W, фактически
использованный VP/control work, целые CD-итерации и wall time. Общие для
обеих веток чтение входов, запись файлов, character/bands и повторная
проверка сохранённого WAV в W не входят.

Gate продолжения заранее требует:

- минимум 3/4 улучшенных сидов на таргет;
- mean saved global не менее +4.6 п.п.;
- среднее уменьшение residual RMS не менее 25%;
- canonical, global/J и immutability guards пройдены;
- character/bands сохранены без скрытых WARN.

Если gate не пройден, бюджет не увеличивается. Следующий вопрос тогда —
новый структурный init, а не повторение того же solver с большим
числом шагов.
