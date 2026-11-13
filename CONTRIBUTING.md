# Contributing

## Working on trunk

`main` is the only long-lived branch. Branch off it, keep the branch under two days, and merge through a PR once `ci-ok` is green. Anything that is not ready for users merges behind a flag declared in `src/core/flags/registry.ts`, with its issue number and the date you added it, defaulting to off.

Locally, use Node 26 (`nvm use 26` reads `.nvmrc`), then `npm ci`, `npm test` and `npm run typecheck`.

### Environments

| Environment | URL | Rollout | Gets a release |
|---|---|---|---|
| sandbox | `http://<alb>:8081` | all at once | on every merge to `main` |
| staging | `http://<alb>:8082` | canary: 10%, then the rest after 5 minutes | when a **Promote** PR merges |
| prod | `http://<alb>:8083` | canary: 10%, then the rest after 5 minutes | when a **Promote** PR merges |

`<alb>` is the `alb_dns_name` tofu output; `app_urls` lists all three. Each environment also has a test listener (9081, 9082, 9083) that only ever reaches the release being deployed.

### Releasing

A merge to `main` builds one image and deploys it to sandbox. To move it on, run **Promote** (Actions tab) for staging, then for prod. Each opens a PR that names the exact image digest; merging it deploys it. Promotion PRs need a code-owner review (see `.github/CODEOWNERS`). **Roll back** returns an environment to a release that already ran there: sandbox redeploys straight away, staging and prod open the same kind of PR as a promotion. **Flag** turns a flag on or off in one environment without a deploy.

### What happens after you merge

1. **CI on `main`** runs the same checks as your PR, then builds the image once. `ci-ok` is the required check; it fails if any job fails.
2. **Sandbox deploys** that image through CodeDeploy. The new release (green) starts beside the running one (blue) and is attached to the test listener only.
3. **A smoke test runs before any user traffic.** CodeDeploy's `AfterAllowTestTraffic` hook calls a Lambda that checks `/healthz` returns 200 and `/` reports the commit being deployed, through the test listener. If it fails, CodeDeploy stops the deployment and users never see the release.
4. **Traffic shifts.** Sandbox moves everything at once; staging and prod move 10% for 5 minutes, then the rest. If the environment's server-error alarm (`zdp-<env>-target-5xx`, five or more 5xx responses in a minute across blue and green) fires during the deployment, CodeDeploy returns all traffic to blue.
5. **Only a clean deployment is recorded** as the environment's **last-good** (SSM `/zdp/<env>/last-good`). The deploy run's summary shows the release.
6. **Promotion follows last-good.** Staging can only receive a release that ran cleanly in sandbox, prod only one from staging; `promotion-check` refuses anything else, including a PR whose digest was swapped.

Allow about 5 minutes from merge to a recorded sandbox release, and about 13 minutes from merging a promotion or rollback PR to a recorded staging or prod release (the 5-minute canary, then 5 minutes before blue is shut down). Those are measured from the first real runs (November 2026).

A failure in **any** environment, sandbox included, leaves the previous release serving and records nothing, so the failed release cannot be promoted. The run's error line says why (smoke hook, alarm, or another CodeDeploy error). Fix forward or revert on `main`.

### Releasing behind a flag

A flag lets you merge work that is not ready for users, then switch it on one environment at a time without a build or a deploy. Code ships to sandbox, staging and production on its own schedule; the flag decides when people see it.

**1. Declare the flag** in `src/core/flags/registry.ts`. The default must be `false`, and the entry needs the issue it belongs to and today's date; tests refuse anything else. Names start with a lowercase letter and use only letters, digits, `-` or `_`.

```ts
reportExport: {
  default: false,
  description: 'Export the weekly report as CSV',
  issue: 123,
  addedOn: '2026-11-11',
},
```

`src/core/flags/` has a code owner, so the PR that adds an entry needs their review. The code that uses the flag does not.

**2. Wrap the change.** Ask the flag service, which `src/main.ts` passes into the request handler:

```ts
if (await flags.isEnabled('reportExport')) {
  // new behaviour
}
```

Take a `FeatureFlags` parameter (`src/core/ports/FeatureFlags.ts`) rather than calling `featureFlags()` from deep inside your code, so tests can control it; `src/app.ts` shows the pattern.

**3. Test both states** with the in-memory flags, which start every flag at its default:

```ts
new InMemoryFeatureFlags()                       // off
new InMemoryFeatureFlags({ reportExport: true }) // on
```

Locally and in CI every flag is off unless a test sets it, so unfinished work cannot break the existing suites.

**4. Merge with the flag off.** It deploys to sandbox and nobody sees it. Keep merging small pieces behind the same flag rather than holding a long branch.

**5. Turn it on**, one environment at a time: **Actions → Flag → Run workflow** on `main`, with the environment, the flag name and `on`. Start with sandbox, then staging, then prod.

- It takes **about six minutes**. The new setting reaches the app within a minute (the AppConfig agent's poll), then AppConfig watches for five minutes. That is the price of the safety net below: the alarm needs about three minutes to notice errors, so the watch has to outlast it.
- A green run ends with a line such as `Deployment 3: reportExport=on in sandbox (version 3)`.
- A flag can only be flipped where its code is running. The run reads the environment's release from last-good and refuses with `"…" is not declared by the release running in this environment` if that release's registry lacks the flag. A flag added on `main` reaches staging and prod only when its release is promoted there.
- A red run says why in the log and as an annotation.
- Only that environment changes. Each environment has its own AppConfig application, and each deploy role can change only its own.

**6. The safety net.** If the environment's server-error alarm (`zdp-<env>-target-5xx`) fires during those five minutes of watching, AppConfig puts the previous setting back by itself and the run fails with "rolled back". After an alarm, wait until it shows `OK` before flipping anything else in that environment, or the next flip rolls back too. "The previous setting" means the last deployment to that environment, not necessarily off: if a flag was already on, a rolled-back flip leaves it on. The net only catches errors that start during the watch: a flagged path nobody hits in those five minutes can fail later, with no automatic rollback, so exercise the new path while the flip is running.

The same alarm guards deployments. Don't flip a flag in an environment while a deployment to it is running: an alarm caused by either one rolls back both.

**7. Turn it off** with the same workflow and `off`. It takes the same six minutes and needs no code change.

**8. Remove the flag** once the feature is fully on in prod and stable: delete the `if`, keeping the new path, and the registry entry, in one PR. Until that PR reaches an environment, the flag keeps its value there: flipping another flag carries over every flag the running release still reads. A weekly job (**Stale flags**) lists flags older than 60 days.

Two things to know. Flipping a flag in prod needs no approval on a free or Team plan; anyone with write access can run the workflow from `main`. And the app fails closed only before its first answer: if it cannot reach the flag service, or the answer takes longer than 250 ms, it keeps the last values it read, and only a process that has never had an answer reads every flag as off. So while the flag service is unreachable, a flip (on or off) does not reach that process.

To see the whole loop, use the `alarmDrill` flag in sandbox. While it is on, `/drill/alarm` returns 500; off, it returns 404. Keep requests to a handful, or you will trip the alarm and watch AppConfig roll the flag back, which is the other half of the demo (README, Drills).

### Data changes

This template has no database. A project that adds one must make every schema change expand-then-contract, because a rollback reverts the app, never the data.
