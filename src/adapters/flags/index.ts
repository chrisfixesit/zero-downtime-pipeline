import type { FeatureFlags } from '../../core/ports/FeatureFlags.ts'
import { AppConfigAgentFeatureFlags } from './AppConfigAgentFeatureFlags.ts'
import { InMemoryFeatureFlags } from './InMemoryFeatureFlags.ts'

// Selects the flag adapter from the environment, the same way
// getEmailDispatcher selects a mail transport:
//   - local / test / not yet wired → in-memory registry defaults
//   - deployed with AppConfig      → the AppConfig Agent sidecar
// Fails loud at boot if AppConfig is selected but not configured.
export function createFeatureFlags(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FeatureFlags {
  const provider = env.FLAGS_PROVIDER ?? 'memory'

  if (provider === 'memory') return new InMemoryFeatureFlags()

  if (provider === 'appconfig') {
    const required = (key: string): string => {
      const value = env[key]
      if (!value) throw new Error(`FLAGS_PROVIDER=appconfig requires ${key}`)
      return value
    }
    return new AppConfigAgentFeatureFlags({
      baseUrl: env.APPCONFIG_AGENT_URL || 'http://localhost:2772',
      application: required('APPCONFIG_APPLICATION'),
      environment: required('APPCONFIG_ENVIRONMENT'),
      profile: required('APPCONFIG_PROFILE'),
      onError: (error) =>
        console.warn(JSON.stringify({ event: 'flags.fallback', error: String(error) })),
    })
  }

  throw new Error(`Unknown FLAGS_PROVIDER "${provider}" (expected "memory" or "appconfig")`)
}

let shared: FeatureFlags | undefined

// One adapter per process, built on first use.
export function featureFlags(): FeatureFlags {
  shared ??= createFeatureFlags()
  return shared
}
