# Trunk-Based Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into a copyable template with CAMS's trunk-based release flow (sandbox → staging → prod, digest-pinned promotion PRs, last-good, rollback, drift, flags), rolled out per environment through CodeDeploy blue/green with a pre-traffic smoke gate and canary.

**Architecture:** One ECS cluster and one ALB in account 385467776718 hold three logical environments on their own ports. GitHub Actions builds one image per `main` commit, deploys it to sandbox, and moves it on only through PRs that change `deploy/<env>.json`, checked against SSM `last-good` history. Each environment deploys via CodeDeploy; a `CodeDeployHook_` Lambda smoke-tests green on the test listener before traffic moves, and a per-environment 5xx alarm guards both the canary and AppConfig flag flips.

**Tech Stack:** Node 26 (TypeScript by type stripping, `node:test`), GitHub Actions, OpenTofu 1.13 + AWS provider `~> 5.0` + `hashicorp/archive`, ECS Fargate, CodeDeploy, ALB, AppConfig + agent sidecar, SSM Parameter Store, Lambda (`nodejs24.x`).

**Spec:** `docs/superpowers/specs/2026-11-11-trunk-based-delivery-design.md`

**Reference repo (read-only):** the CAMS trunk POC (a private repo). Read files ONLY with `git -C <ref> show origin/main:<path>`. Never check out, switch or modify it. "Port X" below means: copy that file from `origin/main`, then apply exactly the listed changes.

## Global Constraints

- Prefix every AWS resource, SSM path and log group with `zdp`; SSM tree is `/zdp/<env>/…` and `/zdp/shared/…`.
- Environments, in order: `sandbox`, `staging`, `prod`. Gated envs: `staging`, `prod`.
- Ports: prod listeners sandbox `8081`, staging `8082`, prod `8083`; test listeners `9081`, `9082`, `9083`; container port `8080`.
- Deployment configs: sandbox `CodeDeployDefault.ECSAllAtOnce`; staging and prod `CodeDeployDefault.ECSCanary10Percent5Minutes`. Blue termination wait: sandbox 1 min, staging/prod 5 min.
- AWS account `385467776718`, region `us-east-1`, profile `personal-sandbox`. Always pass `--profile personal-sandbox` (or `AWS_PROFILE=personal-sandbox`) to local AWS/tofu commands.
- The GitHub OIDC provider already exists: `arn:aws:iam::385467776718:oidc-provider/token.actions.githubusercontent.com`. Look it up; never create it.
- State bucket `zdp-tfstate-385467776718`, key `zero-downtime-pipeline/terraform.tfstate`, `use_lockfile = true`, `encrypt = true`.
- GitHub repo `chrisfixesit/zero-downtime-pipeline` (public). OIDC subjects in both forms: `repo:chrisfixesit/zero-downtime-pipeline:<suffix>` and `repo:chrisfixesit@*/zero-downtime-pipeline@*:<suffix>`.
- Node 26 locally: `source ~/.nvm/nvm.sh && nvm use 26` before any `node`/`npm` command. CI uses `actions/setup-node@v6` with `node-version: 26`.
- All TS imports use explicit `.ts` extensions; only erasable syntax (no enums, no parameter properties, no namespaces).
- Action pins identical to CAMS (`actions/checkout@v7`, `actions/setup-node@v6`, `aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6`, `aws-actions/amazon-ecr-login@03f1aad4c6c7ffd436567f42f9384779290529bd # v2`, `docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3`, `actions/create-github-app-token@v2`).
- Every shell script starts `set -euo pipefail`; workflow steps that pipe use `shell: bash`.
- No CAMS-specific names left anywhere (`cm-poc`, `govtech`, `case`, `prisma`, `migrate`, `worker`). Task 10 greps for them.
- Never run `tofu apply`, create AWS resources, create the GitHub repo, or push without asking the user in that moment (Task 11).

## Review Focus

1. **The hook Lambda throws before reporting.** CodeDeploy then waits on the lifecycle hook for up to an hour. Expected: every path, including exceptions, ends in `PutLifecycleEventHookExecutionStatus` (`Failed` on error). Test: Task 8, `handler reports Failed when the task definition lookup throws`.
2. **Green isn't registered on the test listener yet when the hook fires.** Expected: the smoke test retries before it fails; one connection error is not a failed release. Test: Task 8, `smoke retries until the release answers`.
3. **CodeDeploy ends `Stopped` or `Failed`, whether from the alarm, the hook or a timeout.** Expected: `last-good` is not written, and the error line names the cause from `errorInformation`. Test: Task 5, `deploy.test.sh: a stopped deployment records nothing`.
4. **First deploy to an environment that's still on the placeholder image with no `last-good`.** Expected: drift reports the placeholder, the deploy scales the service to 1, the deploy succeeds and `last-good` is written. Tests: Task 3, `driftProblems flags a placeholder still running after a recorded deploy` (ported); Task 5, `deploy.test.sh: scales a service at zero to one before deploying`.
5. **A release file with only some components, or extra pointer fields.** Expected: a missing `digests.app` is refused, and `deployedAt`/`runUrl` are ignored. Test: Task 3, `parseRelease accepts a well-formed release and ignores pointer extras` plus `parseRelease refuses a release without digests.app`.

---

## File Structure

```
.nvmrc                          26
package.json                    type=module, scripts test/typecheck, devDeps typescript @types/node
tsconfig.json                   noEmit, strict, allowImportingTsExtensions, erasableSyntaxOnly
Dockerfile                      node:26-alpine runtime image of src/
.dockerignore                   everything except package*.json, src/
src/core/flags/registry.ts      flag declarations (import-free)
src/core/flags/resolve.ts       read one flag from an AppConfig document
src/core/flags/hygiene.ts       staleFlags()
src/core/ports/FeatureFlags.ts  interface
src/adapters/flags/*.ts         InMemory, AppConfigAgent, index (createFeatureFlags/featureFlags)
src/app.ts                      createHandler(): request handler (pure, testable)
src/main.ts                     listen on PORT
scripts/delivery/release.ts     pure delivery rules
scripts/delivery/cli.ts         git/AWS shell around release.ts
scripts/drill-traffic.sh        curl loop for the canary drill
scripts/configure-github.sh     environments, variables, branch protection
.github/scripts/build-push.sh   (+ .test.sh)  build/push zdp/app once, print release JSON
.github/scripts/deploy.sh       (+ .test.sh)  CodeDeploy deploy of one release, record last-good
.github/scripts/open-release-pr.sh            port of CAMS
.github/scripts/flip-flag.sh                  port of CAMS
.github/workflows/{ci,deploy,promote,rollback,apply,drift-check,flag,stale-flags}.yml
.github/CODEOWNERS
infra/bootstrap/main.tf         state bucket (local state)
infra/{versions,main,ecr,cluster,alb,codedeploy,iam,appconfig,smoke-hook,envs,outputs}.tf
infra/appconfig/flags.schema.json
infra/env/{main,variables,outputs}.tf   per-environment module
infra/smoke-hook/{smoke.mjs,index.mjs}  (+ test/smoke-hook.test.mjs)
deploy/staging.json, deploy/prod.json   created by the first promotion PRs, not by hand
test/**                          node:test suites
CONTRIBUTING.md, README.md
```

Delete: `app/`, `.github/workflows/deploy.yml` (old, replaced by the new one of the same name in Task 7), `infra/main.tf`, `infra/variables.tf`, `infra/outputs.tf`, `infra/iam-oidc.tf` (replaced in Task 8).

---

### Task 1: Node scaffold and flag core

**Files:**
- Create: `.nvmrc`, `package.json`, `tsconfig.json`, `src/core/flags/registry.ts`, `src/core/flags/resolve.ts`, `src/core/flags/hygiene.ts`, `src/core/ports/FeatureFlags.ts`
- Modify: `.gitignore` (keep existing lines; add `*.zip`. Do not ignore `.terraform.lock.hcl`; lock files are committed)
- Test: `test/core/flags/registry.test.ts`, `test/core/flags/resolve.test.ts`

**Interfaces:**
- Produces: `flagRegistry` (const, `satisfies Record<string, FlagDefinition>`), `type FlagDefinition = { default: boolean; description: string; issue: number; addedOn: string }`, `type FlagName`, `flagNames: FlagName[]`, `isFlagName(v: string): v is FlagName`, `resolveFlag(name: FlagName, config: unknown): boolean`, `staleFlags(now: Date, maxAgeDays: number, registry?): string[]`, `interface FeatureFlags { isEnabled(name: FlagName): Promise<boolean> }`.

- [ ] **Step 1:** `package.json`: `"type": "module"`, `"private": true`, `"engines": {"node": ">=26"}`, scripts `"test": "node --test \"test/**/*.test.ts\" \"test/**/*.test.mjs\""`, `"typecheck": "tsc --noEmit"`; devDependencies `typescript` (^5) and `@types/node` (^24 or newest). `tsconfig.json`: `strict`, `noEmit`, `module`/`moduleResolution` `nodenext`, `target` `es2024`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, include `src`, `scripts`, `test`. Run `npm install`; commit `package-lock.json`.
- [ ] **Step 2: Write the failing tests.** Port CAMS `test/core/flags/registry.test.ts` and `resolve.test.ts`, converting vitest to `node:test` + `node:assert/strict` (`describe`/`it` from `node:test`). Keep every case; registry test must assert for every entry: `default === false`, `Number.isInteger(issue) && issue > 0`, `addedOn` matches `/^\d{4}-\d{2}-\d{2}$/` and is a real date, name matches `/^[a-z][a-zA-Z0-9_-]{0,63}$/`.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL, modules not found.
- [ ] **Step 4:** Port CAMS `registry.ts` (only `alarmDrill`: description `'Make /drill/alarm return 500 to prove AppConfig alarm rollback'`, `issue: 1`, `addedOn: '2026-11-11'`), `resolve.ts`, `hygiene.ts`, `FeatureFlags.ts`; add `.ts` to every relative import.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: all pass, no type errors.
- [ ] **Step 6: Commit** `feat(flags): flag registry, resolver and hygiene`.

### Task 2: Flag adapters

**Files:**
- Create: `src/adapters/flags/InMemoryFeatureFlags.ts`, `src/adapters/flags/AppConfigAgentFeatureFlags.ts`, `src/adapters/flags/index.ts`
- Test: `test/adapters/flags/InMemoryFeatureFlags.test.ts`, `test/adapters/flags/AppConfigAgentFeatureFlags.test.ts`, `test/adapters/flags/index.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `class InMemoryFeatureFlags implements FeatureFlags` (`constructor(initial?: Partial<Record<FlagName, boolean>>)`, `set(name, enabled)`), `class AppConfigAgentFeatureFlags` (`constructor({ baseUrl, application, environment, profile, timeoutMs = 250, onError })`), `createFeatureFlags(env = process.env): FeatureFlags` (`FLAGS_PROVIDER` `memory` | `appconfig`; appconfig requires `APPCONFIG_APPLICATION`, `APPCONFIG_ENVIRONMENT`, `APPCONFIG_PROFILE`; `APPCONFIG_AGENT_URL` default `http://localhost:2772`), `featureFlags(): FeatureFlags` (process singleton).

- [ ] **Step 1:** Port the three CAMS test files to `node:test`, keeping every case (agent tests stand up a local `node:http` server as CAMS does; replace `vi.fn()` with `mock.fn()` from `node:test`).
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, modules not found.
- [ ] **Step 3:** Port the three adapter files from CAMS unchanged apart from `.ts` import extensions.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(flags): in-memory and AppConfig agent adapters`.

### Task 3: Delivery rules (`release.ts`)

**Files:**
- Create: `scripts/delivery/release.ts`
- Test: `test/scripts/delivery-release.test.ts`

**Interfaces:**
- Consumes: `flagNames`, `flagRegistry`, `isFlagName` (Task 1).
- Produces (same names as CAMS): `type Env`, `type GatedEnv`, `GATED_ENVS`, `COMPONENTS = ['app'] as const`, `type Component`, `type Digests = Record<Component, string>`, `type Release = { sha: string; digests: Digests }`, `parseRelease(raw: unknown): Release`, `previousStage(env: GatedEnv): Env`, `sameRelease(a, b): boolean`, `isAllowed(target, requested, history: { own: Release[]; previous: Release[] }): boolean`, `classifyPaths(paths)`, `renderReleaseFile(release): string`, `releaseBranch(kind, env, release, now): string`, `renderPrText({ kind, env, from, to, repoUrl }): { title; body }`, `type ReleaseFlags`, `buildFlagConfig(current, flag, enabled, release): object`, `type RunningApp`, `driftProblems(env, state): string[]`.

- [ ] **Step 1:** Port CAMS `test/scripts/delivery-release.test.ts` to `node:test` with fixtures using only `digests.app`. Drop the two migration cases (`shows the range, the digests and the migrations…` becomes `shows the range and the digests before anyone approves`; delete `warns that a rollback leaves later migrations applied`). Add `parseRelease refuses a release without digests.app` (`{ sha: <40 hex>, digests: {} }` throws `/digests\.app/`). `sameRelease compares sha and every component`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Port CAMS `release.ts` with these changes only: components come from `COMPONENTS`, and `parseRelease`, `sameRelease`, `renderReleaseFile` and the PR digest table loop over it. `renderPrText` loses the `migrations` argument and the migration paragraph. The header comment says "zero-downtime-pipeline", not "trunk POC". The PR body's last line reads: `` `promotion-check` confirms these digests already ran in the previous stage (or, for a rollback, in this environment). CodeDeploy smoke-tests the release on the test listener before any traffic moves. ``
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(delivery): release rules`.

### Task 4: Delivery CLI (`cli.ts`)

**Files:**
- Create: `scripts/delivery/cli.ts`
- Test: `test/scripts/delivery-cli.test.ts`

**Interfaces:**
- Consumes: Task 3; `staleFlags` (Task 1).
- Produces CLI commands (stdout contract used by workflows): `classify <base> <head>` → `code=<bool>\ndeploy=<bool>`; `check-pr <base> <head>`; `envs-changed <before> <after>` → JSON array; `verify <env> <ref>` → `release=<json>\nnoop=<bool>`; `promotion <env>` → payload JSON `{ env, branch, file, fileContent, title, body }`; `rollback <env> <sha>` → payload; `resolve-own <env> <sha>` → `release=<json>`; `drift <env>` → markdown table, exit 1 on problems; `stale-flags <days>`; `flag-config <flag> <on|off> <current.json> <release-flags.json>`. Errors: one `::error::` line on stderr, exit 1.

- [ ] **Step 1:** Port CAMS `test/scripts/delivery-cli.test.ts` to `node:test` (it builds throwaway git repos in a tmpdir and runs `node scripts/delivery/cli.ts`; keep that). Delete the `migrations:` case. Fixtures use `digests.app` only.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Port CAMS `cli.ts`. Changes: SSM paths become `/zdp/<env>/…`. The `migrations` command and `migrationsBetween` are removed, and `prPayload` no longer passes migrations. `drift` reads `cluster` and `app-service` from SSM exactly as CAMS does.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(delivery): CLI for CI, promotion, rollback, drift and flags`.

### Task 5: Release shell scripts

**Files:**
- Create: `.github/scripts/build-push.sh`, `.github/scripts/build-push.test.sh`, `.github/scripts/deploy.sh`, `.github/scripts/deploy.test.sh`, `.github/scripts/open-release-pr.sh`, `.github/scripts/flip-flag.sh`

**Interfaces:**
- Consumes: `cli.ts flag-config` (Task 4).
- Produces: `build-push.sh <sha> <registry>`, which prints `{"sha":…,"digests":{"app":…}}` on stdout. `deploy.sh <env> <release.json>` (env `RUN_URL` optional) exits 0 only after CodeDeploy reports `Succeeded` and `last-good` has been written. `open-release-pr.sh <payload.json>` and `flip-flag.sh <env> <flag> <on|off>` keep the CAMS interfaces.
- SSM reads (created in Task 9): `/zdp/shared/ecr-registry`, `/zdp/shared/smoke-hook-arn`, `/zdp/shared/appconfig-strategy-id`, `/zdp/<env>/{cluster,app-service,app-base-taskdef,codedeploy-app,deployment-group,app-url,appconfig-application-id,appconfig-profile-id,appconfig-environment-id}`. SSM write: `/zdp/<env>/last-good`.

- [ ] **Step 1: build-push.** Port CAMS `build-push.sh` and `build-push.test.sh` with these changes:
  - One image, `zdp/app`, built with `-f Dockerfile` and no `--target`.
  - The observe-only probe is removed, along with its summary row and probe metadata.
  - Kept: the ECR reuse check, the registry cache (`$REGISTRY/zdp/buildcache:app`), the 600-second bounded push with one retry, and metadata outside the context.
  - The test drops the probe assertions and keeps "context unchanged", "nothing left in context" and "valid release JSON".
  - Run `bash .github/scripts/build-push.test.sh`. Expected: `PASS`.
- [ ] **Step 2: deploy test first.** Write `deploy.test.sh` in the same stub style: fake `aws` on `PATH` answers from a case table, and every call is logged. Cases:
  - `rejects an invalid release before any aws call`: the log is empty and the exit is non-zero.
  - `a succeeded deployment records last-good`: `get-deployment` returns `Succeeded`. The log contains `ssm put-parameter --name /zdp/sandbox/last-good`, and the pointer JSON has `deployedAt` and `runUrl`.
  - `a stopped deployment records nothing`: `get-deployment` returns `Stopped` with `errorInformation.code=ALARM_ACTIVE`. There is no `put-parameter`, the exit is non-zero, and stderr contains `ALARM_ACTIVE`.
  - `scales a service at zero to one before deploying`: `describe-services` reports `desiredCount 0`. The log shows `update-service … --desired-count 1` before `create-deployment`.
  - `registers the app container at the digest with VERSION=sha`: the `register-task-definition` input JSON has image `<registry>/zdp/app@<digest>` and env `VERSION=<sha>`.
- [ ] **Step 3:** Run `bash .github/scripts/deploy.test.sh`. Expected: FAIL (no script).
- [ ] **Step 4: Implement `deploy.sh`.**
  1. Reuse CAMS's `valid_release`, generalised to every key in `.digests`, with at least `app` present.
  2. Use CAMS's `register` (base revision from SSM `app-base-taskdef`), also setting the `VERSION` env var on the `app` container to the sha.
  3. If `desiredCount` is 0, run `update-service --desired-count 1`.
  4. Create the deployment with `aws deploy create-deployment --application-name … --deployment-group-name … --revision file://revision.json`. `revision.json` is `{revisionType:"AppSpecContent", appSpecContent:{content:<appspec JSON string>}}`, built with `jq`. The appspec is: `{version:0.0, Resources:[{TargetService:{Type:"AWS::ECS::Service", Properties:{TaskDefinition:<arn>, LoadBalancerInfo:{ContainerName:"app", ContainerPort:8080}}}}], Hooks:[{AfterAllowTestTraffic:<smoke-hook-arn>}]}`.
  5. Poll `get-deployment` every 15 seconds for up to 40 minutes, logging status changes.
     - `Succeeded`: write the pointer exactly as CAMS does, then print `Recorded <sha> as <env> last-good. Live at <app-url>`.
     - `Failed` or `Stopped`: print `::error::<env> deployment <id> <status>: <errorInformation.code> <errorInformation.message>; CodeDeploy returned traffic to the previous release; nothing recorded`, then exit 1.
     - Timeout: print `::error::` and exit 1.
- [ ] **Step 5:** Run `bash .github/scripts/deploy.test.sh && shellcheck .github/scripts/*.sh`. Expected: all PASS, no shellcheck findings.
- [ ] **Step 6:** Port `open-release-pr.sh` (unchanged) and `flip-flag.sh` (paths `/zdp/`). Run `shellcheck .github/scripts/*.sh`. Expected: clean.
- [ ] **Step 7: Commit** `feat(delivery): build, CodeDeploy deploy, release PR and flag scripts`.

### Task 6: Stand-in app and image

**Files:**
- Create: `src/app.ts`, `src/main.ts`, `Dockerfile`, `.dockerignore`
- Delete: `app/`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: `FeatureFlags`, `featureFlags()` (Task 2).
- Produces: `createHandler(opts: { version: string; flags: FeatureFlags; startedAt?: number }): (req: IncomingMessage, res: ServerResponse) => Promise<void>`.

- [ ] **Step 1: Failing tests** (`node:test`, with a real server on port 0):
  - `GET /healthz` returns 200 `{status:"ok", version}`.
  - `GET /` returns 200 with `{service:"zero-downtime-pipeline", version, uptimeSeconds}`.
  - `GET /drill/alarm` returns 404 with `new InMemoryFeatureFlags()`, and 500 with `new InMemoryFeatureFlags({ alarmDrill: true })`.
  - An unknown path returns 404.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `createHandler` in `src/app.ts`. `src/main.ts` listens on `PORT` (default 8080) with `VERSION` (default `dev`) and `featureFlags()`, and logs one JSON line on start.
- [ ] **Step 4:** `Dockerfile`: `FROM node:26-alpine`, `WORKDIR /app`, `COPY package.json src ./`, `ENV NODE_ENV=production PORT=8080`, `USER node`, `EXPOSE 8080`, then the `HEALTHCHECK` from the old `app/Dockerfile` and `CMD ["node","src/main.ts"]`. The app has no runtime dependencies, so there's no `npm ci`. `.dockerignore`: `*` with `!package.json` and `!src/**`.
- [ ] **Step 5:** Run `npm test`, then `docker build -t zdp-app:local . && docker run -d --rm -p 18080:8080 --name zdp-local zdp-app:local && sleep 2 && curl -fsS localhost:18080/healthz; docker stop zdp-local`. Expected: tests pass and curl prints `{"status":"ok","version":"dev"}`.
- [ ] **Step 6: Commit** `feat(app): TypeScript stand-in service with alarmDrill flag`.

### Task 7: Workflows and CODEOWNERS

**Files:**
- Create: `.github/workflows/{ci,deploy,promote,rollback,apply,drift-check,flag,stale-flags}.yml`, `.github/CODEOWNERS`
- Delete/replace: old `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: CLI commands (Task 4) and scripts (Task 5).
- Produces: the required checks `ci-ok` and `promotion-check`; repo variables `PR_READ_ROLE_ARN`, `MAIN_READ_ROLE_ARN` and `AUTOMATION_APP_ID`; per-environment variable `DEPLOYER_ROLE_ARN`; secret `AUTOMATION_APP_KEY` in the `release-automation` environment.

- [ ] **Step 1: Port `ci.yml`.**
  - Remove the `NODE_OPTIONS` env, since `type: module` silences that warning.
  - Remove `e2e`, `worker-boot` and the docker-compose `unit` job.
  - `typecheck` runs `npm ci` then `npm run typecheck`.
  - `unit` runs `npm ci` then `npm test`.
  - `actionlint` runs actionlint, `bash .github/scripts/build-push.test.sh` and `bash .github/scripts/deploy.test.sh`.
  - `build` runs `.github/scripts/build-push.sh` against the `sandbox` environment.
  - Update the `ci-ok` and `deploy-sandbox` `needs` lists to match.
  - Keep the "always report, skip internally" header comment.
- [ ] **Step 2: Port `deploy.yml`.** It calls `.github/scripts/deploy.sh "${{ inputs.env }}" release.json`, and the summary table loops over `.digests`.
- [ ] **Step 3: Port the remaining six workflows.** Take `promote.yml`, `rollback.yml`, `apply.yml`, `drift-check.yml`, `flag.yml` and `stale-flags.yml` verbatim, then remove the `NODE_OPTIONS` env block.
- [ ] **Step 4: CODEOWNERS.** The same paths as CAMS, plus `/package.json` and `/infra/smoke-hook/`, all owned by `@chrisfixesit`. The header comment explains:
  - Promotion PRs are opened by the App, so the maintainer can approve them.
  - The maintainer's own PRs to gated paths merge through the admin bypass, which GitHub logs.
  - A team should replace the owner with its own groups: devs for `deploy/staging.json`, approvers for everything else.
- [ ] **Step 5:** Run `actionlint`. Expected: no output, exit 0.
- [ ] **Step 6: Commit** `feat(ci): trunk workflows, promotion, rollback, drift and flags`.

### Task 8: Smoke hook Lambda and infra foundation

**Files:**
- Create: `infra/smoke-hook/smoke.mjs`, `infra/smoke-hook/index.mjs`, `infra/bootstrap/main.tf`, `infra/versions.tf`, `infra/main.tf` (replaced), `infra/ecr.tf`, `infra/cluster.tf`, `infra/alb.tf`, `infra/codedeploy.tf`, `infra/iam.tf`, `infra/smoke-hook.tf`, `infra/appconfig/flags.schema.json`
- Delete: `infra/iam-oidc.tf`, `infra/variables.tf`, `infra/outputs.tf`
- Test: `test/smoke-hook.test.mjs`

**Interfaces:**
- Produces:
  - `smoke({ baseUrl, expectedVersion, fetchFn = fetch, attempts = 12, delayMs = 5000 }): Promise<{ ok: boolean; reason: string }>`. It passes only if `GET /healthz` returns 200 and `GET /` returns JSON whose `version` equals `expectedVersion`.
  - `makeHandler({ codedeploy, ecs, fetchFn, testUrls, smokeOpts })`, which returns `async (event: { DeploymentId: string; LifecycleEventHookExecutionId: string }) => void`.
  - `index.mjs` exports `handler = makeHandler({...})`, built from SDK v3 clients and `TEST_URLS`, a JSON map of deployment-group name to `http://<alb-dns>:<test-port>`.
  - Locals `name = "zdp"` and `envs = { sandbox = { port = 8081, test_port = 9081, config = "CodeDeployDefault.ECSAllAtOnce", termination_wait = 1 }, staging = {8082, 9082, canary, 5}, prod = {8083, 9083, canary, 5} }`.
  - Resources: `aws_lb.this`, `aws_security_group.alb`, `aws_security_group.tasks`, `aws_ecs_cluster.this`, `aws_ecr_repository.app` (`zdp/app`), `aws_ecr_repository.buildcache` (`zdp/buildcache`), `aws_codedeploy_app.this` (`zdp`), `aws_iam_role.codedeploy`, `aws_iam_role.exec[env]`, `aws_iam_role.task[env]`, `aws_lambda_function.smoke_hook` (`CodeDeployHook_zdp-smoke`).

- [ ] **Step 1: Failing tests** in `test/smoke-hook.test.mjs`, using a stub `fetchFn`, `delayMs: 0` and stub clients:
  - `smoke passes when healthz is 200 and / reports the expected version`
  - `smoke fails naming the version it saw`
  - `smoke retries until the release answers`: the first two calls reject and the third succeeds, so `ok: true`.
  - `handler reports Succeeded for a healthy release`: the stub `codedeploy.getDeployment` returns a revision whose appspec has a TaskDefinition ARN, and `ecs.describeTaskDefinition` returns `VERSION`. Expect `putLifecycleEventHookExecutionStatus` to be called with `status: 'Succeeded'`.
  - `handler reports Failed when the task definition lookup throws`: the status is `'Failed'` and the call is still made.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `smoke.mjs` and `index.mjs`.**
  - The handler resolves the test URL from `deploymentInfo.deploymentGroupName`, the TaskDefinition from `JSON.parse(revision.appSpecContent.content)`, and `VERSION` from the `app` container's environment.
  - It always reports status in a `finally` block and logs one JSON line with the result.
  - It takes clients by injection; `index.mjs` alone imports `@aws-sdk/client-codedeploy` and `@aws-sdk/client-ecs`, which the runtime provides.
- [ ] **Step 4:** Run `npm test`. Expected: pass.
- [ ] **Step 5: Bootstrap.** `infra/bootstrap/main.tf` uses local state and creates `zdp-tfstate-385467776718` with versioning, SSE-S3, public access fully blocked and `prevent_destroy`.
- [ ] **Step 6: Foundation `.tf` files.**
  - **`versions.tf`:** tofu `>= 1.10.0`, providers `aws ~> 5.0` and `archive ~> 2.4`, the S3 backend from Global Constraints, and a provider `default_tags` block with `Project = "zero-downtime-pipeline"` and `ManagedBy = "opentofu"`.
  - **`main.tf`:**
    - locals, plus `oidc_repos` built from `var.github_repo` (default `chrisfixesit/zero-downtime-pipeline`) in both subject forms
    - data sources for the default VPC, its subnets, the caller identity and the existing OIDC provider (ARN above)
    - `var.permissions_boundary_arn`, default `null`, applied to every role
  - **`alb.tf`:**
    - the ALB in the default subnets
    - the ALB security group, ingress on 8081-8083 and 9081-9083 from `0.0.0.0/0` (the test ports are public because the hook Lambda runs outside the VPC; the README says so)
    - the tasks security group, ingress on 8080 from the ALB security group only
  - **`cluster.tf`:** the cluster with Container Insights.
  - **`ecr.tf`:** both repos, immutable tags, scan on push.
  - **`codedeploy.tf`:** the app, plus a service role with `AWSCodeDeployRoleForECS`. That managed policy only allows invoking functions named `CodeDeployHook_*`, which is why the Lambda has that name.
  - **`iam.tf`:** port CAMS `iam.tf` with these changes:
    - remove the S3 and secrets statements and `RunTask`
    - each deployer gets `codedeploy:CreateDeployment` on `arn:aws:codedeploy:us-east-1:<acct>:deploymentgroup:zdp/zdp-<env>`
    - each deployer gets `codedeploy:GetDeployment` and `codedeploy:GetDeploymentGroup` on the same ARN, `codedeploy:GetDeploymentConfig` on `deploymentconfig:*`, and `codedeploy:RegisterApplicationRevision` and `codedeploy:GetApplicationRevision` on `application:zdp`
    - `ecs:UpdateService` on `service/zdp/zdp-<env>-app`
    - the sandbox deployer keeps the ECR push and buildcache statements
    - the task role has no statements yet; its AppConfig read and the deployers' `deployer_flags` policy are added in Task 9's `appconfig.tf`, because they reference AppConfig resources
  - **`smoke-hook.tf`:**
    - `archive_file` of `infra/smoke-hook/`
    - the Lambda: `nodejs24.x`, a 180-second timeout, and `TEST_URLS` from the `envs` map
    - its role: basic logs, `codedeploy:PutLifecycleEventHookExecutionStatus` and `codedeploy:GetDeployment` on `deploymentgroup:zdp/*`, and `ecs:DescribeTaskDefinition`
    - SSM `/zdp/shared/smoke-hook-arn` and `/zdp/shared/ecr-registry`
  - **`flags.schema.json`:** port CAMS's, with the title changed to `zdp feature flags…`.
- [ ] **Step 7:** Run `cd infra && tofu fmt -check -recursive && tofu init -backend=false && tofu validate`. Do the same in `infra/bootstrap`. Expected: `Success! The configuration is valid.`
- [ ] **Step 8: Commit** `feat(infra): foundation, identities and CodeDeploy smoke hook`.

### Task 9: Per-environment module, AppConfig, outputs

**Files:**
- Create: `infra/env/main.tf`, `infra/env/variables.tf`, `infra/env/outputs.tf`, `infra/envs.tf`, `infra/appconfig.tf`, `infra/outputs.tf`

**Interfaces:**
- Consumes: Task 8 resources and locals.
- Produces: the SSM params Task 5 reads; outputs `deployer_role_arns` (map), `pr_read_role_arn`, `main_read_role_arn`, `app_urls` (map env → `http://<alb>:<port>`) and `alb_dns_name`; module output `alarm_arn`.

- [ ] **Step 1: The `env` module.**
  - **Target groups:** `zdp-<env>-blue` and `zdp-<env>-green` (ip, port 8080, health `/healthz`, interval 15, healthy 2, unhealthy 3).
  - **Listeners:** prod on `port` and test on `test_port`, both defaulting to forward to blue, with `ignore_changes = [default_action]`.
  - **Log group:** `/ecs/zdp-<env>`, retention 14 days.
  - **Base task definition** `zdp-<env>-app` (Fargate, 256/512, exec and task roles):
    - container `app` with placeholder image `public.ecr.aws/docker/library/node:26-alpine` and env `PORT=8080`, `VERSION=placeholder`, `FLAGS_PROVIDER=appconfig`, `APPCONFIG_APPLICATION=zdp-<env>`, `APPCONFIG_ENVIRONMENT=<env>`, `APPCONFIG_PROFILE=flags-<env>`
    - the `appconfig-agent` sidecar exactly as CAMS
  - **Service** `zdp-<env>-app`:
    - `CODE_DEPLOY` controller, `desired_count = 0`, public IP, the tasks security group, and the load balancer on blue
    - `ignore_changes = [task_definition, load_balancer, desired_count]`
  - **Alarm** `zdp-<env>-target-5xx`:
    - metric math `FILL(m1,0)+FILL(m2,0)` over `HTTPCode_Target_5XX_Count`, Sum, 60-second period
    - dimensions: the ALB plus each target group
    - threshold ≥5 for 1 period, `notBreaching`
  - **Deployment group** `zdp-<env>`:
    - `BLUE_GREEN` with traffic control, the config and termination wait from the `envs` map, `CONTINUE_DEPLOYMENT`
    - auto-rollback on `DEPLOYMENT_FAILURE` and `DEPLOYMENT_STOP_ON_ALARM`, with the alarm attached
    - `prod_traffic_route` on the prod listener, `test_traffic_route` on the test listener
  - **SSM params:** `cluster`, `app-service`, `app-base-taskdef` (the full revision ARN), `codedeploy-app`, `deployment-group`, `app-url`.
- [ ] **Step 2: `envs.tf`, `appconfig.tf` and `outputs.tf`.**
  - **`envs.tf`:** `module "env"` with `for_each = local.envs`.
  - **`appconfig.tf`:** port CAMS's, minus the `enable_appconfig` toggle (flags are always on). Also add:
    - the task role's AppConfig read policy (`aws_iam_role_policy.task_appconfig`, this environment's application only)
    - CAMS's `deployer_flags` policy, unchanged apart from names
  - **`outputs.tf`:** the outputs listed in the Interfaces block above.
- [ ] **Step 3:** Run `cd infra && tofu fmt -check -recursive && tofu init -backend=false && tofu validate`. Expected: valid.
- [ ] **Step 4: Commit** `feat(infra): per-environment CodeDeploy stacks and AppConfig flags`.

### Task 10: Docs, GitHub setup script, drill script

**Files:**
- Create: `CONTRIBUTING.md`, `scripts/configure-github.sh`, `scripts/drill-traffic.sh`
- Modify: `README.md` (rewrite)

- [ ] **Step 1: `configure-github.sh`.** Port CAMS `scripts/poc/configure-github.sh` with these changes:
  - It reads tofu outputs from `infra/`.
  - It creates the `sandbox`, `staging`, `prod` and `release-automation` environments, restricted to `main`.
  - It sets `DEPLOYER_ROLE_ARN` per environment, plus `PR_READ_ROLE_ARN`, `MAIN_READ_ROLE_ARN` and `AUTOMATION_APP_ID` (passed as an argument).
  - Branch protection on `main`: required checks `ci-ok` and `promotion-check`, strict; code-owner review required; `enforce_admins: false`; linear history.
  - It prints the remaining manual step: setting the `AUTOMATION_APP_KEY` secret on `release-automation`.
- [ ] **Step 2: `drill-traffic.sh <url> [seconds=360]`.** A `curl` loop of about 5 requests a second that prints a running count of response codes.
- [ ] **Step 3: `CONTRIBUTING.md`.** Adapt CAMS's text:
  - Environments, the Promote/Roll back/Flag workflows and "what happens after you merge", with timings marked "about" and to be measured in Task 11.
  - Smoke now runs before traffic, and a failure in any environment, sandbox included, leaves the previous release serving.
  - The flag walkthrough uses `alarmDrill` and `/drill/alarm`.
  - Drop the migrations section; replace it with a one-line note that a project with a database must follow expand-then-contract, because a rollback never reverts data.
- [ ] **Step 4: `README.md`.**
  - What the template is, with a mermaid flow: merge → build → sandbox → Promote PR → staging canary → prod canary.
  - Setup in order: `nvm use 26`, the bootstrap apply, the infra apply (with the tofu-or-not-tofu exemption note), creating the GitHub App, `configure-github.sh`, and the first push.
  - The two drills as procedures, from the spec's "Settled during the builder check".
  - Design choices, including the public test ports trade-off.
  - What to replace when copying.
  - License line: "MIT — built by [Christopher Corbin](https://christophercorbin.cloud)", kept as is.
- [ ] **Step 5: Check for CAMS leftovers.** Run `git grep -nIiE 'cm-poc|govtech|case-?management|prisma|migrate|worker|christophercorbin/' -- . ':!docs/superpowers'`. Expected: no matches (`christophercorbin.cloud` in the README is allowed). Then run `npm test && npm run typecheck && actionlint && shellcheck .github/scripts/*.sh scripts/*.sh`. Expected: all clean.
- [ ] **Step 6: Commit** `docs: trunk-based delivery guide, setup and drills`.

### Task 11: Stand up and prove (with the user)

Every step marked **ASK** needs the user's go-ahead in the moment. No step in this task is unit-tested; each one is verified by what it observably does.

- [ ] **Step 1: Check identities.** Run `aws sts get-caller-identity --profile personal-sandbox`, which should show `385467776718`. Run `gh auth status` and confirm `chrisfixesit` is the active account; if it isn't, stop and tell the user.
- [ ] **Step 2: ASK, bootstrap.** Run `cd infra/bootstrap && AWS_PROFILE=personal-sandbox tofu init && tofu apply`. The plan should show only the state bucket and its settings.
- [ ] **Step 3: ASK, infra.** Run `cd infra && AWS_PROFILE=personal-sandbox tofu init && tofu plan -out=.tfplan`. Show the user a summary of the plan, then run `tofu apply .tfplan`.
- [ ] **Step 4: ASK, GitHub repo.** Run `gh repo create chrisfixesit/zero-downtime-pipeline --public --source . --remote origin`, then push `main` (the initial commit only) and the feature branch.
- [ ] **Step 5: GitHub App (user does this).** The user creates the App with Contents RW and Pull requests RW, installs it on the repo, and gives you the App ID. The user sets the `AUTOMATION_APP_KEY` secret.
- [ ] **Step 6: ASK, configure GitHub.** Run `scripts/configure-github.sh <app-id>`.
- [ ] **Step 7: Open and merge the PR.** Open the PR for `feat/trunk-based-delivery`; `ci-ok` should be green. The user merges it, using the admin bypass.
- [ ] **Step 8: Run the proofs** from the spec's "Proof of done" 1-9, in order. Record each run URL and its outcome in the PR thread or the final report. Proofs 6 and 9 use throwaway commits that are reverted afterwards.
- [ ] **Step 9: Update `CONTRIBUTING.md` timings** with the measured durations. Commit `docs: measured release timings`.
