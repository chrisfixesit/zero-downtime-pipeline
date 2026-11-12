import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppConfigAgentFeatureFlags } from '../../../src/adapters/flags/AppConfigAgentFeatureFlags.ts'

// What the fake agent should answer next, keyed by environment name so each
// test owns its own path and tests cannot see each other's state.
const replies = new Map<string, { status: number; body: string; delayMs?: number }>()
const seenPaths: string[] = []
let server: Server
let baseUrl: string

before(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? '')
    const env = decodeURIComponent((req.url ?? '').split('/')[4] ?? '')
    const reply = replies.get(env) ?? { status: 404, body: '' }
    setTimeout(() => {
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(reply.body)
    }, reply.delayMs ?? 0)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
})

function flagsFor(environment: string, errors: unknown[] = [], timeoutMs = 250) {
  return new AppConfigAgentFeatureFlags({
    baseUrl,
    application: 'zdp',
    environment,
    profile: 'flags',
    timeoutMs,
    onError: (error) => errors.push(error),
  })
}

describe('AppConfigAgentFeatureFlags', () => {
  it('asks the agent for the configured application, environment and profile', async () => {
    replies.set('path-env', { status: 200, body: '{}' })
    await flagsFor('path-env').isEnabled('alarmDrill')
    assert.ok(seenPaths.includes('/applications/zdp/environments/path-env/configurations/flags'))
  })

  it('returns the value the agent reports', async () => {
    replies.set('on-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: true } }) })
    assert.equal(await flagsFor('on-env').isEnabled('alarmDrill'), true)
  })

  it('uses the registry default for a flag the config does not mention', async () => {
    replies.set('missing-env', { status: 200, body: JSON.stringify({ somethingElse: { enabled: true } }) })
    assert.equal(await flagsFor('missing-env').isEnabled('alarmDrill'), false)
  })

  it('fails closed and reports the error on a non-2xx answer', async () => {
    const errors: unknown[] = []
    replies.set('500-env', { status: 500, body: '{"alarmDrill":{"enabled":true}}' })
    assert.equal(await flagsFor('500-env', errors).isEnabled('alarmDrill'), false)
    assert.equal(errors.length, 1)
  })

  it('fails closed on malformed JSON', async () => {
    const errors: unknown[] = []
    replies.set('bad-json-env', { status: 200, body: '{not json' })
    assert.equal(await flagsFor('bad-json-env', errors).isEnabled('alarmDrill'), false)
    assert.equal(errors.length, 1)
  })

  it('gives up after the timeout instead of hanging the render', async () => {
    const errors: unknown[] = []
    replies.set('slow-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: true } }), delayMs: 500 })
    const started = Date.now()
    assert.equal(await flagsFor('slow-env', errors, 50).isEnabled('alarmDrill'), false)
    assert.ok(Date.now() - started < 400)
    assert.equal(errors.length, 1)
  })

  // Once a value has been read, a slow or failed read must
  // not switch a released feature off. Defaults apply only before the first read.
  it('keeps answering with the last good document when a later read fails', async () => {
    const errors: unknown[] = []
    const flags = flagsFor('flaky-env', errors)
    replies.set('flaky-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: true } }) })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
    replies.set('flaky-env', { status: 500, body: '' })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
    assert.equal(errors.length, 1)
  })

  it('keeps the last good document through a timeout', async () => {
    const flags = flagsFor('stall-env', [], 50)
    replies.set('stall-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: true } }) })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
    replies.set('stall-env', { status: 200, body: '{}', delayMs: 500 })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
  })

  it('follows a deliberate change once the agent answers again', async () => {
    const flags = flagsFor('turned-off-env')
    replies.set('turned-off-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: true } }) })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
    replies.set('turned-off-env', { status: 200, body: JSON.stringify({ alarmDrill: { enabled: false } }) })
    assert.equal(await flags.isEnabled('alarmDrill'), false)
  })

  it('fails closed when nothing is listening', async () => {
    const flags = new AppConfigAgentFeatureFlags({
      baseUrl: 'http://127.0.0.1:1',
      application: 'zdp',
      environment: 'x',
      profile: 'flags',
      onError: () => {},
    })
    assert.equal(await flags.isEnabled('alarmDrill'), false)
  })
})
