# Trunk-based delivery for zero-downtime-pipeline

Date: 2026-11-11
Status: ready for review

## Intent

Turn this repo into a **working template** for trunk-based delivery on AWS: the
thing a new project copies to get CAMS's release flow on day one, without
copying the CAMS app and stripping it out.

The reference is a private trunk-based POC (CAMS), branch `main`. Its release
flow is reproduced as closely as possible. The one deliberate addition is this
repo's existing CodeDeploy blue/green canary, kept as the way every environment
rolls out, because it catches what a scripted smoke test cannot: errors that
only real traffic triggers.

The app stays a tiny stand-in HTTP service, so it is obvious what a project
replaces.

## Goals

- `main` is the only long-lived branch. Short branches, merge through a PR once
  `ci-ok` is green.
- One build per commit on `main`; the same image digest is what runs in every
  environment. Nothing is resolved by tag at deploy time.
- Three environments, **sandbox → staging → prod**, in one AWS account.
- A merge to `main` deploys to sandbox automatically.
- **Promote** (Actions tab) opens a PR that sets `deploy/<env>.json` to the
  previous stage's last-good release. Merging it deploys exactly those digests.
- **last-good** (SSM `/zdp/<env>/last-good`) is recorded only after a clean
  rollout; only last-good can be promoted, and `promotion-check` refuses
  anything else, including swapped digests.
- **Roll back** returns an environment to a release that already ran there:
  sandbox redeploys directly, staging and prod open a PR.
- **Feature flags** exactly as CAMS: registry, AppConfig agent sidecar,
  **Flag** workflow, alarm-guarded watch, refusal for flags the running release
  does not declare, weekly stale-flag report.
- Hourly **drift check** comparing deploy file, last-good and the running image.
- **CODEOWNERS** gating `deploy/`, workflows, scripts, delivery code, flags and
  infra.
- Proven end to end in AWS account **385467776718** (`personal-sandbox`).

## Non-goals

- A real application, database, migrations or worker. CAMS's migrate and
  worker images, Prisma, RDS, CloudFront, secrets and seeding are dropped.
- Private subnets / NAT. The default VPC's public subnets are used (as today).
- Multi-account environments.
- E2E browser test suites. CAMS's Playwright, vitest-in-docker and sharding
  are out; the stand-in has unit tests only.

## Anti-goals (would make this a failure even if it works)

- Anything a project must untangle before using it: CAMS-specific names,
  internal teams, CAMS domain concepts left behind.
- A promotion path that can deploy something that never ran in the previous
  stage.
- Rebuilding images per environment.
- A deploy that reports success while the old version is still serving.

## Constraints

- Repo will be **public** at `github.com/chrisfixesit/zero-downtime-pipeline`
  (needed for CODEOWNERS reviews and environment protection on a free plan).
- AWS account 385467776718, region `us-east-1`. Shared with other projects
  (`hurricane-ready`, a Brekup stack): every resource prefixed `zdp`.
- The GitHub OIDC provider **already exists** in the account; it is looked up
  with a data source, never created (the current `infra/iam-oidc.tf` would
  collide and must go).
- No state bucket exists yet. A bootstrap step creates
  `zdp-tfstate-385467776718` (S3, versioned, encrypted, `use_lockfile`).
  State stays in this account, as CAMS keeps its own (my call).
- OpenTofu, AWS provider `~> 5.0`.
- Node 26 running TypeScript directly (type stripping), like CAMS, so
  `scripts/delivery/` and `src/core/flags/` can be carried across with minimal
  change. The current `app/server.mjs` moves to TypeScript (my call).

## Decided with the user

- Working template, not portfolio piece.
- Keep the canary (user asked for a recommendation; recommended and accepted).
- Include feature flags, same as CAMS.
- Deploy to 385467776718.
- Public repo.

## Architecture

### Shared footprint (CAMS layout)

One ECS cluster, one internet-facing ALB, three logical environments on their
own listener ports (my call, mirrors CAMS):

| Env     | Prod listener | Test listener | Deployment config                            |
|---------|---------------|---------------|----------------------------------------------|
| sandbox | 8081          | 9081          | `CodeDeployDefault.ECSAllAtOnce`             |
| staging | 8082          | 9082          | `CodeDeployDefault.ECSCanary10Percent5Minutes` |
| prod    | 8083          | 9083          | `CodeDeployDefault.ECSCanary10Percent5Minutes` |

Per environment (an `infra/env` module instantiated with `for_each`, like
CAMS): ECS service with `CODE_DEPLOY` controller, blue + green target groups,
prod and test listeners, CodeDeploy deployment group, base task definition
(pinned in SSM, never "latest in family"), log group, exec and task roles, 5xx
alarm, AppConfig application/environment/profile, SSM parameters under
`/zdp/<env>/`.

One ECR repository `zdp/app` (immutable tags, scan on push) plus
`zdp/buildcache` for the registry layer cache.

### Release shape

```json
{ "sha": "<40 hex>", "digests": { "app": "sha256:<64 hex>" } }
```

Same shape as CAMS with one component. `COMPONENTS` is a single list in
`release.ts` so a project can add `worker` etc. in one place.

### Deploy (replaces CAMS `ecs-deploy.sh` with a CodeDeploy version)

`.github/scripts/deploy.sh <env> <release.json>`:

1. Validate the release.
2. Register a task-definition revision from `/zdp/<env>/app-base-taskdef`
   with the `app` container set to `<registry>/zdp/app@<digest>`.
3. Create a CodeDeploy deployment with that revision.
4. CodeDeploy starts green and attaches it to the **test listener**.
5. **Smoke gate before any user traffic.** The smoke check runs against the
   test listener. On failure the deployment is stopped with auto-rollback;
   users never saw the release. Mechanism is left to the builder (see Open
   questions): either a CodeDeploy `AfterAllowTestTraffic` hook Lambda or the
   workflow running the smoke while CodeDeploy holds at "ready, wait for
   continue" and then calling `continue-deployment`.
6. Traffic shifts per the environment's deployment config. The 5xx alarm is
   attached to the deployment group; a breach rolls traffic back to blue.
7. Wait for the deployment to reach `Succeeded`. `Stopped` / `Failed` is a
   failed deploy, and the script says which (smoke vs. alarm vs. other).
8. Only then write last-good (`release + deployedAt + runUrl`).

Because CodeDeploy rolls back to blue itself, a failed deploy in **any**
environment leaves the previous release (= last-good) serving. This differs
from CAMS, where sandbox kept the failed release running; here sandbox also
reverts (my call; there is nothing to "look at" that the logs don't show).

Alarm: per environment, `HTTPCode_Target_5XX_Count` summed across that
environment's blue **and** green target groups (metric math), ≥5 in one
minute. The same alarm guards CodeDeploy and AppConfig flag flips.

### Workflows (ported from CAMS, same names and behaviour)

- `ci.yml`: `changes` (classify), `typecheck`, `unit` (`node --test`),
  `actionlint` (+ `build-push.test.sh`), `promotion-check`, `ci-ok`
  aggregate; on push to `main`: `build` (sandbox environment, deployer role)
  then `deploy-sandbox`. Same "always report, skip internally" rule for
  required checks.
- `deploy.yml`: reusable, runs in the GitHub Environment of the target env.
- `promote.yml`, `rollback.yml`, `apply.yml`, `drift-check.yml`, `flag.yml`,
  `stale-flags.yml`: as CAMS.
- `pr-cache-cleanup.yml`: optional; carry over if trivial.
- Pinned action SHAs as in CAMS.

### Scripts and code (ported)

- `scripts/delivery/release.ts`, `cli.ts`: as CAMS, with `/zdp/` paths,
  one component, migration listing removed (no migrations; keep the PR text
  section out).
- `.github/scripts/build-push.sh` (+ test), `open-release-pr.sh`,
  `flip-flag.sh`: as CAMS, renamed paths. The observe-only digest probe in
  `build-push.sh` is dropped (CAMS-specific investigation; my call).
- `src/core/flags/registry.ts`, `resolve.ts`, `hygiene.ts`,
  `src/adapters/flags/*`: as CAMS. Registry ships `alarmDrill` only.
- App: `app/server.ts` serving `/healthz`, `/` (version JSON), and
  `/drill/alarm` (500 when `alarmDrill` is on, 404 otherwise). The old `CHAOS`
  env var is replaced by the flag.

### Identity (ported from CAMS `iam.tf`)

- `zdp-deployer-<env>`: trusted only for OIDC subject `environment:<env>`.
  Only sandbox's can push to ECR. Each can create CodeDeploy deployments only
  for its own deployment group, pass only its own roles, write only its own
  last-good, and flip only its own AppConfig environment.
- `zdp-promotion-read` (subject `pull_request`) and `zdp-drift-read`
  (subject `ref:refs/heads/main`): read-only.
- No permissions boundary (CAMS's is org-specific); left as an optional
  variable.
- OIDC subjects for both classic and immutable-id forms, as CAMS.

### GitHub setup (documented one-time steps, done by the user)

- Rename `master` → `main`; create the public repo.
- GitHub Environments `sandbox`, `staging`, `prod`, `release-automation`
  (deployment branches: `main` only), with `DEPLOYER_ROLE_ARN` per env.
- Repo variables `PR_READ_ROLE_ARN`, `MAIN_READ_ROLE_ARN`, `AUTOMATION_APP_ID`;
  secret `AUTOMATION_APP_KEY` in `release-automation`.
- A GitHub App for opening release PRs (PRs opened with `GITHUB_TOKEN` never
  trigger CI, so `promotion-check` would never run).
- Branch protection / ruleset on `main`: PR required, `ci-ok` required,
  CODEOWNERS review required.

### Docs

- `CONTRIBUTING.md`: CAMS's text adapted (environments, timings, canary,
  flags walkthrough with `alarmDrill`).
- `README.md`: rewritten around the trunk flow, keeps the canary story,
  includes setup steps.

## Proof of done

In account 385467776718, after setup:

1. Merge to `main` → sandbox deployed, last-good recorded.
2. Promote to staging → PR with digests → merge → canary → last-good.
3. Promote to prod, same.
4. A promotion PR with edited digests fails `promotion-check`.
5. Roll back prod to an earlier SHA via PR.
6. A release that fails smoke is stopped before traffic shifts.
7. `alarmDrill` on in sandbox via **Flag**, hit the endpoint, AppConfig rolls
   the flag back.
8. Drift check green for all three environments.
9. A release that passes smoke but errors under traffic is rolled back by the
   canary alarm in staging.

## Left to the builder

- Exact Tofu module layout, naming inside the `zdp` prefix, log retention.
- Smoke check contents (at least: `/healthz` 200 and `/` reports the expected
  sha).
- Typecheck tooling (`tsc --noEmit` with `typescript` + `@types/node` as dev
  deps is the expected choice).

## Settled during the builder check

- **Old stack:** checked 2026-11-11; no `zdp` ECR repo, cluster, ALB,
  CodeDeploy app, IAM role or log group exists in 385467776718. The new stack
  starts clean; no import or teardown step.
- **Failure demos (my call):** no drill code ships in the template beyond the
  `alarmDrill` flag.
  - *Smoke failure* (proof 6) is shown with a throwaway commit to `main` that
    breaks `/healthz`, then reverted.
  - *Canary alarm rollback* is added as proof 9: a throwaway commit that
    passes smoke but returns 500 on a share of `/` requests, promoted to
    staging while `scripts/drill-traffic.sh <url>` (a small curl loop, kept in
    the template) drives traffic; the alarm fires and CodeDeploy returns
    traffic to blue. The commit is reverted afterwards.
  - The README documents both drills as procedures, not code paths.

## Decided by the user after the builder check

- **Approvals with one maintainer:** CODEOWNERS names `@chrisfixesit` for
  every gated path (staging and prod alike). The `main` ruleset requires a
  PR, `ci-ok` and a code-owner review, with **repository-admin bypass** (no
  `enforce_admins`). Promotion and rollback PRs are opened by the GitHub App,
  so they get a genuine review; the maintainer's own PRs to gated paths merge
  through the logged bypass. CODEOWNERS carries a header comment telling a
  project how to swap in real reviewer teams (e.g. devs for staging,
  approvers for prod, as CAMS does).
- **Infra apply:** this repo is **exempt** from the tofu-or-not-tofu rule
  because a template must be self-contained. `infra/bootstrap/` creates the
  state bucket in 385467776718; `infra/` is applied locally with
  `tofu apply` under `AWS_PROFILE=personal-sandbox`, as CAMS does. No CI
  apply workflow or role. The README states the exemption.
