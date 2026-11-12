import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/delivery/cli.ts')

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-cli-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.test')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  return { dir, git, base: git('rev-parse', 'HEAD') }
}

// stdout is the command's machine-readable output (workflows redirect it into
// files and $GITHUB_OUTPUT); refusals go to stderr so they stay visible even
// when stdout is redirected, and GitHub still turns ::error:: into an annotation.
function cli(dir: string, ...args: string[]) {
  const r = spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('delivery cli', () => {
  it('classify: a code-only change', () => {
    const { dir, git, base } = repo()
    writeFileSync(join(dir, 'a.ts'), 'x\n')
    git('add', '.')
    git('commit', '-qm', 'code')
    assert.equal(cli(dir, 'classify', base, 'HEAD').out, 'code=true\ndeploy=false\n')
  })

  it('classify: a deploy-only change skips the code jobs', () => {
    const { dir, git, base } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/prod.json'), '{}\n')
    git('add', '.')
    git('commit', '-qm', 'promote')
    assert.equal(cli(dir, 'classify', base, 'HEAD').out, 'code=false\ndeploy=true\n')
  })

  it('classify: an unknown base runs everything', () => {
    const { dir } = repo()
    assert.equal(cli(dir, 'classify', '0000000000000000000000000000000000000000', 'HEAD').out, 'code=true\ndeploy=false\n')
  })

  it('check-pr: passes straight away when nothing under deploy/ changed', () => {
    const { dir, git, base } = repo()
    writeFileSync(join(dir, 'a.ts'), 'x\n')
    git('add', '.')
    git('commit', '-qm', 'code')
    const result = cli(dir, 'check-pr', base, 'HEAD')
    assert.equal(result.code, 0)
    assert.ok(result.out.includes('No promotion in this change'))
  })

  it('check-pr: refuses a PR that mixes deploy files with code', () => {
    const { dir, git, base } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/prod.json'), '{}\n')
    writeFileSync(join(dir, 'a.ts'), 'x\n')
    git('add', '.')
    git('commit', '-qm', 'mixed')
    const result = cli(dir, 'check-pr', base, 'HEAD')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('::error::'))
    assert.ok(result.err.includes('may only change deploy/ files'))
    assert.ok(!result.out.includes('may only change deploy/ files'))
  })

  it('check-pr: refuses stray files under deploy/', () => {
    const { dir, git, base } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/sandbox.json'), '{}\n')
    git('add', '.')
    git('commit', '-qm', 'stray')
    const result = cli(dir, 'check-pr', base, 'HEAD')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('deploy/sandbox.json'))
    assert.equal(result.out, '')
  })

  it('check-pr: refuses a malformed deploy file before any AWS call', () => {
    const { dir, git, base } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/prod.json'), '{"sha":"nope"}\n')
    git('add', '.')
    git('commit', '-qm', 'bad')
    const result = cli(dir, 'check-pr', base, 'HEAD')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('::error::'))
    assert.ok(result.err.includes('sha must be 40 lowercase hex characters'))
    assert.ok(!result.out.includes('sha must be 40 lowercase hex characters'))
  })

  it('check-pr: refuses deleting a deploy file', () => {
    const { dir, git } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/prod.json'), '{}\n')
    git('add', '.')
    git('commit', '-qm', 'add')
    const withFile = git('rev-parse', 'HEAD')
    git('rm', '-q', 'deploy/prod.json')
    git('commit', '-qm', 'delete')
    const result = cli(dir, 'check-pr', withFile, 'HEAD')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('::error::'))
    assert.ok(result.err.includes('deploy/prod.json was deleted'))
    assert.ok(!result.out.includes('deploy/prod.json was deleted'))
  })

  it('envs-changed: lists only the environments whose file changed', () => {
    const { dir, git, base } = repo()
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy/staging.json'), '{}\n')
    git('add', '.')
    git('commit', '-qm', 'promote staging')
    assert.equal(cli(dir, 'envs-changed', base, 'HEAD').out.trim(), '["staging"]')
  })

  it('flag-config: refuses a flag the running release does not declare', () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'current.json'), '{}')
    writeFileSync(join(dir, 'release-flags.json'), JSON.stringify({ alarmDrill: { default: false, description: 'd' } }))
    const result = cli(dir, 'flag-config', 'madeUp', 'on', 'current.json', 'release-flags.json')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('::error::'))
    assert.ok(result.err.includes('"madeUp" is not declared by the release running in this environment'))
    assert.equal(result.out, '')
  })

  it('flag-config: refuses when the running release is unreadable', () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'current.json'), '{}')
    const result = cli(dir, 'flag-config', 'alarmDrill', 'on', 'current.json', 'missing.json')
    assert.equal(result.code, 1)
    assert.ok(result.err.includes('cannot read the running release\'s flags'))
  })

  it('flag-config: writes the document for a flag the running release declares', () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'current.json'), '{}')
    writeFileSync(join(dir, 'release-flags.json'), JSON.stringify({ alarmDrill: { default: false, description: 'd' } }))
    const result = cli(dir, 'flag-config', 'alarmDrill', 'on', 'current.json', 'release-flags.json')
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.out).values.alarmDrill, { enabled: true })
  })
})
