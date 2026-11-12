// Pure delivery rules for zero-downtime-pipeline: what a release is, which releases an
// environment may receive, and how promotion PRs and flag configs are written.
// No I/O here; cli.ts does the git and AWS calls. Runs under plain Node 26, so
// only built-ins and explicit .ts imports.
import { flagNames, flagRegistry, isFlagName } from '../../src/core/flags/registry.ts'

export type Env = 'sandbox' | 'staging' | 'prod'
export type GatedEnv = 'staging' | 'prod'
export const GATED_ENVS: GatedEnv[] = ['staging', 'prod']

// Add a component here and Digests, parsing, comparison and the PR table follow.
export const COMPONENTS = ['app'] as const
export type Component = (typeof COMPONENTS)[number]
export type Digests = Record<Component, string>
export type Release = { sha: string; digests: Digests }

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

export function parseRelease(raw: unknown): Release {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('release must be a JSON object')
  }
  const { sha, digests } = raw as Record<string, unknown>
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    throw new Error('sha must be 40 lowercase hex characters')
  }
  if (typeof digests !== 'object' || digests === null) {
    throw new Error('digests must be an object')
  }
  const d = digests as Record<string, unknown>
  for (const c of COMPONENTS) {
    if (typeof d[c] !== 'string' || !DIGEST.test(d[c] as string)) {
      throw new Error(`digests.${c} must be sha256:<64 lowercase hex>`)
    }
  }
  return { sha, digests: Object.fromEntries(COMPONENTS.map((c) => [c, d[c] as string])) as Digests }
}

export function previousStage(env: GatedEnv): Env {
  return env === 'staging' ? 'sandbox' : 'staging'
}

export function sameRelease(a: Release, b: Release): boolean {
  return a.sha === b.sha && COMPONENTS.every((c) => a.digests[c] === b.digests[c])
}

// The single allow-list predicate (spec, Component 3). A release may go to an
// environment only if it already ran, with identical digests, in the stage
// before it (a promotion) or in that environment itself (a rollback).
export function isAllowed(
  target: GatedEnv,
  requested: Release,
  history: { own: Release[]; previous: Release[] },
): boolean {
  void target
  return [...history.previous, ...history.own].some((r) => sameRelease(r, requested))
}

export function classifyPaths(paths: string[]): {
  deployEnvs: GatedEnv[]
  strayDeployPaths: string[]
  otherPaths: string[]
} {
  const unique = [...new Set(paths)].sort()
  const deployEnvs = GATED_ENVS.filter((env) => unique.includes(`deploy/${env}.json`))
  const strayDeployPaths = unique.filter(
    (p) => p.startsWith('deploy/') && !GATED_ENVS.some((env) => p === `deploy/${env}.json`),
  )
  const otherPaths = unique.filter((p) => !p.startsWith('deploy/'))
  return { deployEnvs, strayDeployPaths, otherPaths }
}

export function renderReleaseFile(release: Release): string {
  const { sha, digests } = release
  const ordered = Object.fromEntries(COMPONENTS.map((c) => [c, digests[c]]))
  return `${JSON.stringify({ sha, digests: ordered }, null, 2)}\n`
}

const short = (sha: string) => sha.slice(0, 7)

export function releaseBranch(kind: 'promote' | 'rollback', env: GatedEnv, release: Release, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '')
  return `${kind}/${env}-${short(release.sha)}-${stamp}`
}

export function renderPrText(args: {
  kind: 'promote' | 'rollback'
  env: GatedEnv
  from: Release | null
  to: Release
  repoUrl: string
}): { title: string; body: string } {
  const { kind, env, from, to, repoUrl } = args
  const title = kind === 'promote' ? `Promote ${short(to.sha)} to ${env}` : `Roll back ${env} to ${short(to.sha)}`
  const range = from
    ? `Changes: ${repoUrl}/compare/${short(from.sha)}...${short(to.sha)}`
    : `This is the first release to ${env}.`
  const body = [
    `This PR asks to run \`${short(to.sha)}\` in **${env}**. Merging it deploys exactly these digests; nothing is resolved at deploy time.`,
    '',
    range,
    '',
    '| Image | Digest |',
    '|---|---|',
    ...COMPONENTS.map((c) => `| ${c} | \`${to.digests[c]}\` |`),
    '',
    '`promotion-check` confirms these digests already ran in the previous stage (or, for a rollback, in this environment). CodeDeploy smoke-tests the release on the test listener before any traffic moves.',
  ].join('\n')
  return { title, body }
}

// The flags a release declares, read from its own src/core/flags/registry.ts.
export type ReleaseFlags = Record<string, { default: boolean; description: string }>

// AWS.AppConfig.FeatureFlags document for one environment, with one flag
// changed. The flag must be declared by the release running there, not just by
// main: a flag added on main is not read until its code is promoted. The
// document keeps every flag that main or the running release declares, so a
// flag retired on main keeps its value while an older release still reads it.
// Definitions come from main where it has them, else from the release; values
// carry over from what is deployed now.
export function buildFlagConfig(current: unknown, flag: string, enabled: boolean, release: ReleaseFlags): object {
  if (!Object.hasOwn(release, flag)) {
    throw new Error(`"${flag}" is not declared by the release running in this environment`)
  }
  const currentValues = readValues(current)
  const flags: Record<string, { name: string; description: string }> = {}
  const values: Record<string, { enabled: boolean }> = {}
  for (const name of new Set([...flagNames, ...Object.keys(release)])) {
    const def = isFlagName(name) ? flagRegistry[name] : release[name]
    flags[name] = { name, description: def?.description ?? '' }
    values[name] = { enabled: currentValues[name] ?? def?.default ?? false }
  }
  values[flag] = { enabled }
  return { version: '1', flags, values }
}

// Accepts either the stored document ({ values: {...} }) or the evaluated
// shape the agent serves ({ name: { enabled } }).
function readValues(current: unknown): Record<string, boolean> {
  if (typeof current !== 'object' || current === null) return {}
  const source = (current as Record<string, unknown>).values ?? current
  const out: Record<string, boolean> = {}
  for (const [name, entry] of Object.entries(source as Record<string, unknown>)) {
    const value = (entry as { enabled?: unknown } | null)?.enabled
    if (typeof value === 'boolean') out[name] = value
  }
  return out
}

export type RunningApp =
  | { kind: 'digest'; digest: string }
  | { kind: 'placeholder'; image: string }

// What the hourly drift check reports for one environment. last-good is the
// truth; the deploy file is only intent. An image running with no last-good
// at all is drift too: it means a deploy got that far and then failed.
export function driftProblems(
  env: Env,
  state: { file: Release | null; pointer: Release | null; running: RunningApp },
): string[] {
  const { file, pointer, running } = state
  const problems: string[] = []
  if (!pointer) {
    if (running.kind === 'digest') problems.push(`${env}: running ${running.digest} but no last-good is recorded`)
    if (file) problems.push(`${env}: deploy/${env}.json asks for ${short(file.sha)} but no last-good is recorded`)
    return problems
  }
  const runningLabel = running.kind === 'digest' ? running.digest : running.image
  if (running.kind !== 'digest' || running.digest !== pointer.digests.app) {
    problems.push(`${env}: running app ${runningLabel} is not last-good ${pointer.digests.app}`)
  }
  if (file && !sameRelease(file, pointer)) {
    problems.push(`${env}: deploy/${env}.json asks for ${short(file.sha)} but ${short(pointer.sha)} is running`)
  }
  return problems
}

// Under the CODE_DEPLOY controller the service-level taskDefinition may not
// track what is running; the PRIMARY task set is the one serving traffic.
export function runningTaskDefinition(service: {
  taskDefinition?: string
  taskSets?: { status: string; taskDefinition: string }[]
}): string | undefined {
  const primary = service.taskSets?.find((t) => t.status === 'PRIMARY')
  return primary?.taskDefinition ?? service.taskDefinition
}
