import type { FeatureFlags } from '../../core/ports/FeatureFlags.ts'
import { flagRegistry, type FlagName } from '../../core/flags/registry.ts'

// Local development, tests, and any environment whose AppConfig is not wired
// yet: registry defaults unless a test sets a flag explicitly.
export class InMemoryFeatureFlags implements FeatureFlags {
  private readonly overrides = new Map<FlagName, boolean>()

  constructor(initial: Partial<Record<FlagName, boolean>> = {}) {
    for (const [name, enabled] of Object.entries(initial) as [FlagName, boolean][]) {
      this.overrides.set(name, enabled)
    }
  }

  set(name: FlagName, enabled: boolean): void {
    this.overrides.set(name, enabled)
  }

  async isEnabled(name: FlagName): Promise<boolean> {
    return this.overrides.get(name) ?? flagRegistry[name].default
  }
}
