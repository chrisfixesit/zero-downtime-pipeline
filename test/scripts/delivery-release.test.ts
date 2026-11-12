import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { flagNames, flagRegistry } from '../../src/core/flags/registry.ts'
import {
  buildFlagConfig,
  classifyPaths,
  driftProblems,
  isAllowed,
  parseRelease,
  previousStage,
  releaseBranch,
  renderPrText,
  renderReleaseFile,
  sameRelease,
  type Release,
} from '../../scripts/delivery/release.ts'

const hex = (c: string, n: number) => c.repeat(n)
const release = (c: string): Release => ({
  sha: hex(c, 40),
  digests: { app: `sha256:${hex(c, 64)}` },
})
const A = release('a')
const B = release('b')
const D = release('d')

describe('parseRelease', () => {
  it('accepts a well-formed release and ignores pointer extras', () => {
    assert.deepEqual(parseRelease({ ...A, deployedAt: '2026-10-09T00:00:00Z', runUrl: 'x' }), A)
  })

  const cases: [string, unknown, string | RegExp][] = [
    ['not an object', 'nope', 'release must be a JSON object'],
    ['short sha', { ...A, sha: 'abc' }, 'sha must be 40 lowercase hex characters'],
    ['uppercase sha', { ...A, sha: hex('A', 40) }, 'sha must be 40 lowercase hex characters'],
    ['missing digests', { sha: A.sha }, 'digests must be an object'],
    ['tag instead of digest', { ...A, digests: { app: 'latest' } }, 'digests.app must be sha256:<64 lowercase hex>'],
  ]
  for (const [label, raw, message] of cases) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseRelease(raw), typeof message === 'string' ? { message } : message)
    })
  }

  it('refuses a release without digests.app', () => {
    assert.throws(() => parseRelease({ sha: hex('a', 40), digests: {} }), /digests\.app/)
  })
})

describe('previousStage', () => {
  it('orders sandbox, staging, prod', () => {
    assert.equal(previousStage('staging'), 'sandbox')
    assert.equal(previousStage('prod'), 'staging')
  })
})

describe('isAllowed', () => {
  it('allows a promotion of something that ran in the previous stage', () => {
    assert.equal(isAllowed('prod', B, { own: [A], previous: [A, B] }), true)
  })

  it('allows a rollback to something that ran in the same environment', () => {
    assert.equal(isAllowed('prod', A, { own: [A, B], previous: [B] }), true)
  })

  it('refuses something that never ran in either', () => {
    assert.equal(isAllowed('prod', D, { own: [A], previous: [B] }), false)
  })

  it('refuses a known sha whose digests were swapped', () => {
    const forged = { ...B, digests: { ...B.digests, app: D.digests.app } }
    assert.equal(isAllowed('prod', forged, { own: [], previous: [B] }), false)
  })

  it('refuses everything when there is no history at all', () => {
    assert.equal(isAllowed('staging', A, { own: [], previous: [] }), false)
  })
})

describe('sameRelease', () => {
  it('compares sha and every component', () => {
    assert.equal(sameRelease(A, structuredClone(A)), true)
    assert.equal(sameRelease(A, { ...A, digests: { app: B.digests.app } }), false)
    assert.equal(sameRelease(A, { ...A, sha: B.sha }), false)
  })
})

describe('classifyPaths', () => {
  it('finds promotion files', () => {
    assert.deepEqual(classifyPaths(['deploy/prod.json']), { deployEnvs: ['prod'], strayDeployPaths: [], otherPaths: [] })
  })

  it('flags anything else under deploy/ as stray', () => {
    assert.deepEqual(classifyPaths(['deploy/sandbox.json', 'deploy/notes.md']).strayDeployPaths, [
      'deploy/notes.md',
      'deploy/sandbox.json',
    ])
  })

  it('separates code paths, sorted and de-duplicated', () => {
    assert.deepEqual(classifyPaths(['src/b.ts', 'deploy/staging.json', 'src/a.ts', 'src/a.ts']), {
      deployEnvs: ['staging'],
      strayDeployPaths: [],
      otherPaths: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('does not treat a deploy prefix outside the directory as a deploy path', () => {
    assert.deepEqual(classifyPaths(['deployment.md']).otherPaths, ['deployment.md'])
  })
})

describe('renderReleaseFile', () => {
  it('writes stable, newline-terminated JSON in a fixed key order', () => {
    const text = renderReleaseFile({ digests: { app: A.digests.app }, sha: A.sha })
    assert.equal(text.endsWith('\n'), true)
    assert.deepEqual(Object.keys(JSON.parse(text)), ['sha', 'digests'])
    assert.deepEqual(Object.keys(JSON.parse(text).digests), ['app'])
  })
})

describe('releaseBranch', () => {
  it('is unique per minute and readable', () => {
    assert.equal(
      releaseBranch('promote', 'prod', A, new Date('2026-10-09T14:05:00Z')),
      'promote/prod-aaaaaaa-20261009T1405',
    )
  })
})

describe('renderPrText', () => {
  it('shows the range and the digests before anyone approves', () => {
    const { title, body } = renderPrText({ kind: 'promote', env: 'prod', from: A, to: B, repoUrl: 'https://github.com/o/r' })
    assert.equal(title, 'Promote bbbbbbb to prod')
    assert.match(body, /https:\/\/github\.com\/o\/r\/compare\/aaaaaaa\.\.\.bbbbbbb/)
    assert.ok(body.includes(B.digests.app))
    assert.ok(body.endsWith('CodeDeploy smoke-tests the release on the test listener before any traffic moves.'))
  })

  it('handles a first deploy with no previous release', () => {
    const { body } = renderPrText({ kind: 'promote', env: 'staging', from: null, to: A, repoUrl: 'https://github.com/o/r' })
    assert.ok(body.includes('first release to staging'))
  })

  it('labels rollbacks', () => {
    assert.equal(renderPrText({ kind: 'rollback', env: 'prod', from: B, to: A, repoUrl: 'u' }).title, 'Roll back prod to aaaaaaa')
  })
})

describe('buildFlagConfig', () => {
  type Config = {
    version: string
    flags: Record<string, { name: string; description: string }>
    values: Record<string, { enabled: boolean }>
  }
  const flag = (description: string) => ({ default: false, description })
  // The flags declared by the release running in the target environment. Most
  // tests run the same code as main; the rest model prod lagging behind.
  const sameAsMain = flagRegistry
  const withExtra = { ...flagRegistry, releaseOnly: flag('Declared by the running release only') }

  it('defines every registry flag and keeps current values', () => {
    const config = buildFlagConfig({ releaseOnly: { enabled: true } }, 'alarmDrill', true, withExtra) as Config
    assert.equal(config.version, '1')
    assert.deepEqual(Object.keys(config.flags).sort(), [...flagNames, 'releaseOnly'].sort())
    assert.deepEqual(config.values, {
      ...Object.fromEntries(flagNames.map((name) => [name, { enabled: (name as string) === 'alarmDrill' ? true : flagRegistry[name].default }])),
      releaseOnly: { enabled: true },
    })
  })

  it('accepts the stored AppConfig document shape as current state', () => {
    const stored = { version: '1', flags: {}, values: { releaseOnly: { enabled: true } } }
    const config = buildFlagConfig(stored, 'alarmDrill', false, withExtra) as Config
    assert.equal(config.values.releaseOnly?.enabled, true)
  })

  it('keeps a flag retired on main while the running release still declares it', () => {
    const prodRelease = { ...flagRegistry, retiredFlag: flag('Finished feature, removed on main') }
    const config = buildFlagConfig({ retiredFlag: { enabled: true } }, 'alarmDrill', true, prodRelease) as Config
    assert.deepEqual(config.values.retiredFlag, { enabled: true })
    assert.equal(config.flags.retiredFlag?.description, 'Finished feature, removed on main')
  })

  it('can still turn off a flag retired on main that the running release reads', () => {
    const prodRelease = { ...flagRegistry, retiredFlag: flag('Finished feature, removed on main') }
    const config = buildFlagConfig({ retiredFlag: { enabled: true } }, 'retiredFlag', false, prodRelease) as Config
    assert.deepEqual(config.values.retiredFlag, { enabled: false })
  })

  it('drops a flag that neither main nor the running release declares', () => {
    const config = buildFlagConfig({ removedFlag: { enabled: true } }, 'alarmDrill', false, sameAsMain) as Config
    assert.equal(Object.hasOwn(config.values, 'removedFlag'), false)
  })

  it('refuses a flag the running release does not declare, even though main does', () => {
    const { alarmDrill: _notYetReleased, ...olderRelease } = flagRegistry
    assert.throws(() => buildFlagConfig({}, 'alarmDrill', true, olderRelease), {
      message: '"alarmDrill" is not declared by the release running in this environment',
    })
  })

  it('refuses a flag that is not declared anywhere', () => {
    assert.throws(() => buildFlagConfig({}, 'madeUp', true, sameAsMain), {
      message: '"madeUp" is not declared by the release running in this environment',
    })
  })
})

describe('driftProblems', () => {
  const placeholder = { kind: 'placeholder', image: 'public.ecr.aws/docker/library/busybox:stable' } as const
  const digest = (d: string) => ({ kind: 'digest', digest: d }) as const

  it('is quiet before anything has been deployed', () => {
    assert.deepEqual(driftProblems('sandbox', { file: null, pointer: null, running: placeholder }), [])
  })

  it('flags a deployed image with no last-good record', () => {
    assert.deepEqual(driftProblems('sandbox', { file: null, pointer: null, running: digest(A.digests.app) }), [
      `sandbox: running ${A.digests.app} but no last-good is recorded`,
    ])
  })

  it('flags a deploy file with no last-good record', () => {
    assert.deepEqual(driftProblems('prod', { file: B, pointer: null, running: placeholder }), [
      'prod: deploy/prod.json asks for bbbbbbb but no last-good is recorded',
    ])
  })

  it('is quiet when the running image is last-good and the file agrees', () => {
    assert.deepEqual(driftProblems('prod', { file: A, pointer: A, running: digest(A.digests.app) }), [])
  })

  it('flags a running image that is not last-good', () => {
    assert.deepEqual(driftProblems('sandbox', { file: null, pointer: A, running: digest(B.digests.app) }), [
      `sandbox: running app ${B.digests.app} is not last-good ${A.digests.app}`,
    ])
  })

  it('flags a placeholder still running after a recorded deploy', () => {
    assert.deepEqual(driftProblems('sandbox', { file: null, pointer: A, running: placeholder }), [
      `sandbox: running app ${placeholder.image} is not last-good ${A.digests.app}`,
    ])
  })

  it('flags a deploy file that disagrees with last-good', () => {
    assert.deepEqual(driftProblems('prod', { file: B, pointer: A, running: digest(A.digests.app) }), [
      'prod: deploy/prod.json asks for bbbbbbb but aaaaaaa is running',
    ])
  })
})
