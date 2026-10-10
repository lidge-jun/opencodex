# A4 — #4141 service does not come back after `ocx update`

Raw research: `_research/4141.md`.

## Verdict

Real. `ocx update` stops the service, replaces the binary, then runs
`ocx service repair`, which on darwin is `installLaunchd()`
(`src/service.ts:3129-3131`). That function best-effort `unload`s the plist, runs
`load -w`, and **throws** on any stderr matching `Load failed`/`Bootstrap failed`
(`:2296-2324`, regex at `:919-921`). The thrown text is exactly the operator
message in the issue, and it contains the `bootout` recipe as a hint that nothing
ever executes.

Modern launchd writes `Load failed: 5: Input/output error` **and exits 0** when a
job is already bootstrapped in `gui/<uid>` (`:874-879`, `:913-917`, fixture at
`tests/service/service.test.ts:3141-3145`). So a live-but-stale job is precisely
the case that cannot repair itself.

`startLaunchd` already handles this correctly — it treats the same `Load failed`
as success when `launchdJobMatchesPlist` says the live job matches (`:2344-2354`).
Repair does not go through `startLaunchd`.

## The choice being made — and it is a policy choice

`_research/4141.md` marks "auto-`bootout` versus today's hint-only throw" as
POLICY, and it is right to: `bootout` **kills the live gui job**. That is exactly
the repair the issue asks for, and it is also the reason the current code only
prints the command instead of running it. Taking it is a product decision, so it
goes in the PR body as a decision, not as a bug fix that speaks for itself.

Two things keep the blast radius honest. It runs only inside `installLaunchd`,
which is already the "put the job back" path, never inside `ocx service start`.
And it fires only after `load -w` has already failed, so a healthy job that loads
cleanly is never touched.

## Chosen fix — `installLaunchd` only

1. Replace the discarded `runLaunchctl(["unload", plist])` with
   `runLaunchctl(["bootout", \`${launchdGuiDomain()}/${LABEL}\`])`, ignoring absence.
2. If `load -w` still trips `launchctlLoadFailed`, `bootout` once more and retry
   `load -w` a single time. Keep the existing throw if the retry also fails.
3. Give `installLaunchd` the same `launchctl`/`matches` injection seam
   `startLaunchd` already has (`:2337-2341`). It currently hard-calls
   `runLaunchctl` and is unexported, so there is no way to test it otherwise.

**Do not weaken `launchctlLoadFailed` (`:919-921`).** That regex is the
2026-08-02 silent-success guard; the fix is to recover from the condition, not to
stop detecting it.

## Deliberately not in this PR

- `stopLaunchd` / `uninstallLaunchd` / install-cleanup stop (`:2363`, `:2367`,
  `:3550`) keep legacy `unload`. Once `installLaunchd` boots out before loading,
  changing them is not required, and each has a test pinning its exact string.
- `startLaunchd` keeps throwing on a stale non-matching job (`:2345-2348`). That
  throw exists so `ocx service start` never kills a healthy loaded job.
- `statusLaunchd` stays `launchctl list | grep` (`:2364`). Moving it to
  `print gui/<uid>/<label>` changes `running` and `isServiceViable`
  (`:4090-4091`) independently of this bug and deserves its own change.
- The `ocx update` fire-and-forget fallback spawn (`src/update/index.ts:408-417`)
  still does not wait for a bind. Separate issue.

## Conflict with PR #4152 — why this is last in the stack

PR #4152 (`codex/service-manager-live-guard`) inserts `assertLiveServiceManagerAllowed`
into `sh()` and the real `runLaunchctl` runner so a test can never mutate a live
service manager. It rewrites the same runner this fix calls. #4141 is therefore the
**last** item in Lane A: #4152 lands first, then this branch rebases onto it and
adopts whatever seam #4152 established rather than inventing a second one.

The lane must not run `launchctl`, `ocx service`, or `ocx start/stop/restart`
while working on this. A live proxy is running and a separate task owns it.

## Regression test

`tests/service/service.test.ts` has no darwin repair coverage today — its repair
block is win32-only through `:3131`. Add darwin cases against the new injection
seam:

- `load -w` returns `Load failed: 5: Input/output error` on the first call and
  succeeds after a `bootout` → `installLaunchd` resolves, and the recorded
  `launchctl` argv sequence is `bootout`, `load -w`, `bootout`, `load -w`.
  Red today: it throws on the first `Load failed`.
- `load -w` fails both times → still throws, message unchanged.
- Existing `:3148-3327` and `:3596-3603` bootout-hint cases stay green.

## PR

`fix(service): recover a stale launchd job with bootout before load` — branch
`lane-a/3-4141`, PR base `lane-a/2-4148`, top of the Lane A stack. Closes #4141.
