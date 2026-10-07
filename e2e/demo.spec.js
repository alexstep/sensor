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

  await expect.poll(async () => {
    await page.mouse.move(0, 0)
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('60.00')
  await expect.poll(async () => cssVar(page, '--gyro-beta-percent')).toBe('60.00')
})

test('turning sensors off removes the orientation reaction', async ({ page }) => {
  await page.goto('/')
  await expect.poll(async () => {
    await page.mouse.move(0, 0)
    return cssVar(page, '--gyro-gamma-percent')
  }).toBe('60.00')

  const sensors = page.getByRole('checkbox', { name: 'Отслеживание сенсоров' })
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
