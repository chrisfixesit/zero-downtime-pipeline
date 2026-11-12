import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { createHandler } from '../src/app.ts'
import type { FeatureFlags } from '../src/core/ports/FeatureFlags.ts'
import { InMemoryFeatureFlags } from '../src/adapters/flags/InMemoryFeatureFlags.ts'

const VERSION = 'a'.repeat(40)

async function serve(flags: FeatureFlags): Promise<{ server: Server; base: string }> {
  const server = createServer(createHandler({ version: VERSION, flags }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

let plain: Awaited<ReturnType<typeof serve>>
let drill: Awaited<ReturnType<typeof serve>>
let broken: Awaited<ReturnType<typeof serve>>

before(async () => {
  plain = await serve(new InMemoryFeatureFlags())
  drill = await serve(new InMemoryFeatureFlags({ alarmDrill: true }))
  broken = await serve({ isEnabled: async () => Promise.reject(new Error('flag store down')) })
})

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

after(async () => {
  await Promise.all([plain, drill, broken].map((s) => s && close(s.server)))
})

test('GET /healthz returns ok and the version', async () => {
  const res = await fetch(`${plain.base}/healthz`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok', version: VERSION })
})

test('GET / returns service, version and uptime', async () => {
  const res = await fetch(`${plain.base}/`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.service, 'zero-downtime-pipeline')
  assert.equal(body.version, VERSION)
  assert.equal(typeof body.uptimeSeconds, 'number')
})

test('GET /drill/alarm is 404 while the alarmDrill flag is off', async () => {
  const res = await fetch(`${plain.base}/drill/alarm`)
  assert.equal(res.status, 404)
})

test('GET /drill/alarm is 500 while the alarmDrill flag is on', async () => {
  const res = await fetch(`${drill.base}/drill/alarm`)
  assert.equal(res.status, 500)
})

test('unknown paths return 404', async () => {
  const res = await fetch(`${plain.base}/nope`)
  assert.equal(res.status, 404)
})

test('a rejected flag read fails closed (404) and the server keeps serving', async () => {
  const res = await fetch(`${broken.base}/drill/alarm`)
  assert.equal(res.status, 404)
  assert.equal((await fetch(`${broken.base}/healthz`)).status, 200)
})

test('a malformed request target gets a response and the server keeps serving', async () => {
  const port = Number(new URL(plain.base).port)
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('GET //a:b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    })
    let data = ''
    socket.on('data', (chunk) => (data += chunk))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  assert.match(raw, /^HTTP\/1\.1 \d{3}/)
  assert.equal((await fetch(`${plain.base}/healthz`)).status, 200)
})
