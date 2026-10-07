# AGENTS.md

Инструкция для облачных и локальных агентов в репозитории `sensor` (GyroShine).

## Что это

Небольшая фронтенд-библиотека без сборки и без runtime-зависимостей. Класс `GyroShine` читает наклон устройства и отдаёт его событием `change`. Демо и интеграции пишут две CSS-переменные на `:root`:

- `--gyro-gamma-percent` — горизонталь, строка `"0.00"`–`"100.00"`, нейтраль `"50.00"`
- `--gyro-beta-percent` — вертикаль, тот же диапазон

Визуальные блики живут в CSS (`calc`, градиенты, `box-shadow`), внутри `@media (prefers-reduced-motion: no-preference)`.

Приоритет источников: Telegram Mini Apps → `RelativeOrientationSensor` → `deviceorientation` → указатель (мышь и перо, не touch).

## Структура

| Путь | Зачем |
| --- | --- |
| `sensors.js` | Библиотека. Единственный файл, который подключают проекты. ES-модуль, `export default class GyroShine`. |
| `index.html`, `styles.css`, `effects.css` | Демо для GitHub Pages. |
| `other/` | Черновики из статьи. Не часть публичного API. |
| `AI.md` | Промпт, как встроить блики в чужой UI. |
| `test/` | Юнит-тесты расчёта углов и CSS-процентов, плюс жизненный цикл слушателей. |
| `e2e/` | Playwright: синтетический `deviceorientation` и fallback указателя. |
| `scripts/demo-server.js` | Статика без зависимостей, порт `4173`. |

Именованные экспорты из `sensors.js` (`deviceOrientationToNorm`, `normsToCssVars` и соседние функции) нужны тестам. Стабильный API для пользователей — default-класс, его опции, методы и события.

## Как запустить демо

```bash
npm ci
npm run demo
```

Открыть http://127.0.0.1:4173 . На десктопе блики следуют за указателем. На iOS 13+ чекбокс «Отслеживание сенсоров» выключен, пока пользователь сам его не включит: `DeviceOrientationEvent.requestPermission()` работает только из user gesture и только по HTTPS (localhost тоже secure context).

## Как тестировать

```bash
npm test          # node:test, без браузера
npm run test:e2e  # Playwright, Chromium
npm run lint
```

Юнит-тесты не поднимают страницу. E2E ждёт `scripts/demo-server.js` (Playwright сам его стартует). Перед первым e2e локально: `npx playwright install --with-deps chromium` (в Cloud Agent это делает `.cursor/install.sh`).

## Правила

- Не добавлять runtime-зависимости. React, бандлеры и полифиллы библиотеке не нужны. Dev-зависимости допустимы только для lint и e2e.
- Держать `sensors.js` одним файлом и маленьким. Проекты скачивают его как есть, отдельный бандл не собирается. Ориентир размера — тест в `test/tilt.test.js`.
- Не ломать публичный API: `new GyroShine(options)`, `start()`, `stop()`, `on()`, `off()`, `animate`, событие `change` с `detail.gammaPercent` / `detail.betaPercent` (строки с двумя знаками), событие `lowbattery`. Новые опции и события добавлять можно, старые имена и формат `change` — нет.
- `respectReducedMotion` по умолчанию `true`. Не отключать это молча.
- `requestPermission()` вызывать синхронно внутри `start()`, до любого `await`. Иначе iOS теряет user gesture.
- Вне secure context не подписываться на датчики движения — только указатель.
- `stop()` обязан снимать `deviceorientation`, `pointermove`, слушатель `RelativeOrientationSensor`, интервал батареи и подписку Telegram.
- Не публиковать пакет в npm и не менять `version` в `package.json`. Поле стоит `"0.0.0"` только потому, что npm его требует; `"private": true` обязателен.
- Не переписывать `AI.md` и рецепты в README без запроса: это инструкция для встраивания эффектов в другие проекты.

## CI и демо

- `.github/workflows/ci.yml` — install, lint, unit, e2e на pull request и push.
- Тот же workflow выкладывает статику (`index.html`, `sensors.js`, CSS, `other/`) на GitHub Pages при push в `main`. В настройках репозитория источник Pages должен быть **GitHub Actions**.
