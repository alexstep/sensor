import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

test('README names RelativeOrientationSensor as the sensor source', () => {
  const readme = read('README.md')
  assert.match(readme, /RelativeOrientationSensor/)
  assert.doesNotMatch(readme, /GravitySensor/)
})

test('CI audits dependencies and does not overlap Pages deploys', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /npm audit/)
  assert.match(ci, /concurrency:\s*\n\s*group: pages\s*\n\s*cancel-in-progress: true/)
})

test('demo pins the Telegram script and does not key the gesture off pointer coarseness', () => {
  const html = read('index.html')
  assert.match(html, /integrity="sha384-PyI6uk8O3pfRRl4\+CaepaS\+\+FqtEbco\/HaV3jzdYl4y\+U7HMQvn3gWVfKhjuzfzG"/)
  assert.match(html, /crossorigin="anonymous"/)
  assert.match(html, /debug:\s*false/)
  assert.doesNotMatch(html, /pointer:\s*coarse/)
  assert.match(html, /user-scalable=no/)
})
