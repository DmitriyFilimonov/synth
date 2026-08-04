# AGENTS.md — инструкции для OpenCode

## Общее правило
Перед внесением изменений в любой файл проверяй его актуальное содержимое. Не полагайся на память: в файл могли внести правку другие агенты или разработчики.

## Команды разработки

| Команда | Действие |
|---|---|
| `npm run dev` | Запуск через `tsx` без сборки |
| `npm run build` | Компиляция в `dist/` |
| `npm run start` | Запуск собранного `dist/index.js` |
| `npm run prettier` | Форматирование источников через Prettier |
| `npm run prettier:check` | Проверка форматирования (без изменений) |

## Порядок работы
1. `npm run format` — отформатировать код
2. `npm run build` — убедиться, что типы проходят проверку
3. `npm run dev` (или `npm run start`) — запустить и проверить результат

## Архитектура
Проект — генератор-синтезатор. Создаёт файл `output.wav` (44 100 Гц, 16 бит, моно).

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа, orchestration генерации |
| `src/envelope.ts` | Экспоненциальная функция огибающей |
| `src/oscillator.ts` | Расчёт сигнала осциллятора (поддерживается 1–200 осцилляторов) |

## Соглашения

### TypeScript (`tsconfig.json`)
- `strict: true`
- `verbatimModuleSyntax: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`

### Prettier (`.prettierrc`)
- `semi: true`
- `singleQuote: true`
- `trailingComma: "all"`
- `printWidth: 70`
- `tabWidth: 2`
