// I/O shell around release.ts for the trunk-based delivery workflows. Every command
// prints machine-readable output on stdout and, on failure, one ::error::
// line (rendered by GitHub Actions) before exiting 1.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  GATED_ENVS,
  buildFlagConfig,
  driftProblems,
  classifyPaths,
  isAllowed,
  parseRelease,
  previousStage,
  releaseBranch,
  renderPrText,
  renderReleaseFile,
  sameRelease,
  type Env,
  type GatedEnv,
  type Release,
  type ReleaseFlags,
  type RunningApp,
} from './release.ts'
import { staleFlags } from '../../src/core/flags/hygiene.ts'

class Refusal extends Error {}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const aws = (...args: string[]) =>
  execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const isZero = (sha: string | undefined) => !sha || /^0+$/.test(sha)

function changedPaths(base: string, head: string): string[] {
  const from = git('merge-base', base, head)
  const out = git('diff', '--name-only', from, head)
  return out ? out.split('\n') : []
}

function fileAt(ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function releaseAt(ref: string, env: GatedEnv): Release {
  const text = fileAt(ref, `deploy/${env}.json`)
  if (text === null) throw new Refusal(`deploy/${env}.json was deleted; promotions may only change it`)
  try {
    return parseRelease(JSON.parse(text))
  } catch (e) {
    throw new Refusal(`deploy/${env}.json: ${(e as Error).message}`)
  }
}

// Newest last. Unparsable entries are skipped: they cannot match a request.
function pointerHistory(env: Env): Release[] {
  try {
    const { Parameters } = JSON.parse(aws('ssm', 'get-parameter-history', '--name', `/zdp/${env}/last-good`)) as {
      Parameters: { Value: string }[]
    }
    return Parameters.flatMap((p) => {
      try {
        return [parseRelease(JSON.parse(p.Value))]
      } catch {
        return []
      }
    })
  } catch (e) {
    if (String((e as { stderr?: string }).stderr ?? '').includes('ParameterNotFound')) return []
    throw e
  }
}

const current = (env: Env): Release | null => pointerHistory(env).at(-1) ?? null

function asGated(value: string | undefined): GatedEnv {
  if (value === 'staging' || value === 'prod') return value
  throw new Refusal(`environment must be staging or prod, got "${value}"`)
}

function prPayload(kind: 'promote' | 'rollback', env: GatedEnv, to: Release) {
  const from = current(env)
  const repoUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? ''}`
  const { title, body } = renderPrText({ kind, env, from, to, repoUrl })
  return {
    env,
    branch: releaseBranch(kind, env, to, new Date()),
    file: `deploy/${env}.json`,
    fileContent: renderReleaseFile(to),
    title,
    body,
  }
}

// Every command's arguments, checked for count at dispatch so each command
// can treat them as present.
type Args = [string, string, string, string]

const ARITY: Record<string, number> = {
  classify: 2,
  'check-pr': 2,
  'envs-changed': 2,
  verify: 2,
  promotion: 1,
  rollback: 2,
  'resolve-own': 2,
  drift: 1,
  'stale-flags': 1,
  'flag-config': 4,
}

const commands: Record<string, (args: Args) => void> = {
  classify([base, head]) {
    if (isZero(base)) {
      console.log('code=true\ndeploy=false')
      return
    }
    const { deployEnvs, strayDeployPaths, otherPaths } = classifyPaths(changedPaths(base, head))
    const deploy = deployEnvs.length > 0 || strayDeployPaths.length > 0
    console.log(`code=${otherPaths.length > 0 || !deploy}\ndeploy=${deploy}`)
  },

  'check-pr'([base, head]) {
    const { deployEnvs, strayDeployPaths, otherPaths } = classifyPaths(changedPaths(base, head))
    if (deployEnvs.length === 0 && strayDeployPaths.length === 0) {
      console.log('No promotion in this change.')
      return
    }
    if (strayDeployPaths.length) {
      throw new Refusal(`only deploy/staging.json and deploy/prod.json may exist under deploy/, found: ${strayDeployPaths.join(', ')}`)
    }
    if (otherPaths.length) {
      throw new Refusal(`a promotion PR may only change deploy/ files; also changed: ${otherPaths.join(', ')}`)
    }
    const requested = deployEnvs.map((env) => ({ env, release: releaseAt(head, env) }))
    for (const { env, release } of requested) {
      const history = { own: pointerHistory(env), previous: pointerHistory(previousStage(env)) }
      if (!isAllowed(env, release, history)) {
        throw new Refusal(`${release.sha.slice(0, 7)} never ran in ${previousStage(env)} or ${env} with these digests`)
      }
      console.log(`deploy/${env}.json: ${release.sha.slice(0, 7)} is allowed`)
    }
  },

  'envs-changed'([before, after]) {
    if (isZero(before)) {
      console.log(JSON.stringify(GATED_ENVS.filter((env) => fileAt(after, `deploy/${env}.json`) !== null)))
      return
    }
    console.log(JSON.stringify(classifyPaths(changedPaths(before, after)).deployEnvs))
  },

  verify([envArg, ref]) {
    const env = asGated(envArg)
    const release = releaseAt(ref, env)
    const own = pointerHistory(env)
    if (!isAllowed(env, release, { own, previous: pointerHistory(previousStage(env)) })) {
      throw new Refusal(`deploy/${env}.json at ${ref.slice(0, 7)} names a release that never ran in ${previousStage(env)} or ${env}`)
    }
    const latest = own.at(-1)
    console.log(`release=${JSON.stringify(release)}`)
    console.log(`noop=${latest !== undefined && sameRelease(latest, release)}`)
  },

  promotion([envArg]) {
    const env = asGated(envArg)
    const source = current(previousStage(env))
    if (!source) throw new Refusal(`${previousStage(env)} has no last-good release to promote`)
    console.log(JSON.stringify(prPayload('promote', env, source)))
  },

  rollback([envArg, sha]) {
    const env = asGated(envArg)
    const match = pointerHistory(env).filter((r) => r.sha === sha).at(-1)
    if (!match) throw new Refusal(`${sha} has never run in ${env}; a rollback can only return to an earlier ${env} release`)
    console.log(JSON.stringify(prPayload('rollback', env, match)))
  },

  'resolve-own'([env, sha]) {
    const match = pointerHistory(env as Env).filter((r) => r.sha === sha).at(-1)
    if (!match) throw new Refusal(`${sha} has never run in ${env}`)
    console.log(`release=${JSON.stringify(match)}`)
  },

  drift([env]) {
    const get = (name: string) =>
      (JSON.parse(aws('ssm', 'get-parameter', '--name', `/zdp/${env}/${name}`)) as { Parameter: { Value: string } }).Parameter.Value
    const pointer = current(env as Env)
    const file = env === 'sandbox' ? null : (() => {
      const text = fileAt('HEAD', `deploy/${env}.json`)
      return text ? parseRelease(JSON.parse(text)) : null
    })()
    const service = JSON.parse(aws('ecs', 'describe-services', '--cluster', get('cluster'), '--services', get('app-service'))) as {
      services: { taskDefinition: string }[]
    }
    const svc = service.services[0]
    if (!svc) throw new Refusal(`${env}: app service not found`)
    const taskDef = JSON.parse(aws('ecs', 'describe-task-definition', '--task-definition', svc.taskDefinition)) as {
      taskDefinition: { containerDefinitions: { name: string; image: string }[] }
    }
    const image = taskDef.taskDefinition.containerDefinitions.find((c) => c.name === 'app')?.image ?? ''
    const digest = image.includes('@') ? image.split('@')[1] : undefined
    const running: RunningApp = digest ? { kind: 'digest', digest } : { kind: 'placeholder', image }
    const rows = [
      ['deploy file (intent)', file ? `${file.sha.slice(0, 7)} ${file.digests.app}` : '(none)'],
      ['last-good (truth)', pointer ? `${pointer.sha.slice(0, 7)} ${pointer.digests.app}` : '(none)'],
      ['running app image', running.kind === 'digest' ? running.digest : `(not a digest: ${image})`],
    ]
    console.log(`### ${env}\n\n| Source | Release |\n|---|---|\n${rows.map((r) => `| ${r[0]} | \`${r[1]}\` |`).join('\n')}\n`)
    const problems = driftProblems(env as Env, { file, pointer, running })
    if (problems.length) throw new Refusal(problems.join('; '))
  },

  'stale-flags'([days]) {
    const stale = staleFlags(new Date(), Number(days))
    console.log(stale.length ? stale.join('\n') : 'none')
  },

  'flag-config'([flag, state, currentPath, releaseFlagsPath]) {
    if (state !== 'on' && state !== 'off') throw new Refusal(`state must be on or off, got "${state}"`)
    let currentDoc: unknown
    try {
      currentDoc = JSON.parse(readFileSync(currentPath, 'utf8'))
    } catch {
      currentDoc = {}
    }
    let release: ReleaseFlags
    try {
      release = JSON.parse(readFileSync(releaseFlagsPath, 'utf8')) as ReleaseFlags
    } catch (e) {
      throw new Refusal(`cannot read the running release's flags from ${releaseFlagsPath}: ${(e as Error).message}`)
    }
    try {
      console.log(JSON.stringify(buildFlagConfig(currentDoc, flag, state === 'on', release)))
    } catch (e) {
      throw new Refusal((e as Error).message)
    }
  },
}

const [command, ...args] = process.argv.slice(2)
try {
  const run = commands[command ?? '']
  if (!run) throw new Refusal(`unknown command "${command}"; expected one of ${Object.keys(commands).join(', ')}`)
  const needed = ARITY[command ?? ''] ?? 0
  if (args.length < needed) throw new Refusal(`${command} needs ${needed} argument(s), got ${args.length}`)
  run(args as Args)
} catch (e) {
  // stderr, not stdout: workflows redirect stdout into files and
  // $GITHUB_OUTPUT, which would swallow the reason. GitHub still turns
  // ::error:: on stderr into an annotation.
  console.error(`::error::${(e as Error).message}`)
  process.exit(1)
}
