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
  battery,
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
  let motionReduced = reducedMotion
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
    getBattery: typeof battery === 'function'
      ? battery
      : batteryLevel == null
        ? undefined
        : async () => ({ level: batteryLevel }),
  })
  defineGlobal('matchMedia', (query) => ({
    get matches() {
      return motionReduced && String(query).includes('prefers-reduced-motion')
    },
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
    setReduced(value) { motionReduced = value },
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

  test('lifting reduced motion on iOS waits for a click instead of the pointer', async () => {
    let calls = 0
    const fake = installBrowser({
      reducedMotion: true,
      requestPermission: async () => {
        calls += 1
        return 'granted'
      },
    })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0 })
    const needed = []
    gyro.on('permissionneeded', (e) => needed.push(e.detail ?? null))
    await gyro.start()
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)

    fake.setReduced(false)
    fake.mediaListeners[0]({ matches: false })
    assert.equal(calls, 0)
    assert.equal(fake.count('deviceorientation'), 0)
    assert.equal(fake.count('pointermove'), 0)
    assert.equal(needed.length, 1)
    assert.equal(needed[0].reason, 'gesture')

    navigator.userActivation.isActive = true
    fake.emit('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
    assert.equal(fake.mediaListeners.length, 0)
  })

  test('stop drops the deferred iOS gesture', async () => {
    let calls = 0
    const fake = installBrowser({
      reducedMotion: true,
      requestPermission: async () => {
        calls += 1
        return 'granted'
      },
    })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0 })
    await gyro.start()
    fake.setReduced(false)
    fake.mediaListeners[0]({ matches: false })
    gyro.stop()
    navigator.userActivation.isActive = true
    fake.emit('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 0)
    assert.equal(fake.count('click'), 0)
  })

  test('lifting reduced motion without requestPermission attaches sensors', async () => {
    const fake = installBrowser({ reducedMotion: true })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0 })
    await gyro.start()
    fake.setReduced(false)
    fake.mediaListeners[0]({ matches: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
  })

  test('a real orientation sample drops the pointer so it cannot override the gyro', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push({ ...e.detail }))
    await gyro.start()

    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: null })
    assert.equal(fake.count('pointermove'), 1)

    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 70 })
    assert.equal(fake.count('pointermove'), 0)
    assert.equal(events.at(-1).gammaPercent, '100.00')

    fake.emit('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 })
    assert.equal(events.at(-1).gammaPercent, '100.00')
    gyro.stop()
  })

  test('change events keep an immutable detail snapshot', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const details = []
    gyro.on('change', (e) => details.push(e.detail))
    await gyro.start()
    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 35 })
    fake.emit('deviceorientation', { alpha: 0, beta: 0, gamma: 70 })
    assert.notEqual(details[0], details[1])
    assert.equal(details[0].gammaPercent, '75.00')
    assert.equal(details[1].gammaPercent, '100.00')
    gyro.stop()
  })

  test('stop lets the same orientation emit again', async () => {
    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push(e.detail.gammaPercent))
    await gyro.start()
    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 35 })
    const before = events.length
    gyro.stop()
    await gyro.start()
    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 35 })
    assert.equal(events.length, before + 1)
    assert.equal(events.at(-1), '75.00')
    gyro.stop()
  })

  test('pointer throttle emits the latest sample after the window', async (t) => {
    const realNow = performance.now
    let now = 5000
    performance.now = () => now
    t.after(() => { performance.now = realNow })
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })

    const fake = installBrowser()
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 1000, respectReducedMotion: false })
    const events = []
    gyro.on('change', (e) => events.push(e.detail.gammaPercent))
    await gyro.start()

    fake.emit('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 })
    assert.deepEqual(events, ['60.00'])
    now = 5010
    fake.emit('pointermove', { pointerType: 'mouse', clientX: 1000, clientY: 500 })
    assert.deepEqual(events, ['60.00'])
    now = 6000
    t.mock.timers.tick(1000)
    assert.equal(events.at(-1), '40.00')

    now = 7000
    fake.emit('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 })
    assert.equal(events.at(-1), '60.00')
    now = 7010
    fake.emit('pointermove', { pointerType: 'mouse', clientX: 1000, clientY: 500 })
    gyro.stop()
    t.mock.timers.tick(1000)
    assert.equal(events.at(-1), '60.00')
  })

  test('orientation sensor uses refreshRate and drops probe listeners on error', async () => {
    let options
    const removed = []
    class BadSensor extends EventTarget {
      constructor(opts) {
        super()
        options = opts
      }
      removeEventListener(type, fn, opts) {
        removed.push(type)
        super.removeEventListener(type, fn, opts)
      }
      start() {
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
      }
      stop() {}
    }
    const fake = installBrowser({ sensor: BadSensor })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 50, respectReducedMotion: false })
    await gyro.start()
    assert.equal(options.frequency, 20)
    assert.equal(options.referenceFrame, 'screen')
    assert.ok(removed.includes('reading'))
    assert.ok(removed.includes('error'))
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
  })

  test('a silent sensor timeout removes both probe listeners', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const removed = []
    class SilentSensor extends EventTarget {
      removeEventListener(type, fn, opts) {
        removed.push(type)
        super.removeEventListener(type, fn, opts)
      }
      start() {}
      stop() {}
    }
    const fake = installBrowser({ sensor: SilentSensor })
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    const pending = gyro.start()
    await flushMicrotasks()
    t.mock.timers.tick(1500)
    await pending
    assert.ok(removed.includes('reading'))
    assert.ok(removed.includes('error'))
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
  })

  test('telegram start failure falls back and asks the host to stop', async () => {
    let stops = 0
    let subscribed = 0
    const fake = installBrowser()
    window.Telegram = {
      WebApp: {
        platform: 'android',
        DeviceOrientation: {
          start() { throw new Error('denied') },
          stop() { stops += 1 },
        },
        onEvent() { subscribed += 1 },
        offEvent() {},
      },
    }
    const gyro = new GyroShine({ minBattery: 0, refreshRate: 0, respectReducedMotion: false })
    await gyro.start()
    assert.equal(stops, 1)
    assert.equal(subscribed, 0)
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
    delete window.Telegram
  })

  test('stale battery sample does not stop a newer session', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const pending = []
    const fake = installBrowser({
      battery: () => new Promise((resolve) => { pending.push(resolve) }),
    })
    const gyro = new GyroShine({ minBattery: 0.4, refreshRate: 0, respectReducedMotion: false })
    const levels = []
    gyro.on('lowbattery', (e) => levels.push(e.detail.level))

    const starting = gyro.start()
    assert.equal(pending.length, 1)
    pending[0]({ level: 0.9 })
    await starting
    assert.equal(fake.count('deviceorientation'), 1)

    t.mock.timers.tick(10000)
    assert.equal(pending.length, 2)
    const restart = gyro.start()
    assert.equal(pending.length, 3)
    pending[1]({ level: 0.05 })
    await flushMicrotasks()
    assert.deepEqual(levels, [])
    pending[2]({ level: 0.8 })
    await restart
    assert.deepEqual(levels, [])
    assert.equal(fake.count('deviceorientation'), 1)
    gyro.stop()
  })

  test('battery interval still stops the session that is current', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const pending = []
    const fake = installBrowser({
      battery: () => new Promise((resolve) => { pending.push(resolve) }),
    })
    const gyro = new GyroShine({ minBattery: 0.4, refreshRate: 0, respectReducedMotion: false })
    const levels = []
    gyro.on('lowbattery', (e) => levels.push(e.detail.level))
    const starting = gyro.start()
    pending[0]({ level: 0.9 })
    await starting
    t.mock.timers.tick(10000)
    pending[1]({ level: 0.1 })
    await flushMicrotasks()
    assert.deepEqual(levels, [0.1])
    assert.equal(fake.count('deviceorientation'), 0)
  })

  test('spring follows frame time and emitted percents stay inside 0..100', async () => {
    const realRaf = globalThis.requestAnimationFrame
    const realCancel = globalThis.cancelAnimationFrame
    try {
      const at60 = await sampleSpring(1000 / 60, 12)
      const at120 = await sampleSpring(1000 / 120, 24)
      assert.ok(Math.abs(at60 - at120) < 2, `${at60} vs ${at120}`)

      const samples = await overshootPercents()
      assert.ok(samples.length > 1)
      for (const value of samples) {
        assert.ok(value >= 0 && value <= 100, String(value))
        assert.match(value.toFixed(2), /^\d+\.\d{2}$/)
      }
      assert.ok(samples.includes(100))
    } finally {
      globalThis.requestAnimationFrame = realRaf
      globalThis.cancelAnimationFrame = realCancel
    }
  })
})

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function pumpFrames(frameMs, steps) {
  const queue = []
  globalThis.requestAnimationFrame = (fn) => {
    queue.push(fn)
    return queue.length
  }
  globalThis.cancelAnimationFrame = (id) => {
    queue[id - 1] = null
  }
  return (afterSchedule) => {
    afterSchedule()
    const anchor = queue.shift()
    assert.ok(anchor)
    anchor(0)
    for (let i = 1; i <= steps; i += 1) {
      const fn = queue.shift()
      assert.ok(fn)
      fn(i * frameMs)
    }
  }
}

async function sampleSpring(frameMs, steps) {
  const run = pumpFrames(frameMs, steps)
  const fake = installBrowser()
  const gyro = new GyroShine({
    minBattery: 0,
    refreshRate: 0,
    respectReducedMotion: false,
    animate: true,
    useSpring: true,
    stiffness: 0.18,
    damping: 0.75,
  })
  let last = null
  gyro.on('change', (e) => { last = Number(e.detail.gammaPercent) })
  await gyro.start()
  run(() => {
    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 70 })
  })
  gyro.stop()
  assert.equal(typeof last, 'number')
  return last
}

async function overshootPercents() {
  const run = pumpFrames(1000 / 60, 8)
  const fake = installBrowser()
  const gyro = new GyroShine({
    minBattery: 0,
    refreshRate: 0,
    respectReducedMotion: false,
    animate: true,
    useSpring: true,
    stiffness: 1,
    damping: 0.5,
  })
  const samples = []
  gyro.on('change', (e) => samples.push(Number(e.detail.gammaPercent)))
  await gyro.start()
  run(() => {
    fake.emit('deviceorientation', { alpha: 0, beta: 45, gamma: 70 })
  })
  gyro.stop()
  return samples
}
