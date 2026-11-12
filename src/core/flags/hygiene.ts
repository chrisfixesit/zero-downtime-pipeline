import { flagRegistry, type FlagDefinition } from './registry.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// Flags older than maxAgeDays, oldest first. A flag is meant to be removed
// once its feature is fully released, so age is the signal it was forgotten.
export function staleFlags(
  now: Date,
  maxAgeDays: number,
  registry: Record<string, FlagDefinition> = flagRegistry,
): string[] {
  return Object.entries(registry)
    .map(([name, flag]) => ({ name, added: Date.parse(`${flag.addedOn}T00:00:00Z`) }))
    .filter(({ added }) => now.getTime() - added > maxAgeDays * DAY_MS)
    .sort((a, b) => a.added - b.added)
    .map(({ name }) => name)
}
