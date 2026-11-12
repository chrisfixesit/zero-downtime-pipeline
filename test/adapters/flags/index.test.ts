import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFeatureFlags } from '../../../src/adapters/flags/index.ts'
import { InMemoryFeatureFlags } from '../../../src/adapters/flags/InMemoryFeatureFlags.ts'
import { AppConfigAgentFeatureFlags } from '../../../src/adapters/flags/AppConfigAgentFeatureFlags.ts'

describe('createFeatureFlags', () => {
  it('defaults to the in-memory adapter', () => {
    assert.ok(createFeatureFlags({}) instanceof InMemoryFeatureFlags)
  })

  it('builds the AppConfig adapter when fully configured', () => {
    assert.ok(
      createFeatureFlags({
        FLAGS_PROVIDER: 'appconfig',
        APPCONFIG_APPLICATION: 'zdp',
        APPCONFIG_ENVIRONMENT: 'sandbox',
        APPCONFIG_PROFILE: 'flags',
      }) instanceof AppConfigAgentFeatureFlags,
    )
  })

  it('fails loud at boot when AppConfig settings are missing', () => {
    assert.throws(
      () => createFeatureFlags({ FLAGS_PROVIDER: 'appconfig' }),
      { message: 'FLAGS_PROVIDER=appconfig requires APPCONFIG_APPLICATION' },
    )
  })

  it('rejects an unknown provider', () => {
    assert.throws(
      () => createFeatureFlags({ FLAGS_PROVIDER: 'launchdarkly' }),
      { message: 'Unknown FLAGS_PROVIDER "launchdarkly" (expected "memory" or "appconfig")' },
    )
  })
})
