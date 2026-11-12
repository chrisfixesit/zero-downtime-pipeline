// The one place a feature flag is declared. A flag lets unfinished work merge
// to main switched off and be released per environment without a deploy.
// Every entry names the issue it belongs to and the day it was added, so CI
// can refuse undocumented flags and a scheduled job can list stale ones.
// This file must stay import-free: scripts/delivery runs it under plain Node,
// inside the promotion gate, which is why CODEOWNERS covers this directory.
export type FlagDefinition = {
  default: boolean
  description: string
  issue: number
  addedOn: string
}

export const flagRegistry = {
  alarmDrill: {
    default: false,
    description: 'Make /drill/alarm return 500 to prove AppConfig alarm rollback',
    issue: 1,
    addedOn: '2026-11-11',
  },
} as const satisfies Record<string, FlagDefinition>

export type FlagName = keyof typeof flagRegistry

export const flagNames = Object.keys(flagRegistry) as FlagName[]

export function isFlagName(value: string): value is FlagName {
  return Object.hasOwn(flagRegistry, value)
}
