# Гироскоп и CSS

Дополнение к статье [Оживляем UI на мобилках с Sensor API](https://habr.com/ru/articles/1010328/)

Пример создания реалистичных бликов и световых эффектов на CSS, управляемых наклоном устройства. Данные с гироскопа транслируются в CSS-переменные, а визуальные эффекты строятся на чистом CSS через `calc()`, `radial-gradient`, `linear-gradient` и `box-shadow`.

## Демо

[Демку](https://alexstep.github.io/sensor/) лучше смотреть с мобилки, а ещё лучше открыть [миниапп в телеграм](https://t.me/calendar0bot/ui_example)


## Быстрый старт

Промпт для AI агента:
```
Добавь эффекты блеска UI, реагирующие на наклон устройства.
Инструкция: https://raw.githubusercontent.com/alexstep/sensor/main/AI.md
```

или ручками:
```html
<script src="sensors.js"></script>
<script>
  const gyro = new GyroShine()
  gyro.start()
  gyro.on('change', e => {
    document.documentElement.style.setProperty('--gyro-gamma-percent', e.detail.gammaPercent)
    document.documentElement.style.setProperty('--gyro-beta-percent', e.detail.betaPercent)
  })
</script>
```

## API сенсоров

`GyroShine` автоматически выбирает лучший доступный источник (в порядке приоритета):

| Приоритет | Источник | Где работает |
|-----------|----------|--------------|
| 1 | Telegram Mini Apps API | Telegram iOS/Android |
| 2 | GravitySensor / Accelerometer | Chrome, Android |
| 3 | deviceorientation | Safari, Firefox и др. |

На iOS Safari автоматически запрашивается разрешение пользователя.

## API

### Конструктор

```js
const gyro = new GyroShine({
  refreshRate: 42,        // частота опроса датчиков (мс)
  animate: false,         // JS-интерполяция значений
  useSpring: true,        // пружинная физика (false = линейная интерполяция)
  stiffness: 0.12,        // жёсткость пружины (0.01–0.3)
  damping: 0.82,          // затухание пружины (0.5–0.95)
  lerpSpeed: 0.09,        // скорость lerp (если useSpring = false)
  minBatteryLevel: 0.4,   // мин. заряд батареи (0 = не проверять)
  debug: false,           // вывод логов в консоль
})
```

Все параметры доступны через `gyro.config`:

```js
gyro.config.refreshRate   // 42
gyro.config.useSpring     // true
gyro.config.debug         // false
```

### Методы

| Метод | Описание |
|-------|----------|
| `gyro.start()` | Запуск отслеживания (async, выбирает источник автоматически) |
| `gyro.stop()` | Остановка всех датчиков и анимации |
| `gyro.on(event, cb)` | Подписка на событие |
| `gyro.off(event, cb)` | Отписка от события |

### События

**`change`** - вызывается при изменении наклона:

```js
gyro.on('change', e => {
  e.detail.gammaPercent // "0.00"–"100.00", горизонтальный наклон (лево-право)
  e.detail.betaPercent  // "0.00"–"100.00", вертикальный наклон (вперёд-назад)
})
```

Нейтральное положение устройства - `50.00` / `50.00`.

**`lowbattery`** - вызывается при низком заряде (датчики автоматически останавливаются):

```js
gyro.on('lowbattery', e => {
  console.log('Заряд:', e.detail.level)
})
```

### Свойства

```js
gyro.animate = true              // включить/выключить JS-интерполяцию (getter/setter)
gyro.config.useSpring = false    // переключить режим интерполяции
gyro.config.stiffness = 0.05     // изменить жёсткость пружины
gyro.config.damping = 0.9        // изменить затухание
gyro.config.debug = true         // включить логи
```

## Создание CSS-эффектов бликов

### Принцип работы

1. JS обновляет две CSS-переменные на `:root`:
   - `--gyro-gamma-percent` - горизонтальный наклон (0–100)
   - `--gyro-beta-percent` - вертикальный наклон (0–100)

2. CSS использует эти переменные через `calc()` для смещения градиентов, теней и позиций.

3. Все эффекты оборачиваются в `@media (prefers-reduced-motion: no-preference)` для accessibility.

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

    /* эффекты используют --g-offset и --b-offset */
  }
}
```

`--g-offset` и `--b-offset` - это смещение от центра (от -50 до +50), удобное для расчётов.

### Рецепты эффектов

#### 1. Динамическая тень (параллакс глубины)

Тень смещается в противоположную от наклона сторону, создавая иллюзию объёма:

```css
.card {
  box-shadow:
    calc(var(--g-offset) * -0.15px) calc(1px + var(--b-offset) * -0.1px) 0px #24246855,
    calc(var(--g-offset) * -0.5px)  calc(15px + var(--b-offset) * -0.5px) 25px rgba(0,0,0,0.5);
}
```

Множитель (`-0.15px`, `-0.5px`) задаёт интенсивность реакции.

#### 2. Световое пятно (radial-gradient на ::before)

Мягкий блик, следующий за наклоном - имитация отражения источника света:

```css
.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(
    ellipse 120% 100% at
      calc(50% + var(--g-offset) * -1%)
      calc(15% + var(--b-offset) * -0.6%),
    rgba(255,255,255,0.15) 0%,
    rgba(255,255,255,0.05) 40%,
    transparent 70%
  );
}
```

Ключевое - позиция центра `at X Y` привязана к переменным наклона.

#### 3. Скользящая линия-блик (edge highlight)

Тонкая белая полоса, скользящая по краю элемента:

```css
.card::after {
  content: "";
  position: absolute;
  right: 0;
  top: calc(95% + var(--gyro-beta-percent) * -1.5%);
  width: 1px;
  height: 60%;
  background: linear-gradient(to top, #0000 10%, #fff1 40%, #fff3 55%, #fff1 70%, #0000 90%);
  opacity: 0.8;
  pointer-events: none;
}
```

#### 4. Бегущий блик по разделителю

Горизонтальная полоса света, которая «скользит» по border между секциями:

```css
.separator::after {
  content: "";
  position: absolute;
  top: -1px;
  left: calc(140% + var(--gyro-gamma-percent) * -2%);
  width: 50%;
  height: 1px;
  background: linear-gradient(90deg, #0000 5%, #fff1 25%, #fff5 45%, #fff5 55%, #fff1 75%, #0000 95%);
  pointer-events: none;
}
```

Большой `left` со смещением через `--gyro-gamma-percent` заставляет полосу «выезжать» в видимую область при наклоне.

#### 5. Блик на кнопке (многослойный gradient)

Комбинация из трёх слоёв: диагональный блик + верхний край + боковой край:

```css
.button::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background:
    /* диагональный блик */
    linear-gradient(
      102deg,
      #fff1 calc(-5% + var(--g-offset) * -4%),
      #fff4 calc(40% + var(--g-offset) * -4%),
      #fff7 calc(56% + var(--g-offset) * -4%),
      #fff1 calc(105% + var(--g-offset) * -4%)
    ),
    /* верхний блик (1px) */
    linear-gradient(to right,
      #0000 calc(6% + var(--g-offset) * -2.85%),
      #fff7 calc(48% + var(--g-offset) * -2.2%),
      #0000 calc(96% + var(--g-offset) * -2.85%)
    ) 0 0 / 100% 1px no-repeat,
    /* правый блик (1px) */
    linear-gradient(to bottom,
      #0000 calc(6% + var(--b-offset) * 2.1%),
      #fff7 calc(50% + var(--b-offset) * 2.55%),
      #0000 calc(96% + var(--b-offset) * 2.1%)
    ) 100% 0 / 1px 100% no-repeat;
}
```

### Советы

- **`will-change`** - указывайте на элементах с частым обновлением (`will-change: background, box-shadow`), но не злоупотребляйте.
- **Множитель смещения** - чем больше коэффициент при `--g-offset`, тем сильнее реагирует эффект. Начинайте с `0.5–1%` и подбирайте визуально.
- **Укороченные цвета** - `#fff3`, `#0000` - это CSS Color Level 4 (4-значный hex с альфа-каналом), поддерживается всеми современными браузерами.
- **`pointer-events: none`** - обязательно на всех псевдоэлементах с эффектами, чтобы не блокировать клики.
- **Статический fallback** - вне медиа-запроса `prefers-reduced-motion` задайте статичные тени и бордеры, чтобы интерфейс выглядел нормально без анимации.

