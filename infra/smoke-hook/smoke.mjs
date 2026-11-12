// CodeDeploy AfterAllowTestTraffic hook: smoke-tests the green task set
// through the environment's test listener before any user traffic reaches it.
// Pure apart from the injected clients and fetch, so it runs under node:test;
// index.mjs wires in the real SDK clients.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Each request gets its own timeout so one hung connection cannot use up the
// Lambda's time; the handler's deadline (below) bounds the whole run.
const REQUEST_TIMEOUT_MS = 3000

// Stop retrying with this much Lambda time left, so the status report in
// makeHandler's finally always runs before the Lambda timeout does.
const RESERVE_MS = 15000

// One pass: /healthz must be 200 and / must report the release being deployed.
async function check(baseUrl, expectedVersion, fetchFn) {
  const health = await fetchFn(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (health.status !== 200) return { ok: false, reason: `/healthz returned ${health.status}` }
  const root = await fetchFn(`${baseUrl}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (root.status !== 200) return { ok: false, reason: `/ returned ${root.status}` }
  const { version } = await root.json()
  if (version !== expectedVersion) {
    return { ok: false, reason: `/ reports version ${JSON.stringify(version)}, expected ${JSON.stringify(expectedVersion)}` }
  }
  return { ok: true, reason: `healthz 200 and version ${expectedVersion}` }
}

// Node's fetch throws "fetch failed"; the useful part (ECONNREFUSED, a
// timeout) is in its cause.
function describeError(e) {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause?.code ?? e.cause?.message
  return cause ? `${e.message} (${cause})` : e.message
}

// Green may not be registered on the test listener yet when the hook fires,
// so any failure, including a refused connection, is retried until attempts
// or time run out. The last reason is the one reported.
export async function smoke({ baseUrl, expectedVersion, fetchFn = fetch, attempts = 12, delayMs = 5000, outOfTime = () => false }) {
  let last = { ok: false, reason: 'no attempts made' }
  for (let i = 1; i <= attempts; i++) {
    if (outOfTime()) return { ok: false, reason: `out of time after ${i - 1} attempts: ${last.reason}` }
    try {
      last = await check(baseUrl, expectedVersion, fetchFn)
    } catch (e) {
      last = { ok: false, reason: `request failed: ${describeError(e)}` }
    }
    if (last.ok) return last
    // No sleep once time is short: an attempt takes at most 6 s, so the
    // report always has at least 9 s.
    if (i < attempts && !outOfTime()) await sleep(delayMs)
  }
  return { ok: false, reason: `after ${attempts} attempts: ${last.reason}` }
}

// The ECS service's TaskDefinition from an AppSpecContent revision.
// GetDeployment returns only the appspec's sha256, so the content comes from
// GetApplicationRevision. Resource names are arbitrary, so take the first
// AWS::ECS::Service.
async function taskDefinitionOf(codedeploy, deploymentInfo) {
  const { revision } = await codedeploy.getApplicationRevision({
    applicationName: deploymentInfo.applicationName,
    revision: deploymentInfo.revision,
  })
  const appspec = JSON.parse(revision.appSpecContent.content)
  for (const resource of appspec.Resources ?? []) {
    for (const target of Object.values(resource)) {
      if (target?.Type === 'AWS::ECS::Service') return target.Properties.TaskDefinition
    }
  }
  throw new Error('appspec has no AWS::ECS::Service resource')
}

// Every path ends in PutLifecycleEventHookExecutionStatus. If it did not,
// CodeDeploy would wait on the hook for up to an hour.
// context is the Lambda context; it bounds the retries by the time left.
export function makeHandler({ codedeploy, ecs, fetchFn = fetch, testUrls, smokeOpts = {} }) {
  return async (event, context) => {
    const outOfTime = () => (context ? context.getRemainingTimeInMillis() < RESERVE_MS : false)
    const deploymentId = event.DeploymentId
    let result = { ok: false, reason: 'not checked' }
    let group = null
    try {
      const { deploymentInfo } = await codedeploy.getDeployment({ deploymentId })
      group = deploymentInfo.deploymentGroupName
      const baseUrl = testUrls[group]
      if (!baseUrl) throw new Error(`no test URL for deployment group ${group}`)
      const { taskDefinition } = await ecs.describeTaskDefinition({ taskDefinition: await taskDefinitionOf(codedeploy, deploymentInfo) })
      const app = taskDefinition.containerDefinitions.find((c) => c.name === 'app')
      const expectedVersion = app?.environment?.find((e) => e.name === 'VERSION')?.value
      if (!expectedVersion) throw new Error('the app container sets no VERSION')
      result = await smoke({ ...smokeOpts, baseUrl, expectedVersion, fetchFn, outOfTime })
    } catch (e) {
      result = { ok: false, reason: describeError(e) }
    } finally {
      const status = result.ok ? 'Succeeded' : 'Failed'
      console.log(JSON.stringify({ deploymentId, deploymentGroup: group, status, reason: result.reason }))
      await codedeploy.putLifecycleEventHookExecutionStatus({
        deploymentId,
        lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
        status,
      })
    }
  }
}
