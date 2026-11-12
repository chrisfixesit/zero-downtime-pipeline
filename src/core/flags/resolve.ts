import { flagRegistry, type FlagName } from './registry.ts'

// Reads one flag out of an AppConfig feature-flag document
// ({ "<name>": { "enabled": true } }). Anything unexpected means the
// registry default, so a broken or partial config fails closed.
export function resolveFlag(name: FlagName, config: unknown): boolean {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return flagRegistry[name].default
  }
  const entry = (config as Record<string, unknown>)[name]
  if (typeof entry !== 'object' || entry === null) return flagRegistry[name].default
  const enabled = (entry as Record<string, unknown>).enabled
  return typeof enabled === 'boolean' ? enabled : flagRegistry[name].default
}
