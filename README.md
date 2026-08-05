# Синтезатор

## Использование

### Установка зависимостей

```bash
npm install
```

### Генерация звука

```bash
# Генерация в режиме разработки (без сборки)
npm run dev

# Сборка и запуск
npm run build
npm run start
```

Результат записывается в `.wav` файл (имя файла настраивается в `src/index.ts`).

### Визуализация огибающих

```bash
npm run viz
```

Создаёт SVG-файлы `envelope-amplitude.svg` и `envelope-frequency.svg`.

### Настройка звука

Редактируйте `src/presets.ts` для изменения параметров осцилляторов. Каждый осциллятор имеет:

- `osc.freqBase` — базовая частота (Гц), к которой стремится сигнал
- `osc.freqStart` — начальная частота (Гц) при t = 0
- `osc.duration` — длительность огибающей (с)
- `osc.slope` — кривизна огибающей частоты
- `osc.phase` — начальная фаза (рад), от 0 до 2π
- `ampEnv.startLevel` — начальный уровень амплитуды
- `ampEnv.endLevel` — конечный уровень амплитуды
- `ampEnv.duration` — длительность огибающей (с)
- `ampEnv.slope` — кривизна огибающей амплитуды

Пример добавления нескольких осцилляторов:

```ts
import { MIN } from './envelope';

export const synthPreset: ArgCreateSynth = {
  oscillators: [
    {
      osc: { freqBase: 440, freqStart: 880, duration: 0.5, slope: 0.8, phase: 0 },
      ampEnv: { startLevel: 1, endLevel: MIN, duration: 0.5, slope: 0.8 },
    },
    {
      osc: { freqBase: 660, freqStart: 1320, duration: 0.5, slope: 0.8, phase: 0 },
      ampEnv: { startLevel: 0.5, endLevel: MIN, duration: 0.5, slope: 0.8 },
    },
  ],
};
```

## Технологии

- Node.js
- TypeScript

## Команды

| Команда | Действие |
|---|---|
| `npm run dev` | Запуск через `tsx` без сборки |
| `npm run build` | Компиляция в `dist/` |
| `npm run start` | Запуск собранного `dist/index.js` |
| `npm run viz` | Визуализация огибающих в SVG |
| `npm run prettier` | Форматирование кода |
| `npm run prettier:check` | Проверка форматирования |
| `npm run lint` | Проверка ESLint |
| `npm run lint:fix` | Автоматическое исправление ESLint |

## Звук

Генерирует `.wav` файл (44100 Гц, 16 бит, моно).

Поддерживает до 50 осцилляторов, каждый со своей независимой огибающей частоты и огибающей амплитуды. Итоговый сигнал — сумма всех осцилляторов с клиппингом в [-1, 1].

## Компоненты

### Огибающая

>E = e<sup>(log<sub>e</sub>a<sub>min</sub> * (t / t<sub>end</sub>)<sup>slope</sup>)</sup>

где

- `e` - число Эйлера
- `t` - текущий момент времени (с),
- `t`<sub>`end`</sub> - желаемая продолжительность огибающей (с)
- `a`<sub>`min`</sub> - минимальное значение огибающей, по-умолчанию равно `0.001`
- `slope` - кривизна
- `E` - нормализованное значение огибающей в момент `t` в пределах `(0; 1]`;


### Осциллятор

Расчитывает отклонение от 0 в текущий момент времени:

- t - время в секундах
- f - частота
- a - амплитуда
- φ — начальная фаза (рад)

>y = sin(t * f * 2 * π + φ) * a