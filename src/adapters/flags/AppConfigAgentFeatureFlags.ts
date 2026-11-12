import type { FeatureFlags } from '../../core/ports/FeatureFlags.ts'
import { flagRegistry, type FlagName } from '../../core/flags/registry.ts'
import { resolveFlag } from '../../core/flags/resolve.ts'

export type AppConfigAgentOptions = {
  baseUrl: string
  application: string
  environment: string
  profile: string
  timeoutMs?: number
  onError?: (error: unknown) => void
}

// Reads flags from the AWS AppConfig Agent sidecar over localhost HTTP. The
// agent owns polling and caching, so this adds no AWS SDK dependency and each
// call is a loopback request. Any failure (agent down, slow, bad answer) is
// reported and answered from the last document this process read, so a
// struggling agent cannot switch a released feature off. Only before the first
// good read does a failure fall back to the registry default (off): a flag
// problem must never break a page, and unfinished work defaults to off.
export class AppConfigAgentFeatureFlags implements FeatureFlags {
  private readonly url: string
  private readonly timeoutMs: number
  private readonly onError: (error: unknown) => void
  private lastGood: unknown

  constructor(options: AppConfigAgentOptions) {
    const segment = encodeURIComponent
    this.url =
      `${options.baseUrl}/applications/${segment(options.application)}` +
      `/environments/${segment(options.environment)}/configurations/${segment(options.profile)}`
    this.timeoutMs = options.timeoutMs ?? 250
    this.onError = options.onError ?? (() => {})
  }

  async isEnabled(name: FlagName): Promise<boolean> {
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!response.ok) throw new Error(`AppConfig agent answered ${response.status}`)
      const doc: unknown = await response.json()
      this.lastGood = doc
      return resolveFlag(name, doc)
    } catch (error) {
      this.onError(error)
      return this.lastGood === undefined ? flagRegistry[name].default : resolveFlag(name, this.lastGood)
    }
  }
}
