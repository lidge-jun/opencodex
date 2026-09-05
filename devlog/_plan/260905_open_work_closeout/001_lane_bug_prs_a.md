# Lane A — bug-labelled PRs (#3529, #3525, #3524, #3519, #3515, #3502, #3490)

READ-ONLY adversarial review. Worktree `/private/tmp/ocx-closeout.xomWAA/wt`, detached at
`0f27bbeb3ce6a92077652695e161d49b88eedc7a` (= `origin/dev` at review time; index re-read
immediately before verdict, unchanged). No src/tests/gui file was left modified: every patch
applied during verification was reverted and `git status --porcelain` shows only this new
devlog directory.

## Summary

| Item | Disposition | One-line reason |
| --- | --- | --- |
| #3515 | LAND_AS_IS | Only fully-green, review-ready, maintainer-approved item; two regressions distinguish 499 caller-cancel from 502 upstream reset. |
| #3529 | LAND_AS_IS | 3 tests proven RED on dev and GREEN with the fix; core/lab boundary still passes; draft checklist is the only gate. |
| #3525 | LAND_AS_IS | 6 tests proven RED on dev, GREEN with the fix, full exact-head CI green; one stale docs line is the sole nit. |
| #3490 | LAND_AS_IS | TOML table-header comment bug independently reproduced RED, fixed GREEN, and the existing consumer suite stays green. |
| #3502 | LAND_WITH_FIX | All three src defects still live on dev, but CONFLICTING with dev and its docs prose contradicts #3520 that already landed. |
| #3519 | LAND_WITH_FIX | Both reviewer blockers are genuinely fixed on the new head, but the behavior change ships with no docs-site update. |
| #3524 | REIMPLEMENT | New unguarded startup `throw` reproduced live: a config removed between load and reconcile crashes `startServer`. |

### Stack order (shared files)

```
src/server/responses/core.ts   : #3515 (2 lines, ~4922) <-> #3502 (~3364/6693)  -> land #3515 first, trivially separable
config persistence (mutatePersistedConfig) : #3529 and #3524 use the same helper in different modules -> no textual conflict
```

No two items in this lane touch the same function. The only real ordering constraint is
`src/server/responses/core.ts`, where #3515 and #3502 edit regions ~1,500 lines apart.

---

## #3515 — fix(responses): keep caller cancellations out of upstream failure logs

- Head `4f09faf5d3e08275476b31f4b6a8ed30d04a8a66`, base `dev`, MERGEABLE / BLOCKED,
  `REVIEW_REQUIRED` (branch protection needs a second approval), not draft,
  labels `bug` + `review-ready`, gate 4/4 ticked.
- CI on that exact head: fully green — `gates`, `storage policy`, `api usage`, all four
  `test N/4` shards, both macOS shards, three `keyring` jobs, three `npm-global` jobs,
  `react-doctor`, `enforce-target`, `hygiene`. CodeRabbit completed, `Ingwannu` APPROVED.
- Conflicts: none. `git apply --check` clean against `0f27bbeb3`.

**Defect (still live on dev).** `startBoundedInspectionPump` only learns the client is gone
through the `clientGoneSignal` listener registered at
[relay.ts:1269](/private/tmp/ocx-closeout.xomWAA/wt/src/server/relay.ts:1269), and the pump's
`catch` at [relay.ts:1313](/private/tmp/ocx-closeout.xomWAA/wt/src/server/relay.ts:1313)
classifies a read rejection as an upstream fault whenever `clientGone` is still false. Bun can
settle the fetch-body read before dispatching all abort listeners, so a caller abort lands in
that branch and reaches `options.onReadError?.()`. Compounding it,
[core.ts:4925](/private/tmp/ocx-closeout.xomWAA/wt/src/server/responses/core.ts:4925) passes
only `clientGone.signal` and never the inbound request's `options.abortSignal`, which is
available on the same object (`abortSignal` is used at core.ts:1814, 1848, 1906). Result: a
client cancel logs 502 and increments the account pool failure streak.

**Test evidence.** Yes — two paired regressions in `tests/server-auth.test.ts`: *"native
passthrough caller abort logs cancellation without penalizing the pool"* (asserts 499,
`closeReason: "client_cancel"`, `consecutiveFailures === 0`) and its negative twin *"native
passthrough upstream reset still logs 502 and penalizes the pool"* (asserts 502,
`streamAborted: true`, `consecutiveFailures === 1`). The second is what makes the pair
meaningful: it proves the fix narrows classification rather than suppressing 502 wholesale.

**Blockers.** None found. No Node-only API; `AbortSignal.any` is already used in eight runtime
modules (`hub-relay.ts:249`, `fetch-helpers.ts:184`, `gcp-adc.ts:204`). No credential or
body logging. The `core.ts` edit is 4 lines inside the native-tee branch and does not import
`src/lab/`. Docs updated (`proxy-formats.md`). The one CodeRabbit nit (poll for the log entry
instead of asserting immediately) was addressed before the approval.

**Disposition: LAND_AS_IS.** Highest-confidence item in the lane.

---

## #3529 — fix(providers): rebase key failover on persisted state

- Head `4f103a1e71bd8712fc31e856ca105864811d8b7f`, base `dev`, MERGEABLE / BLOCKED,
  `REVIEW_REQUIRED`, **draft**, label `bug`, checklist 0/4.
- CI on that exact head: `enforce-target`, `hygiene`, `label`, `resolve-pr` all pass.
  The full cross-platform matrix has **not** run — CodeRabbit reports "Review skipped: draft
  pull request" and the heavy jobs are draft-gated. This is the main evidence gap.
- Conflicts: none. `git apply --check` clean.

**Defect (still live on dev).** `rotateKeyOn429` mutates the request's in-memory config and
writes the whole object: `provider.apiKey = candidate.key` then
`saveConfigPreservingClaudeCode(config)` at
[key-failover.ts:219](/private/tmp/ocx-closeout.xomWAA/wt/src/providers/key-failover.ts:219).
A key deleted from the pool through the management API between request start and rotation is
resurrected by that whole-object write. Second defect: `rotateProviderTransportOn429` at
[key-failover.ts:296](/private/tmp/ocx-closeout.xomWAA/wt/src/providers/key-failover.ts:296)
spreads `{ ...routedProvider, apiKey: rotated.apiKey }`, so a concurrent edit to any other
persisted provider field is dropped on the retry.

**Test evidence — verified by execution.** Applying only `tests/` from the PR onto clean dev:

```
12 pass, 3 fail
(fail) rotateKeyOn429 > rebases over a concurrent pool edit without resurrecting a removed key
(fail) rotateKeyOn429 > ... (persist-failure case)
(fail) rotateProviderTransportOn429 > inherits routed-only backfills while persisted fields stay authoritative
        Expected: "https://api.example.com/v1"  Received: "https://registry-pinned.example/v1"
```

Adding the `src/` half turns it to **15 pass / 0 fail**. Genuinely RED on dev, GREEN with the fix.

**Blockers.** One structural risk I checked and cleared: the diff adds
`import { routedProviderConfig } from "../router"` to a module that
`src/server/responses/core.ts` and `compact.ts` import. `src/router.ts` does **not** import
`key-failover` (verified against router.ts:1-47), so no cycle. `tests/lab/core-lab-boundary.test.ts`
passes 17/17 with the patch applied, so the optional-subsystem invariant in AGENTS.md holds.
`tests/adapters/openai/openai-chat-native-policy.test.ts` and
`tests/providers/openrouter-provider-routing.test.ts` pass 52/52. Key logging remains id-only.
CodeRabbit's line-296 finding is exactly what the final `routedProviderConfig(...)` call addresses.

**Disposition: LAND_AS_IS** on the merits — the diff is correct and its tests are honestly red on
dev. Procedurally it cannot merge yet: it is draft with 0/4 boxes and has never run the full
matrix. Land after the author ticks the checklist and exact-head CI goes green.

---

## #3525 — fix(responses): expose continuation spill write health

- Head `288506dc6883fa8433cf89014e72d01c1675317d`, base `dev`, MERGEABLE / BLOCKED,
  `REVIEW_REQUIRED`, not draft, label `bug`.
- CI on that exact head: fully green across the whole matrix (`gates`, all four `test N/4`,
  both macOS shards, three keyring, three npm-global, `storage policy`, `api usage`,
  `react-doctor`). CodeRabbit: "No actionable comments". The author documented a rebase onto
  the `dev` that contains #3526 and re-ran verification.
- Conflicts: none against `0f27bbeb3`.

**Defect (still live on dev).** `spillCounters` is
`{ writes, writeFailures, readFailures }` at
[state.ts:172](/private/tmp/ocx-closeout.xomWAA/wt/src/responses/state.ts:172) — three
cumulative integers. An operator cannot tell "failed 10,000 times and is still failing" from
"failed 10,000 times an hour ago and recovered", which is precisely the #3522 Windows report
(successful spills frozen at 1,988 while failures climbed past 10,000, `/healthz` still
healthy). This is observability, not a crash fix, so it does not close #3522 by itself — the
author says so explicitly, which I count in its favor.

**Test evidence — verified by execution.** Tests-only onto clean dev: **137 pass / 6 fail**,
including *"a successful spill clears a repeated failure streak without erasing the last
failure"*, *"Windows spill reports exhausted ACL retry and recovers after a healthy runner"*,
and *"response-state management metrics keep every added field finite scalar and privacy-safe"*.
With `src/` applied, `responses-state` + `memory-watchdog` + `continuation-dedup` run
**172 pass / 0 fail**.

**Blockers.** None blocking. Privacy is handled deliberately: `classifySpillWriteFailure` walks
up to 4 `cause` levels and collapses everything to a fixed 9-member enum, so no message or path
can leak; the diff's own comment names the nested-`cause` username/path risk. New fields are
scalars on the already-authenticated `/api/system/memory`, explicitly *not* `/healthz`.
`structure/05` and the management-API reference are both updated.

One **Low** nit (non-blocking): `docs-site/.../troubleshooting/windows-memory.md` adds
"run `ocx observe memory --json`". The registry has `observe` with a `memory` subcommand
([registry.ts:237](/private/tmp/ocx-closeout.xomWAA/wt/src/cli/registry.ts:237)) and a
`memory` alias at line 264, so the command resolves — but line 264's summary reads "Alias of
`ocx n memory`" while the canonical name printed at line 237 is `observe`. That inconsistency
is pre-existing on dev, not introduced here.

**Disposition: LAND_AS_IS.**

---

## #3490 — fix(codex): diagnose invalid persistent instructions config

- Head `3fbe8a2c760016fcd7c0d8aafa0ad0fe060060a5`, base `dev`, MERGEABLE / BLOCKED,
  `REVIEW_REQUIRED`, **draft**, label `bug`, checklist 0/4.
- CI on that exact head: `enforce-target`, `hygiene`, `label`, `resolve-pr` pass; full matrix
  draft-gated and not run. CodeRabbit skipped (draft).
- Conflicts: none.

**Defect (still live on dev).** The hand-rolled TOML table matcher at
[project-config-warnings.ts:65](/private/tmp/ocx-closeout.xomWAA/wt/src/codex/project-config-warnings.ts:65)
is `/^\s*\[([^\]]+)\]\s*$/` — it does not tolerate a trailing comment. `[model_messages] # templates`
therefore fails to match, the parser never switches sections, and every key under that header is
attributed to the document root. That is a real misparse of valid TOML in a module already used by
`collectProjectCodexConfigWarnings`.

**Test evidence — verified by execution.** I applied only the new test file and the new
`legacy-config-keys.ts` module while **withholding** the one-line regex fix:

```
5 pass, 1 fail
(fail) a table header with a trailing comment does not leak fields into root
       Expected length: 0   Received length: 1
```

That isolates the regex as load-bearing. With the full patch,
`codex-legacy-config-keys` + `codex-integration/project-config-warnings` run **27 pass / 0 fail**,
so the shared-parser change does not regress its existing consumer.

**Blockers.** None. `node:fs` is fine here (`doctor.ts` and the surrounding `src/codex/`
modules already use it; the Bun-native rule targets server request paths). The read is guarded by
`existsSync` + `statSync().isFile()` and degrades to a skipped check rather than failing doctor.
The `catch` carries the repo's `no-excuse-ok` marker. Diagnostic output is a fixed string plus
the config path — no file contents echoed.

**Disposition: LAND_AS_IS** on the merits; draft/checklist and a full-matrix run are the only gates.

---

## #3502 — fix(oauth): repair post-merge 429 failover boundaries

- Head `6671a16238c464a4e650e95d97c05b6d8ab6b0f7`, base `dev`,
  **CONFLICTING / DIRTY**, `REVIEW_REQUIRED`, not draft, label `bug`.
- CI: green, but on a **stale merge base** (`2fb11f4a0`). Those results do not describe the
  current `dev`.
- 30 files (20 of them docs locales), ~530 added lines.

**Conflicting files and rebase character.** `git apply --check` per file against `0f27bbeb3`:

| File | Applies? | Character |
| --- | --- | --- |
| `src/oauth/anthropic-routing.ts` (hunk @621) | **no** | textual, from #3503 `6edc56328`; mechanical |
| `docs-site/.../reference/configuration/providers.md` + 9 locale twins | **no** | **semantic** — #3520 `5d10a1900` already rewrote this prose |
| `src/oauth/generic-account-failover.ts`, `src/server/responses/core.ts`, `src/types/{config,provider}.ts`, `structure/04` | yes | clean |
| `tests/always-on-429-failover.test.ts`, `tests/adapter-event-oauth-failover.test.ts`, `tests/generic-oauth-failover.test.ts` | **no — file absent on dev** | renamed/removed since branch point |

The `anthropic-routing.ts` conflict is mechanical: dev inserted `quorumCache = null` above the
target line ([anthropic-routing.ts:662](/private/tmp/ocx-closeout.xomWAA/wt/src/oauth/anthropic-routing.ts:662)),
the patched line itself is unchanged. The docs conflict is **semantic** and is the real problem —
#3520 landed *"stop promising a 429 failover kill switch that no longer exists"*, and CodeRabbit
flagged that this PR's own translated pages still open with the enabled-only condition its table
contradicts. Three missing test files mean the test half must be re-targeted, not replayed.

**Defects — all three confirmed live on dev.**

1. [anthropic-routing.ts:662](/private/tmp/ocx-closeout.xomWAA/wt/src/oauth/anthropic-routing.ts:662)
   calls `pickAlternateAnthropicAccount(config, failedAccountId, now)` unconditionally, so a
   *disabled* pool still reactivates the dormant proactive strategy (round-robin / fill-first) on
   the reactive 429 path.
2. [generic-account-failover.ts:189](/private/tmp/ocx-closeout.xomWAA/wt/src/oauth/generic-account-failover.ts:189)
   honours only `enabled === false` per provider, so a provider-specific `true` cannot opt back
   in when the global default is `false` — narrow-over-broad precedence is broken in one direction.
3. [core.ts:3380](/private/tmp/ocx-closeout.xomWAA/wt/src/server/responses/core.ts:3380) sets
   `parsed._kiroAuthContext` on the outer request only. The terminal-guard continuation at
   core.ts:6693 passes a **different** `nextParsed` object, so a rotated Kiro bearer is paired with
   the failed account's region/profile on that retry.

**Test evidence.** `tests/anthropic-sidecar-account-failover.test.ts` (+277 lines) is new and
would be red on dev, but I could not execute the suite: three of the four touched test files do
not exist on dev, so the test half cannot be applied as-is.

**Blockers.** (a) CONFLICTING; (b) docs prose contradicts landed #3520; (c) stale-base CI;
(d) it bundles three independent defects plus a 20-file locale sweep, which is exactly the shape
that makes a security-adjacent OAuth change hard to review.

**Disposition: LAND_WITH_FIX.** Exact fix list:

1. Rebase onto `0f27bbeb3`; re-apply the `anthropic-routing.ts` hunk below `quorumCache = null`.
2. Re-target the three renamed/removed test files to their current paths on dev.
3. Rewrite the docs delta on top of #3520's text and remove the enabled-only opening condition
   from all locale pages CodeRabbit named (fr:207, zh-cn:172, and the English 437-438 pair).
4. Re-run exact-head CI on the rebased head.
5. Preferably split: the Kiro `nextParsed` fix (3) is independently landable and touches
   `core.ts` near #3515 — sequence it after #3515.

---

## #3519 — fix(claude): fall back to native launch when routing is off

- Head `6b92ab7dbdc02b87c07050b4698b05e3f770a1f5`, base `dev`, MERGEABLE / BLOCKED,
  **`CHANGES_REQUESTED`**, **draft**, label `bug`, checklist 0/4.
- CI on that exact head: `enforce-target`, `hygiene`, `label`, `resolve-pr` pass; full matrix
  draft-gated. CodeRabbit skipped (draft).
- Conflicts: none.

**Behavior change (not strictly a defect).** Today
[claude.ts:420](/private/tmp/ocx-closeout.xomWAA/wt/src/cli/claude.ts:420) hard-errors when
`config.claudeCode?.enabled === false`. The PR converts that into a native `claude` launch. This
is a deliberate UX change, so "does the defect exist on dev" is less relevant than whether the new
behavior is safe.

**Both reviewer blockers are genuinely fixed on this head** (`Ingwannu` reviewed `8eb743be2`):

- *Loopback credential leak.* `buildNativeClaudeEnv` no longer strips by hostname. It deletes
  `ANTHROPIC_BASE_URL` only when `hasOwnedAdmission && targetsLocalClaudeProxy(baseUrl, config.port)`,
  and dev's `targetsLocalClaudeProxy`
  ([claude.ts:60](/private/tmp/ocx-closeout.xomWAA/wt/src/cli/claude.ts:60)) already requires
  http + loopback host + **exact configured port** + no embedded credentials. The new test
  *"preserves an unrelated loopback gateway and its user credential"* pins `http://localhost:8080`.
- *Auto-start contract.* `ensureProxyForClaude` is still called and still spawns; only its comment
  was reworded. Native fallback now triggers on explicit disable — config, or live
  `enabled: false` — never on an absent proxy.

CodeRabbit's ordering finding is also addressed: `claudeLaunchPreflight` runs
invalid/mismatched, selected-client, and token-fingerprint checks **before** any native fallback.

**Endpoint dependency verified.** `fetchClaudeCodeState` reads `enabled` from
`GET /api/claude-code`, which does emit it —
[agent-settings-routes.ts:1070](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/agent-settings-routes.ts:1070)
returns `enabled: config.claudeCode?.enabled !== false`. `claudeLaunchPlan` treats only an
explicit `false` as disabling, so an older proxy omitting the field stays routed.

**Test evidence.** `tests/claude-integration/claude-cli.test.ts` gains 6 unit tests covering the
plan matrix, preflight ordering, env scrubbing, the loopback negative path, `isProxyOnlyModelId`
(including an AWS Bedrock ARN false-positive guard), and the root opt-in. These are pure-function
tests and would fail to compile on dev because the exports do not exist — appropriate here, since
the change is new behavior rather than a silent-wrong-answer bug.

**Remaining blockers.**

1. **Docs sync (High per AGENTS.md "Docs sync").** User-facing behavior changes and the
   `docs-site/` guides still describe `ocx claude` as proxy-only.
   `docs-site/src/content/docs/guides/claude-code.md` (and its tr/ko/zh-tw/fr locale twins)
   is untouched by this diff.
2. **Medium — silent `readPickerDefaultModel` failure.** It swallows every error including a
   malformed `settings.json`, returning `null`, so the "saved model requires the proxy" warning
   silently disappears exactly when the picker file is corrupt.
3. **Low — unrelated churn.** The diff deletes the `#764 / SERVICE_STOP_LIVENESS` rationale
   comment above `ensureProxyForClaude` while keeping the behavior, discarding the reason the
   3-attempt budget exists.

**Disposition: LAND_WITH_FIX.** Exact fix list: (a) update
`docs-site/src/content/docs/guides/claude-code.md` plus locale twins to describe the native
fallback and its trigger conditions; (b) surface a warning when `settings.json` exists but cannot
be parsed; (c) restore the `#764` rationale comment; (d) exit draft, tick 4/4, get full exact-head
CI; (e) `Ingwannu` must re-review to clear `CHANGES_REQUESTED`.

---

## #3524 — fix(oauth): persist startup reconciliation before adoption

- Head `cf0b3fe0aaa3b72137b88da8b341769871e5845e`, base `dev`, MERGEABLE / BLOCKED,
  `REVIEW_REQUIRED`, **draft**, labels `bug` + `intake: hygiene-blocked`.
- CI on that exact head: **`enforce-target` FAIL and `hygiene` FAIL.** Hygiene reason is
  explicit: `unsponsored_surface` — "This changes an authentication ... surface.
  `MAINTAINERS.md` requires security review ... Paths: `src/oauth/index.ts`." The full matrix
  never ran. This is the only item in the lane with red required checks.
- Conflicts: none textually.

**Defect (real, and correctly diagnosed).** `reconcileOAuthProviders` at
[oauth/index.ts:1250](/private/tmp/ocx-closeout.xomWAA/wt/src/oauth/index.ts:1250) mutates the
in-memory `config` then `saveConfig(config)`, so a startup-time snapshot can overwrite an
operator edit made after load. `runModelRenameStartupMigration` has the same shape. The
read-modify-write concern is legitimate.

**Blocker — new uncaught `throw` on the startup path (Critical).** The rewrite adds:

```ts
if (outcome.status === "unavailable") {
  throw new Error(\`OAuth provider reconciliation persistence unavailable: \${outcome.reason}\`);
}
```

`reconcileOAuthProviders(config)` is called **unguarded** inside `startServer` at
[server/index.ts:663](/private/tmp/ocx-closeout.xomWAA/wt/src/server/index.ts:663) — no
try/catch in that window — and `runModelRenameStartupMigration` (same new throw) is called at
[server/index.ts:651](/private/tmp/ocx-closeout.xomWAA/wt/src/server/index.ts:651). Dev's
`saveConfig` does not throw for this condition, so the PR converts a survivable state into a
boot failure. Every other `mutatePersistedConfig` consumer degrades instead —
`storage/policy.ts:473`, `plan-from-token.ts:92`, `auth-api.ts:1089`,
`agent-settings-routes.ts:124`.

**Reproduced, not theorized.** Against the patched worktree with an isolated
`OPENCODEX_HOME`, loading a valid config and then removing `config.json` before reconcile
(config removed, unmounted volume, or a competing writer between `loadConfig()` at index.ts:651
and reconcile at :663):

```
loaded ok, agVer= 1
THREW: OAuth provider reconciliation persistence unavailable: missing
```

I also probed the benign paths and they are safe — fresh install with no `config.json`
(`changed=false`), malformed JSON (`changed=false`), unreadable file (`changed=false`). So the
throw is narrow, but it is real, reachable, and lands on the one path where an exception kills the
proxy at boot.

**Test evidence.** The PR's own tests pass (24/24) and `oauth-provider-reconcile.test.ts:81`
asserts the throw string — but it asserts it at the *unit* level. **No test covers
`startServer` surviving it**, which is exactly the gap: the new failure mode is proven correct
in isolation and unexamined where it matters.

**Other findings.** `adoptConfig` in `model-rename-startup.ts` deletes every key of the caller's
object and re-assigns from a `structuredClone` — object identity is preserved but any live
reference to a nested sub-object held elsewhere is silently detached. CodeRabbit's
warning-emission ordering finding was valid and the author fixed it in `55b5410c3`.

**Disposition: REIMPLEMENT.** Required changes: (1) replace both `throw`s with the
degrade-and-warn pattern every other consumer uses, or wrap both call sites at
`server/index.ts:651` and `:663` in explicit handling; (2) add a regression proving
`startServer` survives `status: "unavailable"`; (3) obtain the `maintainer-sponsored` label
for the `src/oauth/index.ts` security surface per `MAINTAINERS.md`; (4) fix `enforce-target`;
(5) reconsider `adoptConfig`'s delete-all-keys mutation; (6) split the OAuth and model-rename
halves so the security-reviewed surface is isolated.

---

## Verification notes

- Every `bun test` invocation named a specific file; no repository-wide suite was run.
- Patches were applied to the worktree only to establish red/green evidence and were reverted;
  final `git status --porcelain` shows only `?? devlog/_plan/260905_open_work_closeout/`.
- `git fetch origin pull/3502/head:tmp-pr-3502` was fetch-only; no checkout of `dev` occurred.
- `git merge-tree` could not run (sandbox denies its temp-file creation), so 3502's conflict set
  was established with per-file `git apply --check` plus `git log origin/dev ^tmp-pr-3502`.
- No external claim needed web verification, so `cxc-search` was not invoked.
