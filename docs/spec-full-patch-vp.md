# Offline full-patch variable projection с LM

## Статус

Core `src/dataset/full-patch-vp.ts` реализован, но реальный эксперимент ещё
не запускался. Текущие CD, slot-post-pass, frozen-delay и
localized-контролы не достигли 98%. Производственный match, enhance и API
этот документ не подключает. Runner, character/bands и A/B остаются
следующим этапом; synthetic known-answer не является результатом на
реальных таргетах.

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
отсекают вырожденные оси уже после проекции и не заменяют её. Нулевой rank
останавливает поиск; dense/non-descent отказ повышает lambda и продолжает
работу до maxOuter или численного потолка.

Каждый trial:

1. ограничивает логарифмические координаты физическими нормами;
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

## Артефакты и guards

Runner сохраняет исходный и итоговый patch/WAV, историю outer steps,
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

Одна CD-итерация не равна одному LM-шагу. Нужен общий work-бюджет:
каждый проход длины `N` в synth, basis, Jacobian, Gram/dot и metric
увеличивает счётчик на `N`. Обе ветки завершают только целые итерации и
не превышают бюджет. Публикуются фактически использованный бюджет и
wall time.

Gate продолжения заранее требует:

- минимум 3/4 улучшенных сидов на таргет;
- mean saved global не менее +4.6 п.п.;
- среднее уменьшение residual RMS не менее 25%;
- canonical, global/J и immutability guards пройдены;
- character/bands сохранены без скрытых WARN.

Если gate не пройден, бюджет не увеличивается. Следующий вопрос тогда —
новый структурный init, а не повторение того же solver с большим
числом шагов.
