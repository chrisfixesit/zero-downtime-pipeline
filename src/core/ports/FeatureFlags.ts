import type { FlagName } from '../flags/registry.ts'

// Release boundary. Core and the driving adapters ask whether a flag is on;
// the adapter decides where the answer comes from (AppConfig in deployed
// environments, an in-memory fake locally and in tests). Swappable, and the
// fake makes tests deterministic, so it meets the bar for a port.
export interface FeatureFlags {
  isEnabled(name: FlagName): Promise<boolean>
}
