/**
 * GyroShine — класс для получения данных ориентации устройства
 * и трансляции их через CustomEvent.
 *
 * Поддерживает четыре источника данных (в порядке приоритета):
 * 1. Telegram Mini Apps API — внутри приложения Telegram на iOS/Android
 * 2. RelativeOrientationSensor — Sensor API (Chrome, Android)
 * 3. deviceorientation — fallback для Safari и остальных браузеров
 * 4. pointermove — fallback для десктопа (мышь и перо, без touch; включён по умолчанию)
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
 *   gyro.on('change', (e) => {
 *     e.detail.gammaPercent
 *     e.detail.betaPercent
 *   });
 *   gyro.start();
 *
 * iOS 13+: DeviceOrientationEvent.requestPermission() вызывается синхронно
 * из start(), поэтому start() нужно звать из обработчика клика/тапа.
 * Датчики движения работают только в secure context (HTTPS или localhost).
 * При prefers-reduced-motion: reduce слушатели не вешаются.
 * Если датчиков нет — fallback на pointermove (мышь и перо, не touch).
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
const SENSOR_START_TIMEOUT = 1500
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function clamp(value, min = -1, max = 1) {
  return Math.min(max, Math.max(min, value))
}

/** 0–100 percent → CSS string with two decimals ("50.00"). */
export function formatPercent(percent) {
  return (Math.round(percent * 100) / 100).toFixed(2)
}

/** Normalized tilt -1..1 → CSS percent. 0 is the neutral "50.00". */
export function normToPercent(norm) {
  return formatPercent((norm + 1) * 50)
}

export function normsToCssVars(gammaNorm, betaNorm) {
  return {
    gammaPercent: normToPercent(gammaNorm),
    betaPercent: normToPercent(betaNorm),
  }
}

/**
 * Blend gravity-gamma with yaw when the phone is nearly upright.
 * @returns {{ blend: number, azimuthGamma: number, newBase: number }}
 */
export function computeYawBlend(uprightness, angleDeg, baseDeg) {
  const blend = clamp((uprightness - UPRIGHT_START) / UPRIGHT_RANGE, 0, 1)

  let newBase = baseDeg ?? angleDeg
  let azimuthGamma = 0

  if (blend < 0.01) {
    newBase = angleDeg
  } else {
    let delta = angleDeg - newBase
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360
    azimuthGamma = clamp(delta / GAMMA_RANGE)
  }

  return { blend, azimuthGamma, newBase }
}

/**
 * deviceorientation Euler angles → normalized gamma/beta.
 * Returns null when the sample must be ignored.
 * @param {{ alpha?: number|null, beta?: number|null, gamma?: number|null }} angles
 * @param {number|null} alphaBase
 * @returns {{ gammaNorm: number, betaNorm: number, alphaBase: number } | null}
 */
export function deviceOrientationToNorm(angles, alphaBase) {
  const { alpha, beta, gamma } = angles
  if (gamma == null || beta == null) return null
  if (beta > 90) return null

  const betaNorm = clamp((beta - BETA_OFFSET) / BETA_RANGE)
  const gravityGamma = clamp(gamma / GAMMA_RANGE)
  const uprightness = Math.sin(beta * DEG2RAD)
  const yaw = computeYawBlend(uprightness, alpha ?? 0, alphaBase)
  const gammaNorm = gravityGamma * (1 - yaw.blend) + yaw.azimuthGamma * yaw.blend

  return { gammaNorm, betaNorm, alphaBase: yaw.newBase }
}

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
  #pointerHandler = null
  #onSensorReading = null
  #generation = 0
  #active = false
  #motionMedia = null
  #onMotionMediaChange = null

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
   * @param {boolean} [options.useMouse=true] — fallback на указатель (мышь/перо) на десктопе
   * @param {boolean} [options.respectReducedMotion=true] — не слушать датчики при prefers-reduced-motion
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
      respectReducedMotion: options.respectReducedMotion ?? true,
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
    return clamp(value, min, max)
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
    return computeYawBlend(uprightness, angleDeg, baseDeg)
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

    this.#detail.gammaPercent = formatPercent(gammaPercent)
    this.#detail.betaPercent  = formatPercent(betaPercent)

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
    const tilt = deviceOrientationToNorm(
      { alpha: e.alpha, beta: e.beta, gamma: e.gamma },
      this.#alphaBase,
    )
    if (!tilt) return
    this.#alphaBase = tilt.alphaBase
    this.#setTarget(tilt.gammaNorm, tilt.betaNorm)
  }

  /**
   * Указатель на десктопе (мышь и перо). Touch не учитываем:
   * иначе скролл на телефоне перебивает гироскоп.
   * Позиция → gammaNorm/betaNorm (-1..1) с ослаблением 0.2.
   */
  #handlePointerMove = e => {
    if (e.pointerType === 'touch') return
    const width = window.innerWidth
    const height = window.innerHeight
    if (!width || !height) return
    const gammaNorm = (e.clientX / width) * 2 - 1
    const betaNorm = (e.clientY / height) * 2 - 1
    this.#setTarget(-0.2 * gammaNorm, -0.2 * betaNorm)
  }

  #emitNeutral() {
    this.#targetGamma = 0
    this.#targetBeta = 0
    this.#currentGamma = 0
    this.#currentBeta = 0
    this.#velocityGamma = 0
    this.#velocityBeta = 0
    this.#prevGP = -1
    this.#prevBP = -1
    this.#emitValues(50, 50)
  }

  #motionBlocked() {
    return this.config.respectReducedMotion !== false && this.#prefersReducedMotion()
  }

  #prefersReducedMotion() {
    if (typeof matchMedia !== 'function') return false
    try {
      return matchMedia(REDUCED_MOTION_QUERY).matches
    } catch {
      return false
    }
  }

  #isSecureContext() {
    if (typeof window === 'undefined') return true
    if (typeof window.isSecureContext === 'boolean') return window.isSecureContext
    return true
  }

  #watchMotionPreference() {
    if (this.config.respectReducedMotion === false) return
    if (typeof matchMedia !== 'function') return
    if (this.#motionMedia) return

    this.#motionMedia = matchMedia(REDUCED_MOTION_QUERY)
    this.#onMotionMediaChange = (event) => {
      if (!this.#active) return
      if (event.matches) {
        this.#detachSources()
        this.#emitNeutral()
        return
      }
      void this.start()
    }
    this.#motionMedia.addEventListener('change', this.#onMotionMediaChange)
  }

  #unwatchMotionPreference() {
    if (this.#motionMedia && this.#onMotionMediaChange) {
      this.#motionMedia.removeEventListener('change', this.#onMotionMediaChange)
    }
    this.#motionMedia = null
    this.#onMotionMediaChange = null
  }

  #armRuntime() {
    this.#startBatteryCheck()
    this.#startAnimationLoop()
    this.#watchMotionPreference()
  }

  async #readBatteryLevel() {
    if (this.config.minBattery <= 0) return null
    if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return null
    try {
      const battery = await navigator.getBattery()
      if (!battery || typeof battery.level !== 'number') return null
      return battery.level
    } catch {
      return null
    }
  }

  #batteryTooLow(level) {
    if (level == null || level >= this.config.minBattery) return false
    this.#warn(`Battery low (${(level * 100).toFixed(0)}%), stopping sensors`)
    this.stop()
    this.dispatchEvent(new CustomEvent('lowbattery', { detail: { level } }))
    return true
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
    const SensorCtor = window.RelativeOrientationSensor
    if (typeof SensorCtor !== 'function') return false

    let sensor
    try {
      sensor = new SensorCtor({
        frequency: SENSOR_FREQUENCY,
        referenceFrame: 'screen',
      })
      this.#sensor = sensor

      this.#onSensorReading = () => {
        if (this.#sensor !== sensor) return
        const tilt = this.#quaternionToTilt(sensor)
        this.#setTarget(tilt.gammaNorm, tilt.betaNorm)
      }
      sensor.addEventListener('reading', this.#onSensorReading)

      const ok = await new Promise(resolve => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => finish(false), SENSOR_START_TIMEOUT)
        sensor.addEventListener('reading', () => finish(true), { once: true })
        sensor.addEventListener('error', (event) => {
          const message = event?.error?.message ?? 'unknown'
          this.#error('OrientationSensor error:', message)
          finish(false)
        }, { once: true })
        sensor.start()
      })

      if (!ok || this.#sensor !== sensor) {
        this.#releaseSensor(sensor)
        if (this.#sensor === sensor) this.#sensor = null
        return false
      }

      this.#log('Using RelativeOrientationSensor')
      return true
    } catch (err) {
      this.#warn('RelativeOrientationSensor init failed:', err.message)
      if (sensor) this.#releaseSensor(sensor)
      if (this.#sensor === sensor) this.#sensor = null
      return false
    }
  }

  #releaseSensor(sensor) {
    if (!sensor) return
    if (this.#onSensorReading) sensor.removeEventListener('reading', this.#onSensorReading)
    try {
      sensor.stop()
    } catch {
      // Sensor may already be stopped or failed before start().
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

  #initPointer() {
    if (!this.config.useMouse) return

    if (!this.#pointerHandler) {
      this.#pointerHandler = this.#throttle(this.#handlePointerMove, this.config.refreshRate)
    }

    window.addEventListener('pointermove', this.#pointerHandler, { passive: true })
    this.#log('Using pointer fallback')
  }

  /**
   * Вызывает requestPermission() синхронно, до любых await в start().
   * На iOS 13+ разрешение выдаётся только из user gesture и только по HTTPS.
   * @returns {Promise<'unavailable'|'insecure'|'skipped'|'granted'|'denied'>}
   */
  #kickIOSPermission() {
    if (typeof DeviceOrientationEvent === 'undefined' || typeof DeviceOrientationEvent.requestPermission !== 'function') {
      return Promise.resolve('unavailable')
    }

    if (!this.#isSecureContext()) return Promise.resolve('insecure')

    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined
    if (activation && activation.isActive === false) {
      this.#warn('iOS motion permission needs a user gesture')
      this.dispatchEvent(new CustomEvent('permissionneeded'))
      return Promise.resolve('skipped')
    }

    this.#log('Requesting iOS permission...')
    try {
      return DeviceOrientationEvent.requestPermission()
        .then((result) => {
          if (result === 'granted') {
            this.#log('iOS permission granted')
            return 'granted'
          }
          // Chromium может вернуть "prompt", если диалог не закрыт выбором.
          // Это не отказ: остаётся fallback и событие permissionneeded.
          if (result === 'prompt') {
            this.#warn('Motion permission still prompt')
            this.dispatchEvent(new CustomEvent('permissionneeded', { detail: { result } }))
            return 'skipped'
          }
          this.#warn('iOS permission denied')
          this.dispatchEvent(new CustomEvent('permissionneeded', { detail: { result } }))
          return 'denied'
        })
        .catch((err) => {
          this.#error('iOS permission error:', err?.message)
          this.dispatchEvent(new CustomEvent('permissionneeded', { detail: { error: err?.message } }))
          return 'denied'
        })
    } catch (err) {
      this.#error('iOS permission error:', err?.message)
      this.dispatchEvent(new CustomEvent('permissionneeded', { detail: { error: err?.message } }))
      return Promise.resolve('denied')
    }
  }

  // =============================================================
  // ПРОВЕРКА БАТАРЕИ
  // =============================================================

  async #checkBattery() {
    const level = await this.#readBatteryLevel()
    if (this.#batteryTooLow(level)) return false
    return true
  }

  #startBatteryCheck() {
    if (this.config.minBattery <= 0) return
    this.#stopBatteryCheck()
    this.#batteryCheckInterval = setInterval(() => {
      void this.#checkBattery()
    }, BATTERY_CHECK_INTERVAL)
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
   * На iOS вызывайте из обработчика клика: requestPermission() требует user gesture.
   */
  async start() {
    const gen = ++this.#generation
    this.#detachSources()
    this.#unwatchMotionPreference()
    this.#active = true

    if (this.#motionBlocked()) {
      this.#emitNeutral()
      this.#watchMotionPreference()
      return
    }

    // Уровень батареи читаем параллельно, но не await-им до запроса разрешения:
    // await до requestPermission() сбрасывает user gesture на iOS.
    const levelPromise = this.#readBatteryLevel()

    if (this.#initTelegramAPI()) {
      const level = await levelPromise
      if (gen !== this.#generation || !this.#active) return
      if (this.#batteryTooLow(level)) return
      this.#armRuntime()
      return
    }

    const permissionPromise = this.#kickIOSPermission()
    const level = await levelPromise
    if (gen !== this.#generation || !this.#active) return
    if (this.#batteryTooLow(level)) return

    this.#armRuntime()

    if (!this.#isSecureContext()) {
      console.warn('[GyroShine] Motion sensors need a secure context (HTTPS or localhost). Using pointer fallback.')
      await permissionPromise
      if (gen !== this.#generation || !this.#active) return
      this.#initPointer()
      return
    }

    const permission = await permissionPromise
    if (gen !== this.#generation || !this.#active) return

    if (permission === 'denied' || permission === 'skipped' || permission === 'insecure') {
      this.#initPointer()
      return
    }

    if (await this.#initOrientationSensor()) {
      if (gen !== this.#generation || !this.#active) {
        this.#detachSources()
        return
      }
      return
    }
    if (gen !== this.#generation || !this.#active) return

    this.#initDeviceOrientation()
    this.#initPointer()
  }

  /** Останавливает отслеживание ориентации и снимает все слушатели. */
  stop() {
    this.#generation++
    this.#active = false
    this.#detachSources()
    this.#unwatchMotionPreference()
    this.#log('Stopped')
  }

  #detachSources() {
    this.#stopBatteryCheck()
    this.#stopAnimationLoop()

    if (this.#twaOrientation) {
      try {
        this.#twaOrientation.stop()
      } catch {
        // Telegram может уже остановить датчик.
      }
      window.Telegram?.WebApp?.offEvent('deviceOrientationChanged', this.#twaHandler)
      this.#twaHandler = null
      this.#twaOrientation = null
    }

    if (this.#sensor) {
      this.#releaseSensor(this.#sensor)
      this.#sensor = null
      this.#onSensorReading = null
    }

    if (this.#deviceOrientationHandler) {
      window.removeEventListener('deviceorientation', this.#deviceOrientationHandler)
      this.#deviceOrientationHandler = null
    }

    if (this.#pointerHandler) {
      window.removeEventListener('pointermove', this.#pointerHandler)
      this.#pointerHandler = null
    }

    this.#alphaBase = null
    this.#azimuthBase = null
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
