import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { flagRegistry, flagNames, isFlagName } from '../../../src/core/flags/registry.ts'
import { staleFlags } from '../../../src/core/flags/hygiene.ts'

// AppConfig's feature-flag names must match this, so the registry must too.
const APPCONFIG_FLAG_NAME = /^[a-z][a-zA-Z0-9_-]{0,63}$/

describe('flag registry', () => {
  for (const name of flagNames) {
    it(`${name} is fully described`, () => {
      const flag = flagRegistry[name]
      assert.match(name, APPCONFIG_FLAG_NAME)
      assert.ok(flag.description.trim().length > 0)
      assert.ok(flag.description.length <= 1024)
      assert.ok(Number.isInteger(flag.issue) && flag.issue > 0)
      assert.match(flag.addedOn, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(Number.isNaN(Date.parse(`${flag.addedOn}T00:00:00Z`)), false)
    })
  }

  it('ships unfinished work switched off', () => {
    for (const name of flagNames) assert.equal(flagRegistry[name].default, false)
  })

  it('recognises only registered names', () => {
    assert.equal(isFlagName('alarmDrill'), true)
    assert.equal(isFlagName('toString'), false)
    assert.equal(isFlagName('nope'), false)
  })
})

describe('staleFlags', () => {
  const registry = {
    fresh: { default: false, description: 'x', issue: 1, addedOn: '2026-10-01' },
    old: { default: false, description: 'x', issue: 2, addedOn: '2026-07-01' },
  }

  it('lists flags older than the limit, oldest first', () => {
    assert.deepEqual(staleFlags(new Date('2026-10-09T00:00:00Z'), 60, registry), ['old'])
  })

  it('treats exactly the limit as not stale', () => {
    assert.deepEqual(staleFlags(new Date('2026-08-30T00:00:00Z'), 60, registry), [])
  })
})
