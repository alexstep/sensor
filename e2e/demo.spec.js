import { expect, test } from '@playwright/test'

async function cssVar(page, name) {
  return page.evaluate((varName) => {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  }, name)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RelativeOrientationSensor', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })
})

async function ensureSensors(page) {
  const box = page.getByRole('checkbox', { name: 'Отслеживание сенсоров' })
  if (!(await box.isChecked())) await box.check()
  return box
}

async function armOrientation(page) {
  const box = page.getByRole('checkbox', { name: 'Отслеживание сенсоров' })
  if (await box.isChecked()) await box.uncheck()
  await box.check()
}

test('deviceorientation moves the CSS variables', async ({ page }) => {
  await page.goto('/')
  const themeButton = page.getByRole('button', { name: 'Рандомная тема' })
  await expect(themeButton).toBeVisible()
  await themeButton.click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme || '')).not.toBe('')
  await armOrientation(page)

  await expect.poll(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
        alpha: 0,
        beta: 0,
        gamma: 70,
        absolute: false,
      }))
    })
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('100.00')

  await expect.poll(async () => cssVar(page, '--gyro-beta-percent')).toBe('0.00')
})

test('pointer fallback moves the shine when orientation is silent', async ({ page }) => {
  await page.goto('/')
  await ensureSensors(page)

  await expect.poll(async () => {
    await page.mouse.move(0, 0)
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('60.00')
  await expect.poll(async () => cssVar(page, '--gyro-beta-percent')).toBe('60.00')
})

test('turning sensors off removes the orientation reaction', async ({ page }) => {
  await page.goto('/')
  const sensors = await ensureSensors(page)
  await expect.poll(async () => {
    await page.mouse.move(0, 0)
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('60.00')

  await sensors.uncheck()
  const frozen = await cssVar(page, '--gyro-gamma-percent')

  await page.evaluate(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: 0,
      beta: 0,
      gamma: 70,
      absolute: false,
    }))
  })
  await page.mouse.move(1000, 400)

  await expect.poll(async () => cssVar(page, '--gyro-gamma-percent')).toBe(frozen)
  expect(frozen).not.toBe('100.00')
})

test('prefers-reduced-motion stays at the neutral point', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await ensureSensors(page)

  await expect.poll(async () => cssVar(page, '--gyro-gamma-percent')).toBe('50.00')

  await page.evaluate(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: 0,
      beta: 0,
      gamma: 70,
      absolute: false,
    }))
  })
  await page.mouse.move(0, 0)

  await expect.poll(async () => cssVar(page, '--gyro-gamma-percent')).toBe('50.00')
  await expect.poll(async () => cssVar(page, '--gyro-beta-percent')).toBe('50.00')
})

test('requestPermission keeps sensors off until a gesture on a fine pointer', async ({ page }) => {
  await page.addInitScript(() => {
    DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted')
  })
  await page.goto('/')
  const sensors = page.getByRole('checkbox', { name: 'Отслеживание сенсоров' })
  await expect(sensors).not.toBeChecked()

  const before = await cssVar(page, '--gyro-gamma-percent')
  await page.mouse.move(0, 0)
  await expect.poll(async () => cssVar(page, '--gyro-gamma-percent')).toBe(before)

  await sensors.check()
  await expect.poll(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
        alpha: 0,
        beta: 0,
        gamma: 70,
        absolute: false,
      }))
    })
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('100.00')
})

test('Telegram iOS does not gate sensors on the page gesture', async ({ page }) => {
  await page.route('**/telegram-web-app.js*', (route) => route.abort())
  await page.addInitScript(() => {
    window.__permissionAsks = 0
    DeviceOrientationEvent.requestPermission = () => {
      window.__permissionAsks += 1
      return Promise.resolve('granted')
    }
    window.Telegram = {
      WebApp: {
        platform: 'ios',
        DeviceOrientation: {
          start() {},
          stop() {},
        },
        onEvent() {},
        offEvent() {},
      },
    }
  })
  await page.goto('/')
  await expect(page.getByRole('checkbox', { name: 'Отслеживание сенсоров' })).toBeChecked()
  expect(await page.evaluate(() => window.__permissionAsks)).toBe(0)
})

test('theme controls do not throw when vibrate is missing', async ({ page }) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/')
  await page.evaluate(() => { navigator.vibrate = undefined })
  await page.getByRole('button', { name: 'Рандомная тема' }).click()
  expect(errors).toEqual([])

  await page.evaluate(() => {
    window.__vib = 0
    navigator.vibrate = () => {
      window.__vib += 1
      return true
    }
  })
  await page.getByRole('button', { name: 'Рандомная тема' }).click()
  expect(await page.evaluate(() => window.__vib)).toBeGreaterThan(0)
})

test('theme swatches drop transitions under reduced motion', async ({ page }) => {
  await page.goto('/')
  const swatch = page.locator('.theme-swatch input[type="radio"]').first()
  await expect.poll(() => swatch.evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => swatch.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s')
})

test('the demo does not print GyroShine debug logs', async ({ page }) => {
  const logs = []
  page.on('console', (msg) => logs.push(msg.text()))
  await page.goto('/')
  await ensureSensors(page)
  await expect.poll(async () => {
    await page.mouse.move(0, 0)
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('60.00')
  expect(logs.join('\n')).not.toContain('[GyroShine]')
})
