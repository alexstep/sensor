/**
 * GyroShine — класс для получения данных ориентации устройства
 * и трансляции их через CustomEvent.
 *
 * Поддерживает четыре источника данных (в порядке приоритета):
 * 1. Telegram Mini Apps API — внутри приложения Telegram на iOS/Android
 * 2. RelativeOrientationSensor — Sensor API (Chrome, Android)
 * 3. deviceorientation — fallback для Safari и остальных браузеров
 * 4. mousemove — fallback для десктопов (включён по умолчанию)
 *
 * Все источники (кроме мыши) используют blend-подход для горизонтали:
 * при наклонённом телефоне — отслеживаем наклон (gravity/gamma),
 * при вертикальном — отслеживаем поворот вокруг вертикальной оси (yaw/alpha).
 * Это решает проблему "мёртвой зоны" gamma при beta ≈ 90°.
 *
 * Опционально поддерживает JS-анимацию (spring/lerp) для плавной интерполяции
 * значений без использования CSS transitions.
 *
 * Использование:
 *   const gyro = new GyroShine({
 *     refreshRate: 42,
 *     animate: true,
 *     useSpring: true,
 *     stiffness: 0.12,
 *     damping: 0.82
 *   });
 *   gyro.on('change', ({ gammaPercent, betaPercent }) => { ... });
 *   gyro.start();
 */
const DEFAULT_REFRESH_RATE   = 42;
const SENSOR_FREQUENCY       = 60
const BATTERY_CHECK_INTERVAL = 10000
const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180
const EPSILON = 0.0005

// Диапазоны нормализации углов (подобраны эмпирически).
// gamma до ±90°, но на краях шум — режем до ±70°.
// beta 45° = "телефон в руке" = нейтраль (50%).
const GAMMA_RANGE = 70;
const BETA_OFFSET = 45
const BETA_RANGE  = 45

// Blend-порог: при какой "вертикальности" переключаемся
// с gravity-подхода (наклон) на azimuth-подход (yaw).
// uprightness = sin(угол от горизонтали):
//   sin(58°) ≈ 0.85 — начало плавного перехода
//   sin(79°) ≈ 0.98 — полностью на azimuth
// При типичном удержании (~45°) uprightness ≈ 0.71 — blend = 0, чистый gravity.
const UPRIGHT_START = 0.85
const UPRIGHT_RANGE = 0.13

export default class GyroShine extends EventTarget {
  // === STATE ===
  #targetGamma   = 0;
  #targetBeta    = 0
  #currentGamma  = 0
  #currentBeta   = 0
  #velocityGamma = 0
  #velocityBeta  = 0
  #prevGP = -1
  #prevBP = -1

  // Базовые значения для вычисления дельты yaw-поворота.
  // Непрерывно обновляются пока телефон наклонён (blend ≈ 0),
  // "замораживаются" когда телефон становится вертикальным —
  // так дельта всегда отсчитывается от момента перехода в вертикальное положение.
  #alphaBase   = null // для deviceorientation и Telegram (градусы)
  #azimuthBase = null // для RelativeOrientationSensor (градусы)

  // Переиспользуемые объекты (избегаем аллокаций на горячем пути)
  #detail = { gammaPercent: '50.00', betaPercent: '50.00' }
  #tiltResult = { gammaNorm: 0, betaNorm: 0 }

  // === RESOURCES ===
  #twaHandler = null
  #sensor = null
  #animationFrame = null
  #twaOrientation = null
  #batteryCheckInterval = null
  #deviceOrientationHandler = null
  #mouseMoveHandler = null

  /**
   * @param {Object} options
   * @param {number} [options.refreshRate=42] — частота обновления в мс
   * @param {boolean} [options.animate=false] — включить JS-анимацию
   * @param {boolean} [options.useSpring=true] — пружинная физика (false = lerp)
   * @param {number} [options.stiffness=0.12] — жёсткость пружины (0.01–0.3)
   * @param {number} [options.damping=0.82] — затухание пружины (0.5–0.95)
   * @param {number} [options.lerpSpeed=0.09] — скорость линейной интерполяции (0.01–0.2)
   * @param {number} [options.minBattery=0.4] — минимальный уровень батареи (0 = выкл)
   * @param {boolean} [options.debug=false] — вывод логов в консоль
   * @param {boolean} [options.useMouse=true] — использовать мышь как fallback на десктопе
   */
  constructor(options = {}) {
    super()

    this.config = {
      refreshRate : options.refreshRate ?? DEFAULT_REFRESH_RATE,
      animate     : options.animate ?? false,
      useSpring   : options.useSpring ?? true,
      stiffness   : options.stiffness ?? 0.12,
      damping     : options.damping ?? 0.82,
      lerpSpeed   : options.lerpSpeed ?? 0.09,
      debug       : options.debug ?? false,
      minBattery  : options.minBattery ?? 0.4,
      useMouse    : options.useMouse ?? true,
    };
  }

  // =============================================================
  // ПУБЛИЧНЫЕ СВОЙСТВА
  // =============================================================

  get animate() {
    return this.config.animate
  }

  set animate(value) {
    const prev = this.config.animate
    this.config.animate = value
    if (prev === value) return

    if (value) {
      this.#startAnimationLoop()
    } else {
      this.#stopAnimationLoop()
    }
  }

  // =============================================================
  // УТИЛИТЫ
  // =============================================================

  #clamp(value, min = -1, max = 1) {
    return Math.min(max, Math.max(min, value))
  }

  #throttle(fn, delay) {
    let last = 0
    return (...args) => {
      const now = performance.now()
      if (now - last < delay) return
      last = now
      fn(...args)
    }
  }

  /**
   * Вычисляет коэффициент blend'а и azimuth-gamma из дельты yaw-угла.
   *
   * Идея: вектор гравитации не содержит информации о повороте вокруг
   * вертикальной оси (yaw). Когда телефон близок к вертикальному положению,
   * наклон лево/право (gamma) перестаёт реагировать на поворот — это физическое
   * ограничение. Чтобы блики продолжали двигаться, при высокой "вертикальности"
   * подмешиваем yaw-дельту (alpha или azimuth нормали экрана) в горизонталь.
   *
   * @param {number} uprightness — степень вертикальности (0 = лежит, 1 = стоит)
   * @param {number} angleDeg — текущий yaw-угол в градусах
   * @param {number|null} baseDeg — базовый yaw-угол (от которого считаем дельту)
   * @returns {{ blend: number, azimuthGamma: number, newBase: number }}
   */
  #computeYawBlend(uprightness, angleDeg, baseDeg) {
    // blend: 0 (телефон наклонён, используем gravity)
    //        1 (телефон вертикален, используем azimuth)
    const blend = this.#clamp((uprightness - UPRIGHT_START) / UPRIGHT_RANGE, 0, 1)

    let newBase = baseDeg ?? angleDeg
    let azimuthGamma = 0

    if (blend < 0.01) {
      // Пока blend ≈ 0, непрерывно обновляем базу.
      // Когда телефон перейдёт в вертикальное положение,
      // база "заморозится" на последнем значении — и дельта
      // начнёт расти от нуля, обеспечивая плавный старт.
      newBase = angleDeg
    } else {
      let delta = angleDeg - newBase
      // Обработка перехода через ±180° (wraparound)
      if (delta > 180) delta -= 360
      if (delta < -180) delta += 360
      azimuthGamma = this.#clamp(delta / GAMMA_RANGE)
    }

    return { blend, azimuthGamma, newBase }
  }

  #log(...args) {
    if (this.config.debug) console.log('[GyroShine]', ...args)
  }

  #warn(...args) {
    if (this.config.debug) console.warn('[GyroShine]', ...args)
  }

  #error(...args) {
    if (this.config.debug) console.error('[GyroShine]', ...args)
  }

  // =============================================================
  // АНИМАЦИЯ (SPRING / LERP)
  // =============================================================

  #animationLoop = () => {
    const { useSpring, stiffness, damping, lerpSpeed } = this.config

    if (useSpring) {
      this.#velocityGamma += (this.#targetGamma - this.#currentGamma) * stiffness;
      this.#velocityBeta  += (this.#targetBeta - this.#currentBeta) * stiffness
      this.#velocityGamma *= damping
      this.#velocityBeta  *= damping
      this.#currentGamma  += this.#velocityGamma
      this.#currentBeta   += this.#velocityBeta
    } else {
      this.#currentGamma += (this.#targetGamma - this.#currentGamma) * lerpSpeed;
      this.#currentBeta  += (this.#targetBeta - this.#currentBeta) * lerpSpeed
    }

    this.#emitValues((this.#currentGamma + 1) * 50, (this.#currentBeta + 1) * 50)

    const dg = this.#targetGamma - this.#currentGamma
    const db = this.#targetBeta  - this.#currentBeta

    if (dg * dg + db * db < EPSILON * EPSILON && (!useSpring || this.#velocityGamma * this.#velocityGamma + this.#velocityBeta * this.#velocityBeta < EPSILON * EPSILON)) {
      this.#currentGamma   = this.#targetGamma;
      this.#currentBeta    = this.#targetBeta
      this.#velocityGamma  = 0
      this.#velocityBeta   = 0
      this.#animationFrame = null
      return
    }

    this.#animationFrame = requestAnimationFrame(this.#animationLoop)
  }

  #startAnimationLoop() {
    if (this.animate && !this.#animationFrame) {
      this.#animationFrame = requestAnimationFrame(this.#animationLoop)
    }
  }

  #stopAnimationLoop() {
    if (this.#animationFrame) {
      cancelAnimationFrame(this.#animationFrame)
      this.#animationFrame = null
    }
  }

  // =============================================================
  // ЭМИТ СОБЫТИЙ
  // =============================================================

  #setTarget(gammaNorm, betaNorm) {
    this.#targetGamma = gammaNorm;
    this.#targetBeta  = betaNorm

    if (!this.animate) {
      this.#emitValues((gammaNorm + 1) * 50, (betaNorm + 1) * 50)
      return
    }

    this.#startAnimationLoop()
  }

  #emitValues(gammaPercent, betaPercent) {
    const gp = Math.round(gammaPercent * 100)
    const bp = Math.round(betaPercent * 100)

    if (gp === this.#prevGP && bp === this.#prevBP) return

    this.#prevGP = gp
    this.#prevBP = bp

    this.#detail.gammaPercent = (gp / 100).toFixed(2)
    this.#detail.betaPercent  = (bp / 100).toFixed(2)

    this.dispatchEvent(new CustomEvent('change', { detail: this.#detail }))
  }

  // =============================================================
  // ОБРАБОТЧИКИ ДАТЧИКОВ
  // =============================================================

  /**
   * Обработчик браузерного события deviceorientation.
   * Получает Euler-углы alpha/beta/gamma (градусы) и применяет
   * blend: при наклонённом телефоне — gamma, при вертикальном — delta alpha.
   */
  #handleDeviceOrientation = e => {
    if (e.gamma == null || e.beta == null) return
    if (e.beta > 90) return

    // --- Beta (вертикаль) ---
    // beta 0° = лежит, 45° = в руке (нейтраль), 90° = стоит вертикально.
    // Нормализуем так, чтобы BETA_OFFSET (45°) было серединой (0).
    const betaNorm = this.#clamp((e.beta - BETA_OFFSET) / BETA_RANGE)

    // --- Gamma (горизонталь) с blend ---

    // 1. Gravity-подход: gamma реагирует на физический наклон лево/право.
    //    Хорошо работает при наклонённом телефоне, но "замирает" при beta ≈ 90°
    //    потому что наклон и yaw становятся неразличимы (gimbal lock).
    const gravityGamma = this.#clamp(e.gamma / GAMMA_RANGE)

    // 2. Yaw-подход: дельта alpha реагирует на поворот вокруг вертикальной оси.
    //    Не зависит от beta, но нужна начальная точка отсчёта.
    const uprightness = Math.sin(e.beta * DEG2RAD)
    const { blend, azimuthGamma, newBase } = this.#computeYawBlend(uprightness, e.alpha ?? 0, this.#alphaBase)
    this.#alphaBase = newBase

    // 3. Итоговый gamma: интерполяция между двумя подходами.
    //    blend = 0 → чистый gravity, blend = 1 → чистый azimuth.
    const gammaNorm = gravityGamma * (1 - blend) + azimuthGamma * blend

    this.#setTarget(gammaNorm, betaNorm)
  }

  /**
   * Обработчик мыши (десктоп-фоллбэк).
   * Позиция курсора → gammaNorm/betaNorm (-1..1) с ослаблением 0.2.
   */
  #handleMouseMove = e => {
    const gammaNorm = (e.clientX / window.innerWidth)  * 2 - 1;
    const betaNorm  = (e.clientY / window.innerHeight) * 2 - 1
    this.#setTarget(-0.2 * gammaNorm, -0.2 * betaNorm)
  }

  // =============================================================
  // ИНИЦИАЛИЗАЦИЯ ИСТОЧНИКОВ ДАННЫХ
  // =============================================================

  /**
   * Telegram Mini Apps API.
   * DeviceOrientation отдаёт alpha/beta/gamma в радианах.
   * Используем событие deviceOrientationChanged (не polling).
   */
  #initTelegramAPI() {
    const TWA = window.Telegram?.WebApp
    const platform = TWA?.platform
    if (!TWA?.DeviceOrientation || !['ios', 'android'].includes(platform)) {
      return false
    }

    this.#log(`Using Telegram API (${platform})`)

    this.#twaOrientation = TWA.DeviceOrientation
    this.#twaOrientation.start({
      refresh_rate: this.config.refreshRate,
      need_absolute: false,
    })

    this.#twaHandler = () => {
      const { alpha, gamma, beta } = this.#twaOrientation

      // Конвертируем радианы → градусы для единообразия с остальными источниками
      const alphaDeg = alpha * RAD2DEG;
      const gammaDeg = gamma * RAD2DEG
      const betaDeg  = beta  * RAD2DEG

      if (betaDeg > 90) return

      // Beta — аналогично браузерному обработчику
      const betaNorm = this.#clamp((betaDeg - BETA_OFFSET) / BETA_RANGE)

      // Gamma с blend (gravity + yaw)
      const gravityGamma = this.#clamp(gammaDeg / GAMMA_RANGE)

      const uprightness = Math.sin(betaDeg * DEG2RAD)
      const { blend, azimuthGamma, newBase } = this.#computeYawBlend(uprightness, alphaDeg, this.#alphaBase)
      this.#alphaBase = newBase

      const gammaNorm = gravityGamma * (1 - blend) + azimuthGamma * blend

      this.#setTarget(gammaNorm, betaNorm)
    }
    TWA.onEvent('deviceOrientationChanged', this.#twaHandler)

    return true
  }

  /**
   * RelativeOrientationSensor (Chrome/Android).
   * Sensor fusion гироскоп + акселерометр — самый стабильный и отзывчивый источник.
   * Отдаёт кватернион ориентации, из которого извлекаем и gravity, и yaw.
   *
   * referenceFrame: "screen" — координаты уже повёрнуты под текущую ориентацию
   * экрана (portrait/landscape), не нужно компенсировать вручную.
   */
  async #initOrientationSensor() {
    if (!window.RelativeOrientationSensor) return false

    try {
      this.#sensor = new RelativeOrientationSensor({
        frequency: SENSOR_FREQUENCY,
        referenceFrame: 'screen',
      })

      this.#sensor.addEventListener('reading', () => {
        const tilt = this.#quaternionToTilt(this.#sensor)
        this.#setTarget(tilt.gammaNorm, tilt.betaNorm)
      })

      const ok = await new Promise(resolve => {
        this.#sensor.addEventListener('reading', () => resolve(true), { once: true })
        this.#sensor.addEventListener('error', e => {
          this.#error('OrientationSensor error:', e.error.message)
          resolve(false)
        }, { once: true })
        this.#sensor.start()
      })

      if (!ok) {
        this.#sensor = null
        return false
      }

      this.#log('Using RelativeOrientationSensor')
      return true
    } catch (err) {
      this.#warn('RelativeOrientationSensor init failed:', err.message)
      this.#sensor = null
      return false
    }
  }

  /**
   * Преобразует кватернион ориентации в gammaNorm/betaNorm с blend-подходом.
   *
   * Из кватерниона извлекаем два вектора:
   * 1. Вектор гравитации (куда направлена сила тяжести в координатах экрана)
   *    → beta (вертикаль) и gravity-gamma (горизонталь при наклоне)
   * 2. Нормаль экрана (куда "смотрит" экран в координатах Земли)
   *    → azimuth-gamma (горизонталь при вертикальном положении)
   *
   * Когда телефон наклонён — gravity-gamma хорошо отслеживает лево/право.
   * Когда телефон вертикален — gravity-gamma "мертва" (не чувствует yaw),
   * и мы плавно переключаемся на azimuth нормали экрана.
   */
  #quaternionToTilt(sensor) {
    const [qx, qy, qz, qw] = sensor.quaternion

    // --- Вектор гравитации в координатах экрана ---
    // Формула: g = R^T * [0, 0, 1], где R — матрица поворота из кватерниона.
    // Это третий столбец транспонированной матрицы поворота.
    // gx: горизонтальная проекция гравитации (реагирует на наклон лево/право)
    // gy: вертикальная проекция (реагирует на наклон вперёд/назад)
    // gz: перпендикулярно экрану (≈1 когда лежит, ≈0 когда стоит)
    const gx = 2 * (qx * qz - qw * qy)
    const gy = 2 * (qy * qz + qw * qx)
    // const gz = 1 - 2 * (qx * qx + qy * qy);  // не используем напрямую

    // --- Beta (вертикаль) — из вектора гравитации ---
    // asin(gy) даёт угол наклона в градусах.
    // Работает корректно при любой ориентации телефона.
    const betaDeg = Math.asin(this.#clamp(gy)) * RAD2DEG
    const betaNorm = this.#clamp((betaDeg - BETA_OFFSET) / BETA_RANGE)

    // --- Gamma (горизонталь) с blend ---

    // 1. Gravity-подход: из горизонтальной проекции гравитации.
    //    Знак инвертирован: при наклоне вправо gx < 0, а нам нужен gammaNorm > 0.
    const gravityGammaDeg = Math.asin(this.#clamp(gx)) * RAD2DEG
    const gravityGamma = this.#clamp(-gravityGammaDeg / GAMMA_RANGE)

    // 2. Azimuth-подход: куда "смотрит" экран в горизонтальной плоскости.
    //    Нормаль экрана (device Z) в координатах Earth — первый столбец^T... нет,
    //    это третий столбец R (не транспонированной): n = R * [0, 0, 1].
    const nx = 2 * (qx * qz + qw * qy)
    const ny = 2 * (qy * qz - qw * qx)

    // Степень вертикальности = длина горизонтальной проекции нормали экрана.
    // Когда телефон лежит — нормаль вертикальна, проекция ≈ 0.
    // Когда телефон стоит — нормаль горизонтальна, проекция ≈ 1.
    const uprightness = Math.sqrt(nx * nx + ny * ny)

    // Азимут нормали экрана в горизонтальной плоскости (градусы).
    // Реагирует на поворот вокруг вертикальной оси (yaw) при любом наклоне.
    // Когда телефон лежит — значение нестабильно (проекция ≈ 0, шум),
    // но blend = 0 и оно не используется.
    const azimuthDeg = Math.atan2(nx, ny) * RAD2DEG

    const { blend, azimuthGamma, newBase } = this.#computeYawBlend(uprightness, azimuthDeg, this.#azimuthBase)
    this.#azimuthBase = newBase

    // 3. Итоговый gamma: плавная интерполяция.
    const gammaNorm = gravityGamma * (1 - blend) + azimuthGamma * blend

    this.#tiltResult.gammaNorm = gammaNorm
    this.#tiltResult.betaNorm = betaNorm
    return this.#tiltResult
  }

  #initDeviceOrientation() {
    if (!this.#deviceOrientationHandler) {
      this.#deviceOrientationHandler = this.#throttle(this.#handleDeviceOrientation, this.config.refreshRate)
    }

    window.addEventListener('deviceorientation', this.#deviceOrientationHandler, { passive: true })

    this.#log('Using deviceorientation')
  }

  #initMouse() {
    if (!this.config.useMouse) return

    if (!this.#mouseMoveHandler) {
      this.#mouseMoveHandler = this.#throttle(this.#handleMouseMove, this.config.refreshRate)
    }

    window.addEventListener('mousemove', this.#mouseMoveHandler, {
      passive: true,
    })

    this.#log('Using mouse fallback')
  }

  async #requestIOSPermission() {
    if (typeof DeviceOrientationEvent === 'undefined' || typeof DeviceOrientationEvent.requestPermission !== 'function') {
      return true
    }

    try {
      this.#log('Requesting iOS permission...')
      const result = await DeviceOrientationEvent.requestPermission()

      if (result === 'granted') {
        this.#log('iOS permission granted')
        return true
      }

      this.#warn('iOS permission denied')
      return false
    } catch (err) {
      this.#error('iOS permission error:', err.message)
      return false
    }
  }

  // =============================================================
  // ПРОВЕРКА БАТАРЕИ
  // =============================================================

  async #checkBattery() {
    if (this.config.minBattery <= 0) return true

    const battery = await navigator.getBattery?.()
    if (!battery) return true

    if (battery.level < this.config.minBattery) {
      this.#warn(`Battery low (${(battery.level * 100).toFixed(0)}%), stopping sensors`)
      this.stop()
      this.dispatchEvent(
        new CustomEvent('lowbattery', {
          detail: { level: battery.level },
        }),
      )
      return false
    }

    return true
  }

  #startBatteryCheck() {
    if (this.config.minBattery <= 0) return
    this.#batteryCheckInterval = setInterval(() => this.#checkBattery(), BATTERY_CHECK_INTERVAL)
  }

  #stopBatteryCheck() {
    if (this.#batteryCheckInterval) {
      clearInterval(this.#batteryCheckInterval)
      this.#batteryCheckInterval = null
    }
  }

  // =============================================================
  // ПУБЛИЧНЫЕ МЕТОДЫ
  // =============================================================

  /**
   * Запускает отслеживание ориентации.
   * Автоматически выбирает лучший доступный источник данных.
   */
  async start() {
    const batteryOk = await this.#checkBattery()
    if (!batteryOk) return

    this.#startBatteryCheck()
    this.#startAnimationLoop()

    if (this.#initTelegramAPI()) return

    const hasPermission = await this.#requestIOSPermission()
    if (!hasPermission) return

    if (await this.#initOrientationSensor()) return

    this.#initDeviceOrientation()
    this.#initMouse()
  }

  /** Останавливает отслеживание ориентации и освобождает ресурсы. */
  stop() {
    this.#stopBatteryCheck()
    this.#stopAnimationLoop()

    if (this.#twaOrientation) {
      this.#twaOrientation.stop()
      window.Telegram?.WebApp?.offEvent('deviceOrientationChanged', this.#twaHandler)
      this.#twaHandler = null
      this.#twaOrientation = null
    }

    if (this.#sensor) {
      this.#sensor.stop()
      this.#sensor = null
    }

    if (this.#deviceOrientationHandler) {
      window.removeEventListener('deviceorientation', this.#deviceOrientationHandler)
      this.#deviceOrientationHandler = null
    }

    if (this.#mouseMoveHandler) {
      window.removeEventListener('mousemove', this.#mouseMoveHandler)
      this.#mouseMoveHandler = null
    }

    // Сброс yaw-баз для корректного рестарта
    this.#alphaBase = null
    this.#azimuthBase = null

    this.#log('Stopped')
  }

  /** @param {string} eventName @param {Function} callback */
  on(eventName, callback) {
    this.addEventListener(eventName, callback)
  }

  /** @param {string} eventName @param {Function} callback */
  off(eventName, callback) {
    this.removeEventListener(eventName, callback)
  }
}
