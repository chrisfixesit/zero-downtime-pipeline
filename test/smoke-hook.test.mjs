import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeHandler, smoke } from '../infra/smoke-hook/smoke.mjs'

const BASE = 'http://alb.example:9081'
const TASK_DEF = 'arn:aws:ecs:us-east-1:111111111111:task-definition/zdp-sandbox-app:7'

// A fetch stub that answers /healthz and / from the given handlers.
function fakeFetch({ healthz = () => ({ status: 200, body: { status: 'ok' } }), root }) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    const path = new URL(url).pathname
    const answer = path === '/healthz' ? healthz() : root()
    if (answer instanceof Error) throw answer
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => answer.body }
  }
  fn.calls = calls
  return fn
}

const answersWith = (version) => fakeFetch({ root: () => ({ status: 200, body: { version } }) })

test('smoke passes when healthz is 200 and / reports the expected version', async () => {
  const result = await smoke({ baseUrl: BASE, expectedVersion: 'abc123', fetchFn: answersWith('abc123'), delayMs: 0 })
  assert.equal(result.ok, true)
})

test('smoke fails naming the version it saw', async () => {
  const result = await smoke({ baseUrl: BASE, expectedVersion: 'abc123', fetchFn: answersWith('old999'), attempts: 2, delayMs: 0 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /old999/)
  assert.match(result.reason, /abc123/)
})

test('smoke retries until the release answers', async () => {
  let n = 0
  const fetchFn = fakeFetch({
    healthz: () => (++n <= 2 ? new Error('ECONNREFUSED') : { status: 200, body: { status: 'ok' } }),
    root: () => ({ status: 200, body: { version: 'abc123' } }),
  })
  const result = await smoke({ baseUrl: BASE, expectedVersion: 'abc123', fetchFn, delayMs: 0 })
  assert.equal(result.ok, true)
  assert.equal(n, 3)
})

// Stub CodeDeploy and ECS clients, recording the status the handler reports.
function stubs({ describeTaskDefinition }) {
  const reported = []
  const codedeploy = {
    getDeployment: async ({ deploymentId }) => ({
      deploymentInfo: {
        deploymentId,
        deploymentGroupName: 'zdp-sandbox',
        revision: {
          revisionType: 'AppSpecContent',
          appSpecContent: {
            content: JSON.stringify({
              version: 0.0,
              Resources: [{ TargetService: { Type: 'AWS::ECS::Service', Properties: { TaskDefinition: TASK_DEF } } }],
            }),
          },
        },
      },
    }),
    putLifecycleEventHookExecutionStatus: async (params) => {
      reported.push(params)
      return {}
    },
  }
  return { codedeploy, ecs: { describeTaskDefinition }, reported }
}

const event = { DeploymentId: 'd-TEST', LifecycleEventHookExecutionId: 'hook-1' }

test('handler reports Succeeded for a healthy release', async () => {
  let askedFor
  const { codedeploy, ecs, reported } = stubs({
    describeTaskDefinition: async ({ taskDefinition }) => {
      askedFor = taskDefinition
      return {
        taskDefinition: {
          containerDefinitions: [
            { name: 'appconfig-agent', environment: [] },
            { name: 'app', environment: [{ name: 'PORT', value: '8080' }, { name: 'VERSION', value: 'abc123' }] },
          ],
        },
      }
    },
  })
  const fetchFn = answersWith('abc123')
  const handler = makeHandler({ codedeploy, ecs, fetchFn, testUrls: { 'zdp-sandbox': BASE }, smokeOpts: { delayMs: 0 } })
  await handler(event)
  assert.equal(askedFor, TASK_DEF)
  assert.ok(fetchFn.calls.every((u) => u.startsWith(BASE)))
  assert.deepEqual(reported, [{ deploymentId: 'd-TEST', lifecycleEventHookExecutionId: 'hook-1', status: 'Succeeded' }])
})

test('handler reports Failed when the task definition lookup throws', async () => {
  const { codedeploy, ecs, reported } = stubs({
    describeTaskDefinition: async () => {
      throw new Error('AccessDenied')
    },
  })
  const handler = makeHandler({ codedeploy, ecs, fetchFn: answersWith('abc123'), testUrls: { 'zdp-sandbox': BASE }, smokeOpts: { delayMs: 0 } })
  await handler(event)
  assert.deepEqual(reported, [{ deploymentId: 'd-TEST', lifecycleEventHookExecutionId: 'hook-1', status: 'Failed' }])
})
