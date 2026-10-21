import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createDemoServer, demoHost } from '../scripts/demo-server.js'

function status(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
  })
}

test('demo server binds to loopback and hides dotfiles and package manifests', async () => {
  assert.equal(demoHost, process.env.HOST || '127.0.0.1')
  const server = createDemoServer()
  server.listen(0, demoHost)
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.equal(address.address, '127.0.0.1')
    const { port } = address
    assert.equal(await status(port, '/index.html'), 200)
    assert.equal(await status(port, '/sensors.js'), 200)
    assert.equal(await status(port, '/other/ex0.html'), 200)
    assert.equal(await status(port, '/package.json'), 404)
    assert.equal(await status(port, '/package-lock.json'), 404)
    assert.equal(await status(port, '/.gitignore'), 404)
    assert.equal(await status(port, '/.github/workflows/ci.yml'), 404)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
