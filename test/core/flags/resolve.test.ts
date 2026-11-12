import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlag } from '../../../src/core/flags/resolve.ts'

describe('resolveFlag', () => {
  it('uses the configured value when it is a boolean', () => {
    assert.equal(resolveFlag('alarmDrill', { alarmDrill: { enabled: true } }), true)
  })

  const fallbackCases: [string, unknown][] = [
    ['null config', null],
    ['array config', []],
    ['flag missing', { other: { enabled: true } }],
    ['enabled not boolean', { alarmDrill: { enabled: 'true' } }],
    ['flag not an object', { alarmDrill: true }],
  ]
  for (const [label, config] of fallbackCases) {
    it(`falls back to the registry default when ${label}`, () => {
      assert.equal(resolveFlag('alarmDrill', config), false)
    })
  }
})
