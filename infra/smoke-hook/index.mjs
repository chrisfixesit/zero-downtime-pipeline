// Lambda entry point. The SDK clients come from the Node.js runtime, so the
// function ships no node_modules.
import { CodeDeploy } from '@aws-sdk/client-codedeploy'
import { ECS } from '@aws-sdk/client-ecs'
import { makeHandler } from './smoke.mjs'

// Deployment-group name -> http://<alb-dns>:<test-port>, set by smoke-hook.tf.
const testUrls = JSON.parse(process.env.TEST_URLS ?? '{}')

const run = makeHandler({ codedeploy: new CodeDeploy({}), ecs: new ECS({}), fetchFn: fetch, testUrls })

// The context carries getRemainingTimeInMillis, which bounds the retries.
export const handler = (event, context) => run(event, context)
