# Gyro-Shine: инструкция для ИИ-агента

Эта инструкция предназначена для ИИ-агентов (Cursor, Claude Code, Windsurf, Copilot и др.).
Цель — добавить в проект пользователя CSS-эффекты бликов и света, реагирующие на наклон мобильного устройства (гироскоп). На десктопе эффекты могут реагировать на движение мыши.

Принцип: JS-класс `GyroShine` читает данные с датчиков и пишет две CSS-переменные на `:root`. Все визуальные эффекты строятся на чистом CSS через `calc()`, `radial-gradient`, `linear-gradient` и `box-shadow`.

## TL;DR

1. Скачай `sensors.js` (ссылка ниже), подключи в проект
2. Инициализируй `GyroShine`, пиши `--gyro-gamma-percent` и `--gyro-beta-percent` на `:root`
3. Используй эти переменные в CSS (`calc`, `gradient`, `box-shadow`)

---

## Шаг 1. Скачай sensors.js

Скачай файл `sensors.js` и положи его в проект (в `src/lib/`, `utils/`, или рядом с другими скриптами — зависит от структуры проекта):

```
https://raw.githubusercontent.com/alexstep/sensor/main/sensors.js
```

Файл содержит ES-модуль с классом `GyroShine` (`export default class GyroShine`).

---

## Шаг 2. Инициализация

Создай экземпляр `GyroShine`, подпишись на событие `change` и пиши CSS-переменные на `:root`. Вызови `start()` — класс автоматически выберет лучший доступный источник данных.

### Vanilla JS

```js
import GyroShine from './sensors.js';

const gyro = new GyroShine({ refreshRate: 42 });

gyro.on('change', (e) => {
  document.documentElement.style.setProperty('--gyro-gamma-percent', e.detail.gammaPercent);
  document.documentElement.style.setProperty('--gyro-beta-percent', e.detail.betaPercent);
});

gyro.start();
```

На iOS Safari `start()` должен вызываться из обработчика пользовательского действия (клик), иначе запрос разрешения на доступ к сенсорам не сработает.

### React

```jsx
import { useEffect } from 'react';
import GyroShine from './sensors';

function useGyroShine() {
  useEffect(() => {
    const gyro = new GyroShine({ refreshRate: 42 });

    gyro.on('change', (e) => {
      document.documentElement.style.setProperty('--gyro-gamma-percent', e.detail.gammaPercent);
      document.documentElement.style.setProperty('--gyro-beta-percent', e.detail.betaPercent);
    });

    gyro.start();
    return () => gyro.stop();
  }, []);
}
```

### Vue 3

```js
import { onMounted, onUnmounted } from 'vue';
import GyroShine from './sensors';

export function useGyroShine() {
  let gyro;

  onMounted(() => {
    gyro = new GyroShine({ refreshRate: 42 });

    gyro.on('change', (e) => {
      document.documentElement.style.setProperty('--gyro-gamma-percent', e.detail.gammaPercent);
      document.documentElement.style.setProperty('--gyro-beta-percent', e.detail.betaPercent);
    });

    gyro.start();
  });

  onUnmounted(() => gyro?.stop());
}
```

### Angular

```ts
import { Directive, OnInit, OnDestroy } from '@angular/core';
import GyroShine from './sensors';

@Directive({ selector: '[gyroShine]', standalone: true })
export class GyroShineDirective implements OnInit, OnDestroy {
  private gyro = new GyroShine({ refreshRate: 42 });

  ngOnInit() {
    this.gyro.on('change', (e: CustomEvent) => {
      document.documentElement.style.setProperty('--gyro-gamma-percent', e.detail.gammaPercent);
      document.documentElement.style.setProperty('--gyro-beta-percent', e.detail.betaPercent);
    });
    this.gyro.start();
  }

  ngOnDestroy() { this.gyro.stop(); }
}
```

---

## Шаг 3. CSS-эффекты

Добавь CSS-переменные и рецепты эффектов. Адаптируй селекторы под конкретный проект пользователя (карточки, кнопки, разделители).

### Базовый шаблон

```css
:root {
  --gyro-gamma-percent: 50;
  --gyro-beta-percent: 50;
}

@media (prefers-reduced-motion: no-preference) {
  .card {
    --g-offset: calc(var(--gyro-gamma-percent) - 50);
    --b-offset: calc(var(--gyro-beta-percent) - 50);
  }
}
```

`--g-offset` и `--b-offset` — смещение от центра (от -50 до +50).

### Настраиваемость

Выноси ключевые коэффициенты в CSS-переменные и комментируй их — чтобы пользователь мог потом легко подтюнить эффекты, просто меняя множители, начальные позиции и цвета. Пример:

```css
.card {
  /* --- tuning --- */
  --shadow-shift: -0.5px;   /* интенсивность смещения тени */
  --shadow-base-y: 15px;    /* начальный вертикальный отступ */
  --shadow-blur: 25px;
  --shadow-color: rgba(0,0,0,0.5);

  box-shadow:
    calc(var(--g-offset) * var(--shadow-shift))
    calc(var(--shadow-base-y) + var(--b-offset) * var(--shadow-shift))
    var(--shadow-blur)
    var(--shadow-color);
}
```

Следуй этому подходу во всех эффектах: множители, цвета и opacity — в переменные с комментарием. Не обязательно выносить всё — только то, что пользователь захочет подкрутить.

### Рецепт 1: Динамическая тень

Тень смещается в противоположную от наклона сторону, создавая иллюзию объёма:

```css
.card {
  /* --- tuning: тень --- */
  --shadow-speed: -0.5px;            /* интенсивность смещения */
  --shadow-base-y: 15px;             /* начальный вертикальный отступ */
  --shadow-blur: 25px;
  --shadow-color: rgba(0,0,0,0.5);

  box-shadow:
    calc(var(--g-offset) * -0.15px) calc(1px + var(--b-offset) * -0.1px) 0px #24246855,
    calc(var(--g-offset) * var(--shadow-speed))
    calc(var(--shadow-base-y) + var(--b-offset) * var(--shadow-speed))
    var(--shadow-blur) var(--shadow-color);
}
```

### Рецепт 2: Световое пятно (radial-gradient на ::before)

Мягкий блик, следующий за наклоном — имитация отражения источника света:

```css
.card {
  position: relative;

  /* --- tuning: пятно --- */
  --spot-speed-x: -1%;       /* скорость смещения по горизонтали */
  --spot-speed-y: -0.6%;     /* скорость смещения по вертикали */
  --spot-base-y: 15%;        /* начальная вертикальная позиция центра */
  --spot-color: rgba(255,255,255,0.15);
  --spot-color-mid: rgba(255,255,255,0.05);
}
.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(
    ellipse 120% 100% at
      calc(50% + var(--g-offset) * var(--spot-speed-x))
      calc(var(--spot-base-y) + var(--b-offset) * var(--spot-speed-y)),
    var(--spot-color) 0%,
    var(--spot-color-mid) 40%,
    transparent 70%
  );
}
```

### Рецепт 3: Скользящая линия-блик по краю

Тонкая белая полоса, скользящая по правому краю элемента:

```css
.card::after {
  /* --- tuning: линия на краю --- */
  --edge-speed: -2.5%;       /* скорость скольжения */
  --edge-opacity: 0.8;
  --edge-color: #fff3;       /* пиковая яркость полосы */

  content: "";
  position: absolute;
  right: 0;
  top: 20%;
  width: 1px;
  height: 60%;
  will-change: transform;
  transform: translateY(calc(var(--b-offset) * var(--edge-speed)));
  background: linear-gradient(to top, #0000 10%, #fff1 40%, var(--edge-color) 55%, #fff1 70%, #0000 90%);
  opacity: var(--edge-opacity);
  pointer-events: none;
}
```

### Рецепт 4: Бегущий блик по разделителю

Горизонтальная полоса света, «скользящая» по border между секциями:

```css
.separator::after {
  /* --- tuning: блик на разделителе --- */
  --sep-speed: -6%;          /* скорость смещения */
  --sep-color: #fff4;        /* яркость блика */

  content: "";
  position: absolute;
  top: -1px;
  right: 40%;
  width: 50%;
  height: 1px;
  will-change: transform;
  transform: translateX(calc(var(--g-offset) * var(--sep-speed)));
  background: linear-gradient(90deg, #0000 10%, var(--sep-color) 50%, #0000 90%);
  pointer-events: none;
}
```

### Рецепт 5: Многослойный блик на кнопке

Комбинация из трёх слоёв — диагональный блик + верхний край + боковой край:

```css
.button {
  position: relative;

  /* --- tuning: кнопка --- */
  --btn-shine-speed: -4%;      /* скорость диагонального блика */
  --btn-edge-speed-x: -2.2%;   /* скорость блика по верхнему краю */
  --btn-edge-speed-y: 2.55%;   /* скорость блика по правому краю */
  --btn-shine-peak: #fff7;     /* пиковая яркость диагонали */
  --btn-edge-peak: #fffb;      /* пиковая яркость края */

  border-top: 1px solid rgba(255,255,255,0.3);
  border-left: 1px solid rgba(255,255,255,0.12);
  border-right: 1px solid rgba(255,255,255,0.16);
  border-bottom: 1px solid rgba(0,0,0,0.32);
}
.button::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  will-change: background;
  background:
    /* диагональный блик */
    linear-gradient(
      102deg,
      #fff1 calc(-5% + var(--g-offset) * var(--btn-shine-speed)),
      #fff2 calc(18% + var(--g-offset) * var(--btn-shine-speed)),
      #fff4 calc(40% + var(--g-offset) * var(--btn-shine-speed)),
      var(--btn-shine-peak) calc(56% + var(--g-offset) * var(--btn-shine-speed)),
      #fff4 calc(72% + var(--g-offset) * var(--btn-shine-speed)),
      #fff2 calc(88% + var(--g-offset) * var(--btn-shine-speed)),
      #fff1 calc(105% + var(--g-offset) * var(--btn-shine-speed))
    ),
    /* блик по верхнему краю (1px) */
    linear-gradient(to right,
      #0000 calc(6% + var(--g-offset) * -2.85%),
      #fff1 calc(28% + var(--g-offset) * -2.05%),
      #fff7 calc(48% + var(--g-offset) * var(--btn-edge-speed-x)),
      var(--btn-edge-peak) calc(56% + var(--g-offset) * var(--btn-edge-speed-x)),
      #fff2 calc(74% + var(--g-offset) * -2.05%),
      #0000 calc(96% + var(--g-offset) * -2.85%)
    ) 0 0 / 100% 1px no-repeat,
    /* блик по правому краю (1px) */
    linear-gradient(to bottom,
      #0000 calc(6% + var(--b-offset) * 2.1%),
      #fff1 calc(30% + var(--b-offset) * 2.35%),
      #fff7 calc(50% + var(--b-offset) * var(--btn-edge-speed-y)),
      #fff2 calc(70% + var(--b-offset) * 2.35%),
      #0000 calc(96% + var(--b-offset) * 2.1%)
    ) 100% 0 / 1px 100% no-repeat;
}
```

### Рецепт 6: Блик внутри toggle-чекбокса

Горизонтальный блик, скользящий внутри переключателя. В выключенном состоянии — едва заметный, при включении — яркий:

```css
input[type="checkbox"].toggle {
  position: relative;
  overflow: hidden;

  /* --- tuning: блик в тоггле --- */
  --toggle-speed: -3px;         /* скорость смещения */
  --toggle-shine-color: #fff8;  /* яркость полосы */
  --toggle-opacity-off: 0.27;   /* непрозрачность (выкл) */
  --toggle-opacity-on: 1;       /* непрозрачность (вкл) */
}
input[type="checkbox"].toggle::after {
  content: "";
  position: absolute;
  z-index: 0;
  top: 0;
  left: 10px;
  width: 100px;
  height: 100%;
  will-change: transform;
  transform: translateX(calc(var(--g-offset) * var(--toggle-speed)));
  background: linear-gradient(90deg, #0000 20%, var(--toggle-shine-color) 38%, #0000 62%);
  opacity: var(--toggle-opacity-off);
  pointer-events: none;
}
input[type="checkbox"].toggle:checked::after {
  opacity: var(--toggle-opacity-on);
}
```

Тот же приём работает для любых элементов с `overflow: hidden` — прогресс-бары, слайдеры, input[type="text"], textarea, навигационные табы и т.д. Общий паттерн: `::after` с `linear-gradient`, сдвигаемый через `transform: translateX(calc(var(--g-offset) * var(--speed)))`.

### Рецепт 7: Блик на иконке

Полоса света, скользящая по SVG-иконке (или любому небольшому элементу фиксированного размера):

```css
.icon-wrapper {
  position: relative;
  overflow: hidden;

  /* --- tuning: блик на иконке --- */
  --icon-speed: -3px;           /* скорость смещения */
  --icon-base-pos: 160px;       /* начальная позиция (подогнать под размер) */
  --icon-shine-color: #fff6;    /* яркость полосы */
  --icon-shine-width: 64px;     /* ширина полосы */
}
.icon-wrapper::before {
  content: "";
  position: absolute;
  z-index: 2;
  top: 0;
  width: var(--icon-shine-width);
  height: 100%;
  pointer-events: none;
  left: calc(var(--icon-base-pos) + var(--gyro-gamma-percent) * var(--icon-speed));
  background: linear-gradient(90deg, #0000 20%, var(--icon-shine-color) 38%, #0000 62%);
}
```

Для маленьких иконок (16-24px) уменьши `--icon-shine-width` и `--icon-base-pos`.

---

## Яркость бликов

Подбирай яркость бликов под фактический фон проекта. На тёмном фоне белые блики заметнее — нужна меньшая непрозрачность и мягче градиент. На светлом фоне — можно ярче, белый на белом менее контрастен.

Если в проекте есть и светлая и тёмная темы — сделай разную яркость для каждой. Если тема только одна — просто подбери opacity под неё, не создавай лишних вариантов.

---

## Как применять

Рецепты выше — это **базовые паттерны**, а не исчерпывающий список. Используй их как основу и создавай новые эффекты, подходящие конкретному проекту. Пройдись по UI проекта и подумай, где блики будут уместны:

- **Карточки, модальные окна, попапы** — рецепты 1 (тень) + 2 (световое пятно) + 3 (линия по краю)
- **Кнопки, ссылки-кнопки** — рецепт 5 (многослойный блик)
- **Разделители, hr, границы секций** — рецепт 4 (бегущий блик)
- **Чекбоксы, тогглы, слайдеры, прогресс-бары** — рецепт 6 (скользящий градиент внутри)
- **Input-поля, textarea** — тонкий блик по верхнему или боковому бордеру (аналог рецепта 3)
- **Иконки, аватарки, бейджи** — рецепт 2 (световое пятно) в миниатюре
- **Навбар, тулбар, табы** — рецепт 4 на нижней границе

Не ограничивайся перечисленным — любой элемент с видимой границей, фоном или тенью может получить тонкий отклик на наклон.

---

## Принципы

### Ненавязчивость

Эффекты должны быть **едва заметными**. Это не анимация ради анимации, а микро-взаимодействие, создающее ощущение физичности. Пользователь не должен думать "ого, тут что-то сверкает", он должен подсознательно чувствовать, что интерфейс отзывчивый и "живой". Если эффект бросается в глаза — уменьши коэффициенты, убери яркость, сделай тоньше.

### Graceful degradation

Интерфейс **обязан** нормально выглядеть и работать без этих эффектов вообще. Эффекты — декорация поверх готового UI, а не его часть. Конкретно:
- Вне `@media (prefers-reduced-motion: no-preference)` задай статичные тени, бордеры, фоны — чтобы без датчиков всё выглядело законченно.
- Если JS не загрузился или сенсоры недоступны — CSS-переменные останутся на дефолтных `50` (нейтральная позиция), эффекты замрут в центральном положении — и это нормально.
- Не завязывай функциональность (клики, скролл, навигация) на псевдоэлементы эффектов.

---

## НЕ ДЕЛАЙ

- Не заменяй существующие тени/стили — дополняй их.
- Не применяй эффекты ко всем элементам страницы — выбери 3–7 ключевых.
- Не добавляй CSS `transition` / `animation` на переменные гироскопа — движение уже происходит через обновление переменных из JS.
- Не создавай отдельные обёртки/контейнеры для эффектов — используй `::before` / `::after` на существующих элементах.

---

## Обязательные правила

1. **`@media (prefers-reduced-motion: no-preference)`** — оберни ВСЕ динамические эффекты в этот медиа-запрос. Вне него оставь статичные тени и бордеры как fallback.

2. **`pointer-events: none`** — на ВСЕХ псевдоэлементах с эффектами, иначе они перехватят клики.

3. **`will-change`** — добавляй `will-change: background` или `will-change: box-shadow` на элементы с частым обновлением, но только на них.

4. **`position: relative`** — на родительском элементе, если используешь `::before` / `::after` с `position: absolute`.

5. **Статический fallback** — вне `@media (prefers-reduced-motion)` задай статичные `box-shadow` и `border`, чтобы интерфейс выглядел нормально без анимации.

6. **Адаптируй селекторы** — замени `.card`, `.button`, `.separator` на реальные селекторы из проекта пользователя. Найди в проекте карточки, кнопки, разделители, списки — и примени к ним подходящие рецепты.

7. **Коэффициенты** — множители при `--g-offset` / `--b-offset` (например `* -0.5px`, `* -1%`) задают интенсивность реакции. Чем больше — тем сильнее реагирует. Начинай с указанных значений, подбирай визуально.

---

## API

**Class:** `GyroShine` (ES-модуль, `export default`)

**Methods:**

| Метод | Описание |
|-------|----------|
| `start()` | Запуск (async). Автоматически выбирает источник данных |
| `stop()` | Остановка всех датчиков и анимации |
| `on(event, cb)` | Подписка на событие |
| `off(event, cb)` | Отписка |

**Event `change`:**

```
{ detail: { gammaPercent: string, betaPercent: string } }
```

Значения `"0.00"`–`"100.00"`. Нейтраль — `"50.00"`.

**Constructor options:**

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `refreshRate` | number | 42 | Частота опроса датчиков (мс) |
| `animate` | boolean | false | JS-интерполяция (spring/lerp) |
| `useSpring` | boolean | false | Пружинная физика (false = lerp) |
| `stiffness` | number | 0.12 | Жёсткость пружины (0.01–0.3) |
| `damping` | number | 0.82 | Затухание пружины (0.5–0.95) |
| `lerpSpeed` | number | 0.09 | Скорость lerp (если useSpring=false) |
| `minBattery` | number | 0.4 | Мин. заряд батареи (0 = не проверять) |
| `useMouse` | boolean | true | Fallback на мышь (десктоп) |
| `debug` | boolean | false | Логи в консоль |

**Приоритет источников данных (автовыбор):**

1. Telegram Mini Apps API
2. GravitySensor / Accelerometer
3. deviceorientation
4. mousemove

---

## Чеклист интеграции

После внедрения убедись:

- [ ] Интерфейс выглядит нормально без JS (CSS-переменные на дефолте `50`)
- [ ] При `prefers-reduced-motion: reduce` динамические эффекты отключены
- [ ] `pointer-events: none` на всех псевдоэлементах эффектов
- [ ] На десктопе работает fallback на мышь
- [ ] Существующие стили проекта не сломаны
