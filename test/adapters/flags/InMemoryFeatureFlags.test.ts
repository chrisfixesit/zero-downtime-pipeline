import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryFeatureFlags } from '../../../src/adapters/flags/InMemoryFeatureFlags.ts'

describe('InMemoryFeatureFlags', () => {
  it('returns registry defaults when nothing is set', async () => {
    assert.equal(await new InMemoryFeatureFlags().isEnabled('alarmDrill'), false)
  })

  it('returns initial and later overrides', async () => {
    const flags = new InMemoryFeatureFlags({ alarmDrill: true })
    assert.equal(await flags.isEnabled('alarmDrill'), true)
    flags.set('alarmDrill', false)
    assert.equal(await flags.isEnabled('alarmDrill'), false)
  })
})
