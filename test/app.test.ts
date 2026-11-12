import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHandler } from '../src/app.ts'
import { InMemoryFeatureFlags } from '../src/adapters/flags/InMemoryFeatureFlags.ts'

const VERSION = 'a'.repeat(40)

async function serve(flags: InMemoryFeatureFlags): Promise<{ server: Server; base: string }> {
  const server = createServer(createHandler({ version: VERSION, flags }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

let plain: Awaited<ReturnType<typeof serve>>
let drill: Awaited<ReturnType<typeof serve>>

before(async () => {
  plain = await serve(new InMemoryFeatureFlags())
  drill = await serve(new InMemoryFeatureFlags({ alarmDrill: true }))
})

after(() => {
  plain.server.close()
  drill.server.close()
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
