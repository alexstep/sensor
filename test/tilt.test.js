import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, test } from 'node:test'
import GyroShine, {
  computeYawBlend,
  deviceOrientationToNorm,
  formatPercent,
  normToPercent,
  normsToCssVars,
} from '../sensors.js'

test('formatPercent rounds to two decimals', () => {
  assert.equal(formatPercent(50), '50.00')
  assert.equal(formatPercent(0), '0.00')
  assert.equal(formatPercent(100), '100.00')
  assert.equal(formatPercent(64.285714), '64.29')
})

test('normToPercent maps -1..1 onto 0..100 with 50 at rest', () => {
  assert.equal(normToPercent(-1), '0.00')
  assert.equal(normToPercent(0), '50.00')
  assert.equal(normToPercent(1), '100.00')
  assert.equal(normToPercent(0.5), '75.00')
  assert.deepEqual(normsToCssVars(-1, 1), {
    gammaPercent: '0.00',
    betaPercent: '100.00',
  })
})

test('deviceorientation ignores empty and upside-down samples', () => {
  assert.equal(deviceOrientationToNorm({ alpha: 0, beta: 45, gamma: null }, null), null)
  assert.equal(deviceOrientationToNorm({ alpha: 0, beta: null, gamma: 0 }, null), null)
  assert.equal(deviceOrientationToNorm({ alpha: 0, beta: 91, gamma: 0 }, null), null)
})

test('flat-in-hand pose is neutral gamma and a held beta of 45°', () => {
  const tilt = deviceOrientationToNorm({ alpha: 10, beta: 45, gamma: 0 }, null)
  assert.ok(tilt)
  assert.equal(tilt.gammaNorm, 0)
  assert.equal(tilt.betaNorm, 0)
  assert.deepEqual(normsToCssVars(tilt.gammaNorm, tilt.betaNorm), {
    gammaPercent: '50.00',
    betaPercent: '50.00',
  })
})

test('gamma ±70° reaches the horizontal edges while the phone is in hand', () => {
  const right = deviceOrientationToNorm({ alpha: 0, beta: 0, gamma: 70 }, null)
  const left = deviceOrientationToNorm({ alpha: 0, beta: 0, gamma: -70 }, null)
  assert.ok(right && left)
  assert.deepEqual(normsToCssVars(right.gammaNorm, right.betaNorm), {
    gammaPercent: '100.00',
    betaPercent: '0.00',
  })
  assert.deepEqual(normsToCssVars(left.gammaNorm, left.betaNorm), {
    gammaPercent: '0.00',
    betaPercent: '0.00',
  })
})

test('a 35° tilt while the phone is in hand is 75% gamma', () => {
  const tilt = deviceOrientationToNorm({ alpha: 0, beta: 45, gamma: 35 }, null)
  assert.ok(tilt)
  assert.equal(tilt.gammaNorm, 0.5)
  assert.equal(tilt.betaNorm, 0)
  assert.equal(normToPercent(tilt.gammaNorm), '75.00')
})

test('upright yaw uses alpha delta instead of a dead gamma', () => {
  const tilt = deviceOrientationToNorm({ alpha: 35, beta: 90, gamma: 0 }, 0)
  assert.ok(tilt)
  assert.equal(tilt.gammaNorm, 0.5)
  assert.equal(tilt.betaNorm, 1)
  assert.equal(tilt.alphaBase, 0)
  assert.deepEqual(normsToCssVars(tilt.gammaNorm, tilt.betaNorm), {
    gammaPercent: '75.00',
    betaPercent: '100.00',
  })
})

test('yaw blend freezes the base once the phone is upright and wraps ±180°', () => {
  const tilted = computeYawBlend(0.5, 40, 10)
  assert.equal(tilted.blend, 0)
  assert.equal(tilted.azimuthGamma, 0)
  assert.equal(tilted.newBase, 40)

  const upright = computeYawBlend(1, 35, 0)
  assert.equal(upright.blend, 1)
  assert.equal(upright.azimuthGamma, 0.5)
  assert.equal(upright.newBase, 0)

  const wrapped = computeYawBlend(1, -170, 170)
  assert.equal(wrapped.blend, 1)
  assert.ok(Math.abs(wrapped.azimuthGamma - 20 / 70) < 1e-12)
})

test('sensors.js stays a single small file', () => {
  const bytes = fs.statSync(new URL('../sensors.js', import.meta.url)).size
  assert.ok(bytes < 40_000, `sensors.js is ${bytes} bytes`)
})

function installBrowser({
  secure = true,
  userActive = false,
  requestPermission,
  sensor,
  batteryLevel,
  reducedMotion = false,
} = {}) {
  const listeners = new Map()
  const windowMock = {
    isSecureContext: secure,
    innerWidth: 1000,
    innerHeight: 500,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = (listeners.get(type) ?? []).filter((item) => item !== fn)
      listeners.set(type, list)
    },
  }
  if (sensor !== undefined) windowMock.RelativeOrientationSensor = sensor

  const mediaListeners = []
  const defineGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }

  defineGlobal('window', windowMock)
  defineGlobal('navigator', {
    userActivation: { isActive: userActive, hasBeenActive: userActive },
    getBattery: batteryLevel == null
      ? undefined
      : async () => ({ level: batteryLevel }),
  })
  defineGlobal('matchMedia', (query) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    addEventListener(_type, fn) { mediaListeners.push(fn) },
    removeEventListener(_type, fn) {
      const index = mediaListeners.indexOf(fn)
      if (index >= 0) mediaListeners.splice(index, 1)
    },
  }))

  if (requestPermission) {
    defineGlobal('DeviceOrientationEvent', { requestPermission })
  } else {
    delete globalThis.DeviceOrientationEvent
  }

  return {
    listeners,
    mediaListeners,
    count(type) {
      return (listeners.get(type) ?? []).length
    },
    emit(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
  }
}

describe('GyroShine lifecycle', { concurrency: 1 }, () => {
  test('deviceorientation updates CSS percents and stop removes listeners', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push({ ...e.detail }))

    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 1)
    assert.equal(fake.count('pointermove'), 1)

    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 0 })
    assert.deepEqual(events.at(-1), { gammaPercent: '50.00', betaPercent: '50.00' })

    fake.emit('deviceorientation', { alpha: 0, beta: 0, gamma: 70 })
    assert.deepEqual(events.at(-1), { gammaPercent: '100.00', betaPercent: '0.00' })

    gyro.stop()
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)

    const before = events.length
    fake.emit('deviceorientation', { alpha: 0, beta: 0, gamma: -70 })
    assert.equal(events.length, before)
  })

  test('pointer fallback ignores touch and maps the corner to a small offset', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push({ ...e.detail }))
    await gyro.start()

    fake.emit('pointermove', { pointerType: 'touch', clientX: 0, clientY: 0 })
    assert.equal(events.length, 0)

    fake.emit('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 })
    assert.deepEqual(events.at(-1), { gammaPercent: '60.00', betaPercent: '60.00' })
    gyro.stop()
  })

  test('iOS permission is not requested without a user gesture', async () => {
    let calls = 0
    const fake = installBrowser({
      requestPermission: async () => {
        calls += 1
        return 'granted'
      },
    })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    let needed = 0
    gyro.on('permissionneeded', () => { needed += 1 })

    await gyro.start()
    assert.equal(calls, 0)
    assert.equal(needed, 1)
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 1)

    gyro.stop()
    assert.equal(fake.count('pointermove'), 0)
    assert.equal(fake.mediaListeners.length, 0)
  })

  test('a prompt result is not treated as a permanent denial', async () => {
    const fake = installBrowser({
      userActive: true,
      requestPermission: async () => 'prompt',
    })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    let needed = 0
    gyro.on('permissionneeded', () => { needed += 1 })
    await gyro.start()
    assert.equal(needed, 1)
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 1)
    gyro.stop()
  })

  test('iOS permission from a user gesture subscribes to deviceorientation', async () => {
    const fake = installBrowser({
      userActive: true,
      requestPermission: async () => 'granted',
    })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
    assert.equal(fake.count('deviceorientation'), 0)
  })

  test('insecure context never subscribes to deviceorientation', async () => {
    const fake = installBrowser({ secure: false })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false, debug: true })
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 1)
    gyro.stop()
  })

  test('prefers-reduced-motion keeps the neutral CSS values', async () => {
    const fake = installBrowser({ reducedMotion: true })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0 })
    const events = []
    gyro.on('change', (e) => events.push({ ...e.detail }))
    await gyro.start()
    assert.deepEqual(events.at(-1), { gammaPercent: '50.00', betaPercent: '50.00' })
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)
    gyro.stop()
  })

  test('low battery stops before sensors are attached', async () => {
    const fake = installBrowser({ batteryLevel: 0.1 })
    const gyro = new GyroShine({ minBattery: 0.4, refreshRate: 0, respectReducedMotion: false })
    const levels = []
    gyro.on('lowbattery', (e) => levels.push(e.detail.level))
    await gyro.start()
    assert.deepEqual(levels, [0.1])
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)
  })

  test('a failed orientation sensor falls back and stop releases it', async () => {
    let stopped = false
    class BadSensor extends EventTarget {
      start() {
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
      }
      stop() { stopped = true }
    }
    const fake = installBrowser({ sensor: BadSensor })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 1)
    assert.equal(fake.count('pointermove'), 1)
    gyro.stop()
    assert.equal(stopped, true)
    assert.equal(fake.count('deviceorientation'), 0)
  })

  test('a live orientation sensor does not also listen for deviceorientation', async () => {
    class GoodSensor extends EventTarget {
      quaternion = [0, 0, 0, 1]
      start() {
        queueMicrotask(() => this.dispatchEvent(new Event('reading')))
      }
      stop() {}
    }
    const fake = installBrowser({ sensor: GoodSensor })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push({ ...e.detail }))
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)
    assert.equal(events.at(-1)?.betaPercent, '0.00')
    assert.equal(events.at(-1)?.gammaPercent, '50.00')
    gyro.stop()
  })

  test('start is idempotent and does not stack listeners', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    await gyro.start()
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 1)
    assert.equal(fake.count('pointermove'), 1)
    gyro.stop()
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)
  })
})
