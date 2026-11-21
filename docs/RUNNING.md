# Как запустить проект у себя

## Требования

- Node.js 20 (в Dockerfile зафиксирован `node:20.20.2-alpine`).
- npm. Зависимости ставятся из `package-lock.json`.

## Клонирование и проверка

```bash
git clone <url-репозитория> synth
cd synth
npm ci
npm test          # 62 теста, включая регрессии фазы
npm run build     # TypeScript в dist/
npm run lint      # 0 ошибок
```

## Работа от конкретной версии

Каждая версия имеет аннотированный тег с описанием на русском. Список:

```bash
git tag -n99 | less
git checkout v1.3.0
npm ci && npm test && npm run build
```

Описание версий также лежит в `CHANGELOG.md`, а ход работ — в `docs/log/LOG.md`.

## Что можно запускать

| Команда | Что делает |
|---|---|
| `npm run dev` | Генерация WAV из пресета |
| `npm run serve:dev` | HTTP-сервер через tsx (порт 3000) |
| `npm run serve` | Сервер из собранного `dist/` |
| `cd web && npm ci && npm run dev` | Веб-интерфейс на 5173 |
| `npx tsx src/audio-inspect.ts a.wav --compare b.wav` | Разбор WAV: уровни, пики, полосы |
| `npx tsx src/dataset/build-dataset.ts --targets targets --out datasets/run-1 --iterations 300 --seeds 1,2,3,4 --oscillators 50 --parallel 2 --phase integral` | Датасет эталонов: 4 сида на таргет, чекпоинты и resume |

Входные WAV не хранятся в git: положите свои эталоны в `targets/`, а несовершенные бочки — в `raw/`.

## Модель фазы

Синтезатор поддерживает две модели:

- `legacy` (по умолчанию) — поведение всех прогонов до v1.3.0. Нужна для воспроизведения старых артефактов.
- `integral` — звучащая частота совпадает с огибающей частоты. Для новых экспериментов и датасетов.

Датасет собирайте с явным `--phase`, чтобы не смешивать модели в одном каталоге.

Джобы API принимают `phaseModel=legacy|integral` в query:

```bash
curl -X POST "http://localhost:3000/api/enhance/job?maxIterations=200&numOscillators=50&enhancementStrength=1&seed=1&phaseModel=integral&fileName=kick.wav" \
  --data-binary @raw/kick.wav -H "Content-Type: audio/wav"
```

Модель сохраняется в `params` джобы; матч, движок, доводка и рендеры используют одну модель.

## Важные оговорки

- **Реверс-синтез и улучшение — разные задачи.** Первая меряется suppression к оригиналу, вторая судится законом качества и слухом. Критерии Q1–Q5 в `AGENTS.md`.
- **Перенос множителей по архетипу выключен** в сервисе с v1.2.2 (не доказан как закон).
- **Доводка (refineIterations) выключена по умолчанию.** Замерено, что она стирает часть низа, который прописывает движок.
- **Не пользуйтесь индексом модуляции низа 1–8 Гц** из старых заметок: он не прошёл контроль и отозван.
- Детерминизм сидов держится внутри одной платформы. Сравнивайте прогоны на одной машине и усредняйте по не менее чем четырём сидам.

## Деплой в Docker

```bash
docker build -t synth .
docker run -p 3000:3000 synth
```
