# Lane A — luvs01 bug / fixture-determinism train

PRs #4043 #4041 #4039 #4036 #4034 #4025 #4015 #4014 #4012 #4006 #4004 #3997, plus issues #4003 #4005 #3996.

READ-ONLY adversarial review for the 2.49 bulk closeout.

- Research worktree: `/tmp/ocx-249.xGQnxl/wt`, detached at `origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9`.
- Remote verified: `git -C /tmp/ocx-249.xGQnxl/wt remote get-url origin` -> `https://github.com/lidge-jun/opencodex.git`.
- Index re-read immediately before verdict: `git fetch origin dev` -> `origin/dev` still `7dc7dc99e65268bc8764e19840952256b030bce9`; all twelve PR head SHAs re-confirmed unchanged at that moment.
- All twelve PRs are authored by `luvs01` and target `dev`.
- Focused tests ran in a scratch worktree `/tmp/ocx249-laneA/scratch/wt1` (`git worktree add --detach` from the research worktree, `node_modules` symlinked from the main checkout). The research worktree index was never modified. Bun 1.4.0, matching `package.json` `"bun": "1.4.0"`.
- `bun run test` (full suite) was NOT RUN, per lane scope. Local product build/suite: NOT RUN.

## Summary table

| item | verdict | one-line reason | head SHA | CI at head | conflicts |
|---|---|---|---|---|---|
| PR #4039 | LAND_AS_IS | Real TOML terminator defect on dev; proven RED (4 fail) -> GREEN (26 pass); review-ready, non-draft | `7ce4dac80b5cc81e9f1eb1a9dbb4751f8dbe544c` | 17/17 SUCCESS, 5/5 `gh pr checks` pass | none; 0 behind dev |
| PR #4034 | LAND_AS_IS | Replaces duplicated v1 multi-agent text with the shared policy constant; RED (3 fail) -> GREEN (63 pass), consumer suite 144 pass | `eb835fe335c3449d08cb3183606d1cefc2230bc4` | 12 SUCCESS + 1 CANCELLED superseded `enforce-target`; 5/5 pass | none; 22 behind, merges clean |
| PR #4015 | LAND_AS_IS | Test-only Windows fixture determinism; 13 pass / 101 assertions | `4141281b14cc7dad3e3a8b06b727ae4b2ec42ac0` | 20/20 SUCCESS, 5/5 pass | no path overlap |
| PR #4014 | LAND_AS_IS | Test-only prompt-probe admission barrier; 75 pass / 851 assertions | `50929c1008f382fa4f47edcc34ad4cabe24b8403` | 13/13 SUCCESS, 5/5 pass | none |
| PR #4012 | LAND_AS_IS | Test-only timer-race removal; 9 pass. Its single FAILURE is a GitHub API 502 in the hygiene comment upsert, not a regression | `59a390c7406e7910cb81ce4fbd1a5a436c16f41f` | 12 SUCCESS + 1 `hygiene` FAILURE (infra 502); APPROVED | none |
| PR #4004 | LAND_AS_IS | Test-only child-deadline bound; 49 pass / 257 assertions; closes #4003 | `9809dc4d62ab78626674f05a2a428ec303ed43f3` | 17/17 SUCCESS, 5/5 pass; APPROVED | shares `tests/clients/client-connect.test.ts` with #4006 |
| PR #4041 | LAND_AS_IS | Test-only fake-timer conversion of a wall-clock-dependent idle test; 6 pass | `9aa3e9204c12c1bbd9068e77115501e16203bb60` | 13/13 SUCCESS, 5/5 pass | none; 0 behind dev |
| PR #4043 | LAND_AS_IS | Real CLI gap: caps accepted `none`/`minimal` that enforcement silently drops; RED (16 fail) -> GREEN (37 pass) | `a26f8bfe143142d299ffe1709f98ceafff5ba3d6` | 13/13 SUCCESS, 5/5 pass | none; 0 behind dev |
| PR #4006 | LAND_AS_IS | Real hashless-journal data-loss defect; RED (8 fail) -> GREEN (34 pass), plus 58 collateral and 57 injection assertions green | `ffdd705561330424b65ddd4cdee2f49ff27d6366` | 18 SUCCESS + 2 CANCELLED superseded; 5/5 pass | shares `tests/clients/client-connect.test.ts` with #4004 |
| PR #3997 | LAND_AS_IS (needs `maintainer-sponsored`) | Real Pool-cooldown defect; RED (3 fail) -> GREEN (87 pass). Hygiene failure is the `unsponsored_surface` policy row, not a defect | `094e509f042f573cf4104d91562c249b2310cb0c` | 15 SUCCESS + `hygiene` FAILURE + `enforce-target` FAILURE (`unsponsored_surface`) | overlaps #4025; stacks clean |
| PR #4025 | LAND_AS_IS (needs `maintainer-sponsored`) | Real startup policy-binding gap; RED (15 fail) -> GREEN (31 pass). Same policy row, two restricted files | `6c1387dc460c456a17f8808607ca4cb9fcd5cbfc` | 8 SUCCESS + 2 `hygiene` FAILURE + 2 `enforce-target` FAILURE + CANCELLED | overlaps #3997; apply #3997 first |
| PR #4036 | DEFER | Reverses two shipped Windows reclaim fixes (`933f3e6e7`, `92b121436`) and inverts their regression assertions; the tradeoff is a maintainer decision | `a4a87b70f4d865af53892733560b23b6dd23e792` | 13 SUCCESS + 3 CANCELLED; 5/5 pass | clean mechanically; conflicts semantically with the Windows reclaim invariant |
| Issue #4003 | CLOSE (on #4004 merge) | Fully addressed by #4004; defect confirmed real on dev | — | — | — |
| Issue #4005 | CLOSE (on #4006 merge) | Fully addressed by #4006; 8 of its claims proven RED on dev | — | — | — |
| Issue #3996 | CLOSE (on #3997 merge) | Addressed by #3997 only. NOT fixed by #4010/#4011, which are 2.48.0 release promotions | — | — | — |

Nothing in this lane is CLOSE-now, REIMPLEMENT, or LAND_WITH_FIX. The three issues close as a consequence of merging their PRs.

---

## PR #4039 — fix(codex): retain overlapping multiline TOML terminators — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4039
- Head `7ce4dac80b5cc81e9f1eb1a9dbb4751f8dbe544c`; base `dev`; `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED` (review requirement only), `isDraft=false`, labels `bug`, `review-ready`.
- CI at head: all 17 `statusCheckRollup` entries SUCCESS; `gh pr checks 4039` = 5 pass / 0 fail.
- Files: `src/codex/project-config-warnings.ts` (+3/-1), `tests/codex-integration/project-config-warnings.test.ts` (+43/-0), two lifecycle docs.

**The defect is real on current dev.** `/tmp/ocx-249.xGQnxl/wt/src/codex/project-config-warnings.ts:72`:

```
    index = line.indexOf(delimiter, index + delimiter.length);
```

inside the loop opened at `project-config-warnings.ts:65`:

```
  let index = line.indexOf(delimiter, from);
```

When a rejected `"""` is preceded by an odd backslash run, the scan resumes `delimiter.length` (3) characters past the rejected position, so a real terminator that *overlaps* the rejected one — a backslash followed by four quotes — is skipped. The parser then treats the remainder of the file as multiline string body and silently loses every bypass diagnostic after it. The fix resumes at `index + 1`, keeping overlapping candidates.

**Proof.** In the scratch worktree at dev `7dc7dc99e`, applying only `tests/`: `bun test tests/codex-integration/project-config-warnings.test.ts` -> **22 pass / 4 fail**, failing exactly `overlapping multiline terminator preserves {root override, same-line string, selected profile, selected provider table} diagnostics`. Adding the `src/` hunk -> **26 pass / 0 fail / 60 expect() calls**.

**Conflicts:** none. `git apply --check` clean (strict and `--3way`); `git merge-tree --write-tree --name-only 7dc7dc99e refs/prheads/4039` -> tree `3d92a00e6bdc92d8364d3c5552c7b56763ccfa21`, no conflict paths. 0 commits behind dev.

`multilineCloseIndex` has no other caller depending on the skip distance, so the blast radius is the diagnostic path only.

---

## PR #4034 — fix(codex): share trigger-only delegation guidance with v1 — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4034
- Head `eb835fe335c3449d08cb3183606d1cefc2230bc4`; `isDraft=false`, labels `bug`, `review-ready`.
- CI at head: 12 SUCCESS; one `enforce-target` CANCELLED (`https://github.com/lidge-jun/opencodex/actions/runs/34233287123/job/102086351603`) superseded by a later SUCCESS run. `gh pr checks` = 5 pass / 0 fail.

**The duplication is real on dev.** `/tmp/ocx-249.xGQnxl/wt/src/server/responses/collaboration.ts:236` hard-codes its own copy:

```
export const PROACTIVE_MULTI_AGENT_MODE_TEXT = [
  "Proactive multi-agent delegation is active.",
  "Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
```

while the canonical text lives at `/tmp/ocx-249.xGQnxl/wt/src/codex/multi-agent-mode-policy.ts:1-11`, `revision: "proactive-trigger-v1"`, with the narrower wording "Only the delegation trigger changes... All existing user, authority, task-scope, and collaboration-tool rules continue to apply."

The dev v1 string is byte-identical to the second entry of `LEGACY_OPENCODEX_MODE_HINTS` at `multi-agent-mode-policy.ts:14-16` — v1 currently emits text that the policy module itself classifies as legacy and upgradeable. The PR points `PROACTIVE_MULTI_AGENT_MODE_TEXT` at `MULTI_AGENT_MODE_HINT_RECOMMENDATION.text`.

**Proof.** Tests-only apply on dev -> **60 pass / 3 fail**: `v1 max uses the trigger-only proactive recommendation`, `v1 ultra uses the trigger-only proactive recommendation`, and `injectDeveloperMessage > upgrades historical v1 wording once and preserves replayed guidance`. With `src/` -> **63 pass / 0 fail / 241 assertions**.

**Downstream consumer checked.** `/tmp/ocx-249.xGQnxl/wt/tests/server/server-combo-failover-e2e.test.ts:2285` imports `PROACTIVE_MULTI_AGENT_MODE_TEXT` and rebuilds the tag from the export rather than a literal, so it follows the change: that suite ran **144 pass / 0 fail** with the patch applied.

Worth naming what a maintainer accepts: v1 clients at `max`/`ultra` now receive the narrower trigger-only text. That is the same text v2 and the dashboard already send, so this converges the surfaces rather than introducing new behavior, which is why the verdict is LAND_AS_IS rather than DEFER.

**Conflicts:** none; merge-tree tree `02a368c24a759b595a2c17177e71f6d417aedcf5`. 22 behind dev, applies clean.

---

## PR #4015 — test: stabilize Windows fixture waits and case cleanup — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4015 — head `4141281b14cc7dad3e3a8b06b727ae4b2ec42ac0`, `isDraft=false`, labels `chore`, `review-ready`.
- CI at head: all 20 rollup entries SUCCESS; 5/5 checks pass.
- Files: `tests/codex-integration/codex-retained-root-serialization.test.ts` (+54/-19), `tests/server/server-xai-responses-streaming.test.ts` (+74/-8). **Test-only.**

Verified on the merge result: **13 pass / 0 fail / 101 assertions** across both files.

This is the PR that repairs the two fixture races #4006's CI hit — double stdout consumption in the retained-root fixture, and a timed-out xAI case leaking into the next case's fetch mock — so it should land ahead of #4006 for a clean signal.

**Conflicts:** none; merge-tree tree `1d3a30374ecd638cb02222fc1a3db367d0b9306e`.

---

## PR #4014 — test(codex): hold prompt-probe admission through document edits — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4014 — head `50929c1008f382fa4f47edcc34ad4cabe24b8403`, `isDraft=false`, `review-ready`.
- CI at head: 13/13 SUCCESS; 5/5 checks pass.
- Files: `tests/codex-integration/codex-prompt-route.test.ts` (+178/-136). **Test-only.**

Verified on the merge result: **75 pass / 0 fail / 851 assertions**, including `40. editing a SKILL.md manifest invalidates an in-flight text probe`. No runtime file is touched, so there is no dev-behavior claim to disprove.

**Conflicts:** none; merge-tree tree `6d9883014af551616f1e29fda477a3058e21db9c`.

---

## PR #4012 — test(codex): verify timeout termination without racing child timers — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4012 — head `59a390c7406e7910cb81ce4fbd1a5a436c16f41f`, `isDraft=false`, `reviewDecision=APPROVED`, `mergeStateStatus=UNSTABLE`.
- Files: `tests/codex-integration/native-profile-processes.test.ts` (+14/-22). **Test-only.**

### The one FAILURE at head: which job, and whether it is real

**Job: `hygiene`**, run `34207070507`, job `101998940221` — https://github.com/lidge-jun/opencodex/actions/runs/34207070507/job/101998940221

**It is infrastructure, not a regression.** The job log's own failure payload shows the hygiene evaluation succeeded and the crash came from posting the result. The comment body being written contains:

```
'✅ **Deterministic PR hygiene checks passed.**\n' +
```

and the throw is an HTTP 502 from the GitHub comment API:

```
    url: 'https://api.github.com/repos/lidge-jun/opencodex/issues/comments/5582122641',
    status: 502,
    data: { message: 'Server Error' }
```

There is no `##[error]PR hygiene failed: <code>` line in this job — contrast #4025 and #3997 below, which both terminate with `##[error]PR hygiene failed: unsponsored_surface`. The workflow calls `updateComment` with `retries: 0`, so one transient 502 fails the job after the check has already passed. Every other check at this head is SUCCESS (12/12), and `gh pr checks 4012` reports 5 pass / 0 fail.

Re-running `hygiene` clears it; no code change is warranted.

**Proof of the test change.** On the merge result, `bun test tests/codex-integration/native-profile-processes.test.ts` -> **9 pass / 0 fail / 24 assertions**, including `kills and settles a timed-out child`. The change replaces a wall-clock marker assertion with the termination error's `SIGKILL` signal and `killed` flag, which is the correct repair for a timer race rather than a masked retry.

**Conflicts:** none; merge-tree tree `03b6f8ae846e8568c8d45ddff5c3399d0a332461`.

---

## PR #4004 — test(clients): bound transaction fixture child completion — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4004 — head `9809dc4d62ab78626674f05a2a428ec303ed43f3`, `isDraft=false`, `reviewDecision=APPROVED`, `mergeStateStatus=UNSTABLE`.
- CI at head: all 17 rollup entries SUCCESS; 5/5 checks pass.
- Files: `tests/clients/client-connect.test.ts` (+106/-19). **Test-only.**
- Body states `Closes #4003`.

Verified on the merge result: **49 pass / 0 fail / 257 assertions**. The change bounds the `spawnSync` child with the existing 15-second budget and `SIGKILL`, rejects spawn errors, nonzero exits and signals before parsing output, and removes both temporary homes on failure — matching the gap described in issue #4003.

**Conflicts:** shares `tests/clients/client-connect.test.ts` with **#4006** (+8/-1 there). Both merge cleanly against dev independently; ordering below.

---

## PR #4041 — test(lib): make idle deadline reset timing deterministic — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4041 — head `9aa3e9204c12c1bbd9068e77115501e16203bb60`, `isDraft=true`, label `chore`. 0 commits behind dev.
- CI at head: 13/13 SUCCESS; 5/5 checks pass.
- Files: `tests/lib/abort-idle-deadline.test.ts` (+52/-11). **Test-only.**

The dev test drives `idleDeadline(120, ...)` through four real `await sleep(40)` resets, which fails whenever a loaded runner lets a 40 ms sleep resume past the 120 ms window. The PR converts only that one boundary case to a controlled `setTimeout`/`clearTimeout` fake, restores both spies in `finally`, and leaves the other five cases on Bun's real timers.

Verified: **6 pass / 0 fail**, with the converted case at 0.23 ms instead of roughly 380 ms of real sleeping.

This is the exact flake that failed #4036's contributor CI — its body cites `tests/lib/abort-idle-deadline.test.ts` reset/postpone at 432.21 ms — so landing #4041 early removes a known source of false reds for the rest of the train.

**Conflicts:** none; merge-tree tree `3fbe024519b6f014ea132e34172429eda5d53e2b`. Draft status is the only gate.

---

## PR #4043 — fix(cli): reject unsupported caps and report ignored legacy values — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4043 — head `a26f8bfe143142d299ffe1709f98ceafff5ba3d6`, `isDraft=true`, label `bug`. 0 commits behind dev.
- CI at head: 13/13 SUCCESS; 5/5 checks pass.
- Files: `src/cli/effort.ts` (+24/-8), `tests/cli/cli-effort.test.ts` (+126/-0), two agents docs, `structure/03_catalog-and-subagents.md`.

**The defect is real on dev.** `/tmp/ocx-249.xGQnxl/wt/src/cli/effort.ts:36` validates all three fields through one predicate:

```
function validateEffortLevel(level: string | null | undefined, label: string): string | null | undefined {
```

and `src/cli/effort.ts:40` accepts whatever `isDeclaredReasoningEffort` allows, which by `/tmp/ocx-249.xGQnxl/wt/src/reasoning-effort.ts:39-41` includes both sentinels:

```
export function isDeclaredReasoningEffort(effort: string): boolean {
  return effort === "none" || effort === "minimal" || CODEX_REASONING_SET.has(effort);
}
```

The enforcement layer honors only ladder members. `/tmp/ocx-249.xGQnxl/wt/src/server/effort-policy.ts:48-49`:

```
  if (config.effortCap && isCodexReasoningEffort(config.effortCap)) caps.push(config.effortCap);
  if (subagent && config.subagentEffortCap && isCodexReasoningEffort(config.subagentEffortCap)) {
```

So `ocx effort set --main none` is accepted and persisted, then silently ignored at request time: the user believes a cap is set and no cap applies. The fix validates caps with `isCodexReasoningEffort` while keeping `--injection` on the looser `isDeclaredReasoningEffort`, which is correct — `none`/`minimal` are meaningful for injection per `reasoning-effort.ts:33-38`, and `src/config.ts:2163` already validates `injectionEffort` separately. Already-stored invalid values are surfaced through a new `warnings` array rather than rewritten.

**Proof.** Tests-only on dev -> **21 pass / 16 fail**, including `rejects unsupported cap none through --main before probing or saving` and `an ignored subagent cap warning preserves the valid main cap`. With `src/` -> **37 pass / 0 fail / 170 assertions**.

`warnings` is a new JSON field rather than a changed one, so existing consumers are unaffected. Legacy stored values are preserved and reported rather than normalized.

**Conflicts:** none; merge-tree tree `3cb38ec198ac06d7321e587c4caadec76a492073`.

---

## PR #4006 — fix(codex): preserve settings when journal injection hashes are missing — LAND_AS_IS

- URL: https://github.com/lidge-jun/opencodex/pull/4006 — head `ffdd705561330424b65ddd4cdee2f49ff27d6366`, `isDraft=true`, label `bug`.
- CI at head: 18 SUCCESS + 2 CANCELLED (`label`, `enforce-target`, superseded); `gh pr checks` 5 pass / 0 fail.
- Files: 17 total — `src/codex/journal.ts` (+61/-12), `src/codex/inject.ts` (+29/-11), three collateral test files, `tests/codex-integration/codex-journal.test.ts` (+234/-6), eight locale guides, two lifecycle refs, `structure/02_config-and-codex-home.md`.
- Body states `Closes #4005`.

**The defect is real and it is data loss.** A journal with no recorded injected-state hash causes `restoreJournalState()` to treat the current artifact as unchanged and write the saved original over it. Applying only `tests/` on dev reproduces **eight** distinct failures:

```
(fail) codex-journal > hashless interrupted snapshot preserves later native config edits
(fail) codex-journal > hashless interrupted snapshot preserves a later profile
(fail) codex-journal > hashless already-original snapshot completes without rewriting config
(fail) codex-journal > hashless snapshot distinguishes an empty original profile from absence
(fail) codex-journal > hashless native restore refuses instead of reporting an uncertain snapshot as restored
(fail) codex-journal > hashless routed snapshot is not promoted by reinjection after user edits
(fail) codex-journal > hashless empty config snapshot does not recreate a later deleted file
(fail) codex-journal > hashless client reconcile does not report an uncertain snapshot as restored
```

(26 pass / 8 fail on dev.) These are user config overwrite and profile deletion, plus the reinjection path that attaches a new injected hash to an old retained original — the state that would later make a bad restore look verified.

**Proof of fix, and of no collateral damage.** With `src/` applied, `codex-journal.test.ts` -> **34 pass / 0 fail**. The three collateral fixture files the PR also updates (`tests/cli/cli-start-journal-order.test.ts`, `tests/clients/client-connect.test.ts`, `tests/codex-integration/codex-catalog-restore.test.ts`) -> **58 pass / 0 fail**. The untouched injection suites `codex-inject-integration.test.ts` + `codex-inject-write-lock.test.ts` -> **57 pass / 0 fail**, covering changed profiles, user edits, CRLF, managed defaults, external-provider opt-out and held-lock behavior.

**The legacy behavior change is real and should be stated at merge.** Hashless journals no longer authorize whole-file restoration of differing content; such a restore returns an explicitly unverified result and keeps both the file and the journal. The failure mode it trades into is a retained journal rather than a cleaned-up one. Given the alternative is silently destroying user config, this is the right direction, and verified-hash journals keep identical behavior. This is the one judgment call in the PR; I rate it decidable without product direction.

**Conflicts:** merge-tree tree `d057a1fd445829dc66df9adb9e8daae1beaec926`, clean. Overlaps #4004 on `tests/clients/client-connect.test.ts`.

---

## PR #3997 — fix(codex): fall back to caller main during Pool cooldown — LAND_AS_IS, needs `maintainer-sponsored`

- URL: https://github.com/lidge-jun/opencodex/pull/3997 — head `094e509f042f573cf4104d91562c249b2310cb0c`, `isDraft=true`, labels `bug`, `intake: hygiene-blocked`.
- Files: `src/codex/auth-context.ts` (+7/-0), `tests/codex-integration/codex-auth-context.test.ts` (+39/-0), `tests/codex-integration/main-account-hard-lock-auth.test.ts` (+29/-1), two integration guides.
- Body states `Closes #3996`.

### What hygiene fails on, and whether it is a policy row or a defect

**It is a policy row, not a defect.** Both failing jobs end with the same code:

- `hygiene` — https://github.com/lidge-jun/opencodex/actions/runs/34185829859/job/101933843542 -> `##[error]PR hygiene failed: unsponsored_surface`
- `enforce-target` — https://github.com/lidge-jun/opencodex/actions/runs/34185829834/job/101933862070 -> `##[error]PR quality gate failed: unsponsored_surface`

The rule is at `/tmp/ocx-249.xGQnxl/wt/.github/scripts/pr-sponsored-surface.cjs:38`, inside `RESTRICTED_FILES`:

```
  "src/codex/auth-context.ts",
```

and the gate at `.github/scripts/pr-sponsored-surface.cjs:76-81`:

```
  if (authorHasPushPermission) return [];
  const restricted = changedFiles.filter(isRestrictedPath);
  if (restricted.length === 0) return [];
  if (hasSponsorship(labels)) return [];
  return [{ code: "unsponsored_surface", paths: restricted }];
```

`luvs01` has no push permission and the PR carries no `maintainer-sponsored` label, so touching that single file is sufficient to fail, and no code change can clear it. Per the script's own header (`pr-sponsored-surface.cjs:14-18`) this mirrors the `MAINTAINERS.md` security-review requirement. Clearing it means actually performing that review — a real obligation here, since this is a credential-selection path.

**The defect is real on dev.** `/tmp/ocx-249.xGQnxl/wt/src/codex/auth-context.ts:888`:

```
    if (!probeLeaseId) {
      throw new CodexAccountCooldownError(accountId, cooldownUntil, cooldown?.cooldownSource, cooldown?.quotaScope);
    }
```

When the selector retains the cooling-down stored account and no probe lease is free, the request is rejected locally even though a validated caller-owned main credential is present — the same credential the post-upstream-failure path is already willing to use, so successive requests behave inconsistently. The fix inserts the caller-main resolver before that throw, guarded by `requestScopedMainCredential`, `fixedAccountId === undefined` and `options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID`. Exact bindings still fail closed through the untouched guard at `src/codex/auth-context.ts:880-882`.

**Proof.** Tests-only on dev -> **84 pass / 3 fail**: `a fresh request can reuse caller main after the selected Pool account enters cooldown`, plus the `98.99%` and `99%` main-policy boundary cases. With `src/` -> **87 pass / 0 fail / 347 assertions**.

**Conflicts:** merge-tree tree `6d829d18089cb0562723d56d095cfc0c1d3a2dc9`, clean against dev. Overlaps #4025; stacking verified below.

---

## PR #4025 — fix(codex): restore main policy binding after owned startup — LAND_AS_IS, needs `maintainer-sponsored`

- URL: https://github.com/lidge-jun/opencodex/pull/4025 — head `6c1387dc460c456a17f8808607ca4cb9fcd5cbfc`, `isDraft=true`, labels `bug`, `intake: hygiene-blocked`.
- Files: `src/codex/native-profile-startup.ts` (+72/-5), `src/codex/account-lifecycle.ts` (+29/-2), `src/codex/auth-context.ts` (+12/-3), `src/codex/auth-collision.ts` (+3/-2), `tests/codex-integration/main-account-hard-lock-auth.test.ts` (+124/-0), `tests/helpers/main-account-policy-startup-child.ts` (+292/-0, new), `structure/08_openai-provider-tiers.md`, two providers-accounts docs.

### What hygiene fails on

**The same policy row as #3997, and again not a defect.**

- `hygiene` — https://github.com/lidge-jun/opencodex/actions/runs/34233090429/job/102083851611 -> `##[error]PR hygiene failed: unsponsored_surface`
- `enforce-target` — https://github.com/lidge-jun/opencodex/actions/runs/34233090421/job/102086314639 -> `##[error]PR quality gate failed: unsponsored_surface`

This PR trips **two** restricted rows, both in `RESTRICTED_FILES`: `.github/scripts/pr-sponsored-surface.cjs:37` (`"src/codex/auth-collision.ts"`) and `:38` (`"src/codex/auth-context.ts"`). Resolution is identical: maintainer security review plus the `maintainer-sponsored` label.

**The defect is real on dev.** Applying only the PR's test files to dev `7dc7dc99e` gives **16 pass / 15 fail** in `tests/codex-integration/main-account-hard-lock-auth.test.ts`. The entire `fresh startup restores durable main policy only after owned recovery` matrix fails across all 15 scenarios: `owned-99`, `owned-98`, `recovery`, `second-listener`, `invalid-access-token`, `invalid-account-id`, `invalid-id-token`, `mismatched-identity`, `renewed-listener`, `stage-retry`, `manual-recovery`, `stale-sweep`, `retained-unknown-binding`, `conflicting-token-identities`, `owned-opaque-99`. With `src/` applied -> **31 pass / 0 fail / 299 assertions**.

The runtime change adds a read-only fence: during an owned startup with the hard lock on and the memory-only policy binding not yet established, a request-owned main pin candidate raises `CodexMainProfileDrainingError` instead of proceeding on unestablished equality. The `auth-collision.ts` change is a narrow signature widening — `readCodexTokensResult(authPath = join(resolveCodexHomeDir(), "auth.json"))` — so an already-owned lifecycle can pass its pinned path rather than re-resolving the ambient home; the default preserves every existing caller exactly.

**Conflicts:** merge-tree tree `7e7b5ff9a23668922a0f8e39304c6aeeb47824cd`, clean against dev.

**Stacking with #3997 verified.** `git merge-tree --write-tree refs/prheads/3997 refs/prheads/4025` -> `1c20633871c2ef20ad6b3c17ceb785e3d39141d0`, exit 0, no conflict. Applied sequentially in the scratch worktree (#3997 then #4025, both `git apply` exit 0), the combined result runs `main-account-hard-lock-auth.test.ts` + `codex-auth-context.test.ts` -> **104 pass / 0 fail**. The two edits sit in different regions of `auth-context.ts`: #3997 at the cooldown throw near line 888, #4025 at the pin-candidate computation near line 598 and the Direct branch near line 618.

---

## PR #4036 — fix(server): honor rejected identity checks during port reclaim — DEFER

- URL: https://github.com/lidge-jun/opencodex/pull/4036 — head `a4a87b70f4d865af53892733560b23b6dd23e792`, `isDraft=true`, label `bug`. 0 commits behind dev.
- CI at head: 13 SUCCESS + 3 CANCELLED (`label`, two `enforce-target`, superseded); `gh pr checks` 5 pass / 0 fail.
- Files: `src/server/port-reclaim.ts` (+8/-26), `tests/server/port-reclaim.test.ts` (+67/-36), `structure/01_runtime.md`, two lifecycle docs.

**This is not a defect fix; it is a deliberate policy reversal, and it needs the maintainer.**

The PR deletes the branch at `/tmp/ocx-249.xGQnxl/wt/src/server/port-reclaim.ts:231-249`:

```
        // Pre-update PIDs can fail verify while still LISTENing (dead owner still
        // listed, or cmdline probe raced). Allowlisted teardown PIDs may be killed;
        // unknown foreign claimants must remain fail-closed.
        if (!isOcx) {
          if (mayKill && allowlisted) {
```

That branch was added on purpose by two shipped commits, each from an observed Windows failure:

- `933f3e6e7` "fix(update): reclaim allowlisted PIDs that fail ocx identity mid-teardown" — "Windows can keep a dead pre-update LISTEN owner listed after the cmdline probe fails; treating it as foreign blocked SetTcpEntry and left :10100 unbindable."
- `92b121436` "fix(update): reclaim npm-rename respawns that fail ocx identity" — "During npm install -g Windows can respawn from @bitkyc08/.opencodex-* which failed verifyPidIdentity and blocked port reclaim as a foreign holder."

The PR's test diff inverts the assertions those commits introduced. The dev test at `/tmp/ocx-249.xGQnxl/wt/tests/server/port-reclaim.test.ts:528` is renamed and flipped:

```
-  test("allowlisted PID that fails ocx verify still gets killed and does not block TCP drop", async () => {
+  test("allowlisted PID that fails ocx verify stays protected until the deadline", async () => {
...
-    })).resolves.toBe(true);
-    expect(killed).toEqual([14772]);
-    expect(dropped).toEqual([10100]);
+    })).resolves.toBe(false);
+    expect(killed).toEqual([]);
+    expect(dropped).toEqual([]);
```

The same inversion is applied to `allowlisted revalidation failure still permits TCP drop after kill` and `allowlisted pid with failing ocx revalidation is still killed`.

**Why the author's "dead ghost" argument does not fully cover it.** The new comment claims "Dead ghost owners have already been skipped by the liveness check above", and for a genuinely dead PID that is true — `src/server/port-reclaim.ts:222` returns early on `!isAliveFn(pid)`. But `92b121436`'s case is a **live** process: an npm-rename respawn under `@bitkyc08/.opencodex-*` that is alive and listening while `verifyPidIdentity` rejects its cmdline. After this PR that process is classified `foreignLive`, is never killed, and blocks `SetTcpEntry` for the entire window — the exact symptom `92b121436` was written to remove. `verifyPidIdentity` at `/tmp/ocx-249.xGQnxl/wt/src/config/process-state.ts:221-228` rejects via `isLikelyOcxStartProcess`, a cached cmdline probe that can legitimately fail on a renamed tree.

No escape hatch remains: `killAnyListenPidOnPort` was removed by `aa660dc0c` and is now actively forbidden at `/tmp/ocx-249.xGQnxl/wt/tests/windows/windows-deploy-close-regressions.test.ts:47`:

```
    expect(src).not.toContain("killAnyListenPidOnPort");
```

So with this PR there is no path that reclaims a live, allowlisted, verify-failing holder.

**The PR is internally sound.** Applied whole, `bun test tests/server/port-reclaim.test.ts` -> **28 pass / 0 fail / 70 assertions**; the caller control `tests/lib/process-control-graceful.test.ts` -> **7 pass / 0 fail**. It merges clean (merge-tree tree `98305205f13e02f3312a97794a0146cb08069a49`, 0 behind dev) and typechecks. The author is explicit in the body: "This intentionally favors retaining an unverified holder over reclaiming its port."

**DEFER because the choice is a product decision.** It is between a Windows update that cannot rebind its configured port — the regression `933f3e6e7`/`92b121436` fixed — and a live unverified holder that can be terminated because its PID appeared in a teardown snapshot. Both are defensible; only the maintainer owning the Windows update path should pick. Its CI evidence is also not clean on its own terms: the body records an unresolved Windows 5/6 failure in `codex-cli-update-zero-effect.test.ts` with a retry still pending, and the PR is draft with 2 of 4 readiness boxes unticked.

If the maintainer wants this direction, the bounded alternative is to keep the allowlisted-kill branch for live holders and require verifier acceptance only before the TCP row drop. That is a different change, so it is not offered as LAND_WITH_FIX here.

---

## Issue #4003 — Client transaction test fixture has no child timeout or failure cleanup — CLOSE on #4004 merge

- URL: https://github.com/lidge-jun/opencodex/issues/4003 — OPEN, author `luvs01`, label `bug`, created 2026-09-08.
- Cross-referenced by: **#4004 (OPEN)** only.

Not fixed on dev — the fixture's unbounded `spawnSync` is still present, which is what makes #4004's regression meaningful. Not a duplicate. Fully covered by #4004, which states `Closes #4003` and whose merge result runs 49 pass / 0 fail. No product judgment needed.

PRs here target `dev` and GitHub auto-closes only on merge to the default branch, so this must be closed manually once #4004 lands (per `AGENTS.md`, "Issues and pull requests (agents)").

Suggested closing comment:

> Fixed on `dev` by #4004, which bounds the transaction fixture child with the existing 15-second budget and `SIGKILL`, rejects spawn errors, nonzero exits and signals before parsing output, and removes both temporary homes when the child or its output fails. Closing manually because pull requests here target `dev` rather than the default branch.

## Issue #4005 — Hashless Codex journal can overwrite later settings and become trusted on reinjection — CLOSE on #4006 merge

- URL: https://github.com/lidge-jun/opencodex/issues/4005 — OPEN, author `luvs01`, label `bug`.
- Cross-referenced by: **#4006 (OPEN)** only.

Confirmed real on dev and not a duplicate: eight of the issue's claims reproduce as failing tests against unmodified dev source (listed in the #4006 section), including the two it leads with — later native config edits overwritten, and a later profile deleted. #4006 states `Closes #4005` and turns all eight green.

The issue references #2948 but explicitly scopes itself narrower ("does not establish the cause of that historical machine's shutdowns"), so closing this does not close #2948.

Suggested closing comment:

> Fixed on `dev` by #4006. A journal without recorded injected-state hashes no longer authorizes whole-file restoration: a changed config or profile lacking its own injection hash is preserved along with the journal, the restore reports an explicitly unverified result through native restore and reconcile, and routed reinjection verifies the retained snapshot before writing. All eight reported cases are covered by regressions that fail against the previous source. Closing manually because pull requests here target `dev`.

## Issue #3996 — Fresh requests can reject a cooled-down Pool before using their valid main credential — CLOSE on #3997 merge

- URL: https://github.com/lidge-jun/opencodex/issues/3996 — OPEN, author `luvs01`, labels `bug`, `account-pool`.
- Cross-referenced by: **#3997 (OPEN)**, **#4010 (MERGED)**, **#4011 (MERGED)**, **#4012 (OPEN)**.

**The two merged cross-references do not fix it — do not close on their basis.** #4010 ("release: promote 2.48.0 to preview") and #4011 ("release: promote 2.48.0 to main") are release promotions of candidate `7797586a8899c673eab48886a490e85b480c6d72`; their file lists are the whole `origin/main..origin/dev` delta, which is why this issue appears cross-referenced. #4011's body states its tree is byte-identical to the candidate. Neither carries a fix for this branch. #4012 is the unrelated native-probe timeout test.

**Still broken on dev**, at `/tmp/ocx-249.xGQnxl/wt/src/codex/auth-context.ts:888` (quoted in the #3997 section). #3997 states `Closes #3996` and is the only PR addressing it; its regression fails on dev and passes with the fix.

The issue is correctly distinguished from #3973 (manual reset-credit reconciliation) and #3738 (strict-quota policy) by its own text, so it is not a duplicate of either. Decidable without product judgment, but its PR needs sponsorship first.

Suggested closing comment, to post only after #3997 lands:

> Fixed on `dev` by #3997, which reuses the existing caller-owned-main resolver when the selected stored Pool account is cooling down and no recovery probe lease is available. Exact account bindings, model entitlement checks, the main quota policy, Pool selection and cooldown state are all preserved. Closing manually because pull requests here target `dev`.

---

## Shared files / stack order

### Shared-file overlaps inside Lane A

| file | PRs | note |
|---|---|---|
| `src/codex/auth-context.ts` | **#3997**, **#4025** | Different regions (cooldown throw vs. pin candidate + Direct branch). `merge-tree 3997 x 4025` = `1c20633871c2ef20ad6b3c17ceb785e3d39141d0`, no conflict; sequential apply verified, combined 104 pass / 0 fail |
| `tests/codex-integration/main-account-hard-lock-auth.test.ts` | **#3997** (+29/-1), **#4025** (+124/-0) | Same clean-stack evidence |
| `tests/clients/client-connect.test.ts` | **#4004** (+106/-19), **#4006** (+8/-1) | #4006 adds injected-config hashes to a fixture; #4004 rewrites the transaction helper. Clean against dev individually; land #4004 first |
| `docs-site/.../reference/cli/lifecycle.md` (en + ko) | **#4039**, **#4036**, **#4006** | Each appends its own paragraph. #4036 is DEFER, so only #4039 and #4006 matter; both applied together cleanly |
| `docs-site/.../guides/codex-integration.md` (en + ko) | **#4006** (8 locales), **#3997** (en + ko) | Different sections; no conflict observed |
| `structure/03_catalog-and-subagents.md` | **#4043**, **#4034** | Different sections (effort ladder vs. v1 delegation); applied together cleanly |

No other Lane A pair shares a path. Each of the twelve heads independently produced `git merge-tree --write-tree` exit 0 with no conflict paths against `7dc7dc99e`, and `git apply --check` exit 0 both strict and `--3way`.

### Combined verification actually performed

- #4039 + #4043 + #4034 + #4006 + #4036 applied together on dev: `bun x tsc --noEmit` -> **exit 0, zero diagnostics**.
- #3997 + #4025 applied together: **104 pass / 0 fail** across both auth test files.

### Recommended stack order

Two independent stacks; nothing crosses between them.

**Stack A — no sponsorship needed (9 PRs).** Ordered so fixture-determinism repairs precede the PRs whose CI they stabilize:

1. **#4041** — idle-deadline fake timers. First: it removes the flake that already produced a false red elsewhere in this train. 0 behind dev.
2. **#4015** — Windows retained-root + xAI streaming fixtures. Second: it fixes the two races #4006's CI hit.
3. **#4012** — native-probe timeout race. Re-run `hygiene` to clear the 502 before merging; no code change.
4. **#4014** — prompt-probe admission. Independent, test-only.
5. **#4004** — client transaction child bound. Must precede #4006 (shared file). Closes #4003.
6. **#4039** — TOML terminator. 0 behind dev, review-ready, non-draft.
7. **#4043** — effort cap validation. 0 behind dev; needs draft lifted.
8. **#4034** — v1 delegation guidance. Non-draft, review-ready.
9. **#4006** — hashless journal. After #4004 and #4015. Closes #4005. Needs draft lifted.

#4039, #4034, #4014, #4015, #4004 and #4012 are already non-draft; #4041, #4043 and #4006 are drafts whose only blocker is the readiness checklist.

**Stack B — requires maintainer security review plus `maintainer-sponsored` (2 PRs), strictly ordered:**

1. **#3997** — smaller (7 production lines), one restricted file. Closes #3996.
2. **#4025** — larger, two restricted files. After #3997; verified conflict-free in that order.

Both are blocked only by `unsponsored_surface`, which no code change can clear. Sponsoring them means performing the `MAINTAINERS.md` security review of the credential-selection paths, not merely applying the label.

**Deferred:** **#4036**, returned to the maintainer for the Windows reclaim policy decision above.

### Closeout arithmetic for this lane

11 PRs land (9 in Stack A, 2 in Stack B), 3 issues close as a consequence, 1 PR defers: **14 items removed** from the open backlog if Stack B is sponsored, **12** if only Stack A lands.
