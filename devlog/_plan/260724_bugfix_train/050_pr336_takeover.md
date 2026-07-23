# 050 — Cycle 5: PR #336 takeover

> DIFFLEVEL-ROADMAP-01 implementation design for `fix(v2): harden unreadable
> routed agent tasks`, contributor `MathiasHeinke`, head branch
> `codex/v2-fernet-guard-hardening`.

## Loop spec

- Archetype: **spec-satisfaction repair**. Preserve PR #336's reviewed behavior
  while replaying it on the post-Cycle-1 `dev` tip, proving a clean interdiff,
  and refreshing all SHA-bound local/CI evidence.
- Starting facts: PR #336 targets `dev`, is a cross-repository PR from
  `MathiasHeinke/opencodex`, has `maintainerCanModify=true`, is mergeable, and
  currently points to `87af85fb9df8bf8a4fbe0e1ae5fbb122bfe84fa9`, based on
  `d9e06c8dd08df6635f5ca042bf6aa469fe1a10a8`. The live head contains two commits:
  `733cec4dc4ab5fdc871e1e3cc88b885d3ae5827a` (code/tests) followed by
  `87af85fb9df8bf8a4fbe0e1ae5fbb122bfe84fa9` (localized docs).
- Required verifier: on the rebased head, all of `bun run typecheck`,
  `bun run test`, and `bun run privacy:scan` exit 0 locally. The Cross-platform
  CI `ubuntu-latest`, `windows-latest`, and `macos-latest` jobs must also be
  successful for the exact rebased head SHA before merge; a green older SHA is
  not transferable evidence.
- Bound: one takeover/rebase of the contributor branch after Cycle 1 lands.
  Preserve the PR's eight-file material scope unless conflict resolution or a
  focused regression requires a minimal adjacent edit.
- Escalation: stop before push if the rebase changes guard semantics, expands
  into auth/credentials/workflows/dependency installation, or requires force
  updating anything except the contributor's authorized head branch. Stop
  before merge if any local gate fails, the fresh CI matrix is absent or red,
  privacy scan is absent/red, or a maintainer approval is missing. Workflow
  edits are a security-boundary change and require explicit security review.

## Outcome and non-goals

Take over PR #336 after Cycle 1's issue #326 guidance-accumulation repair is in
`dev`, rebase both contributor commits onto that new tip, review the old-vs-new
commit series with `git range-diff`, include both localized docs in the material
review, run the complete local gates and focused PR tests, and only then push the
rebased commit series with lease protection. Fresh checks on the new SHA replace
the currently green-but-pre-rebase evidence.

This PR is the corrected rebuild of merged-and-reverted PR #283. It is a
fail-fast mitigation for issue #92: it prevents unreadable encrypted routed
agent tasks from being dispatched to providers that cannot decrypt them. It
does **not** decrypt those tasks or solve issue #92, so neither code, commit
message, PR body, nor comment may say `Closes #92` or otherwise claim closure.

## Scope

### IN

- Rebase PR #336's existing eight-file/two-commit diff onto the post-Cycle-1
  `origin/dev`.
- Review the low textual-overlap rebase plus the semantic call contract between
  Cycle 1's `src/server/responses/collaboration.ts` injection owner and PR #336's
  `src/server/responses/core.ts` caller.
- Preserve structural Fernet validation, current-task-only classification,
  static 400 error content, and decrypt-capable combo selection/failover.
- Refresh tests only if post-rebase names/fixtures require a mechanical update.
- Review both localized docs files for accuracy and English/Chinese consistency.
- Push the rebased contributor head with a lease and post the English takeover
  comment drafted below.

### OUT

- Redesigning the Fernet classifier or adding decryption/key handling.
- Broad routing/combo refactors, response-facade changes, or moving logic back
  into `src/server/responses.ts` (that file is only the post-AUTO-SPLIT facade).
- Reworking Cycle 1's guidance fix.
- Editing `.github/workflows/**` merely to manufacture a check.
- Closing issue #92, merging PR #336 without required evidence, releasing, or
  promoting `dev` to `main`.

## Exact file map and required resulting diff

The takeover retains the PR's actual eight files. Refresh this list and both commit anchors before
rebase with `gh pr view 336 --repo lidge-jun/opencodex --json headRefOid,files,commits`; abort and
amend this plan if the live material diff has drifted. The earlier
`src/server/responses.ts` attribution is invalid and must not appear in the
rebased material diff.

### MODIFY `docs-site/src/content/docs/guides/sub-agent-surface.md`

Retain the contributor's English explanation of encrypted routed-task eligibility and fail-fast
behavior. Verify it describes mitigation rather than decryption and does not claim issue #92 closed.

### MODIFY `docs-site/src/content/docs/zh-cn/guides/sub-agent-surface.md`

Retain the localized counterpart and review it against the English source for the same eligibility,
static-error, and non-closure semantics.

### MODIFY `src/combos/resolve.ts`

Before, `advanceComboAfterFailure()` accepts only `retryAfter` and `now`, and
its next pick checks cooldown only. After, add an optional
`eligible(target: Required<OcxComboTarget>): boolean` callback and compose it
with cooldown eligibility:

```diff
 options: {
   retryAfter?: string | null;
   now?: number;
+  eligible?: (target: Required<OcxComboTarget>) => boolean;
 }
 ...
-eligible: target => !isComboTargetInCooldown(...)
+eligible: target => !isComboTargetInCooldown(...)
+  && (options.eligible?.(target) ?? true)
```

This ensures a failover cannot escape the encrypted-payload eligibility filter
applied to the initial combo pick.

### MODIFY `src/server/responses/core.ts`

Retain four PR #336 changes after applying Cycle 1:

1. Add a shared `UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE` and
   `unreadableEncryptedAgentTaskResponse()`. The response is HTTP 400 JSON with
   `type: "invalid_request_error"` and
   `code: "unreadable_encrypted_agent_task"`; it contains only static text and
   never request content or ciphertext.
2. In `handleComboResponses()`, classify `rawBody.input` before dispatch. Add a
   decryptability predicate that resolves each configured combo target and
   accepts only `isCanonicalOpenAiForwardProvider(route.provider)`. Compose it
   with cooldown eligibility for initial selection and pass the same predicate
   to `advanceComboAfterFailure()`. If an unreadable task has no eligible native
   target, return the shared 400 before creating a child request or calling a
   provider.
3. In `handleResponses()`, classify the raw current input **before**
   `expandPreviousResponseInput()`. Preserve the expanded-body bookkeeping and
   run sanitization/parsing afterward. This prevents encrypted historical tasks
   replayed through `previous_response_id` from poisoning a later plaintext
   current task.
4. Replace the inline non-native guard error with the shared static response.

The intended ordering after rebase is:

```text
read raw JSON
  -> combo guard/eligible native selection (combo requests)
  -> classify raw current task (non-combo requests)
  -> expand previous-response history
  -> sanitize plaintext encrypted_content compatibility slots
  -> parse and route
  -> reject unreadable task on non-native route
  -> apply Cycle 1's idempotent guidance injection
  -> dispatch
```

Do not move Fernet classification below history expansion and do not move
Cycle 1's guidance logic before parse/route.

### MODIFY `src/server/responses/encrypted-payload.ts`

Replace the permissive `gAAAA...` run heuristic with key-independent Fernet
wire validation:

- match a maximal boundary-delimited base64url candidate;
- require canonical padded encoding and a round-trip-equal unpadded form;
- require version byte `0x80`;
- require at least 73 decoded bytes;
- derive ciphertext length as `decoded.length - 57`, require at least one
  16-byte block, and require AES-CBC block alignment;
- remove only structurally valid runs when deciding whether readable text
  remains.

Expand the bounded CXC compatibility preamble matcher to repeated/current and
future `[CXC-*]` tags without consuming later untagged task paragraphs. In
`hasUnreadableEncryptedAgentTask()`, walk backward over trailing
`compaction_trigger`/`additional_tools` metadata and inspect only the newest
`agent_message`; do not scan historical agent messages. Treat accepted input
text record types as readable, strip routing/control envelopes before deciding
whether meaningful plaintext remains, and require a valid Fernet run before
classifying the task unreadable.

### MODIFY `tests/combos.test.ts`

Add `advancement preserves an explicit payload-eligibility filter`: after a
first combo pick, pass an eligibility callback selecting provider `c`; assert
the next target is `c` and attempted order is `["a/m1", "c/m3"]`.

### MODIFY `tests/multi-agent-compat.test.ts`

Replace malformed Fernet-looking fixtures with a synthetic structurally valid
73-byte fixture (version, timestamp, IV, one ciphertext block, HMAC shape).
Retain the mixed-slot split and pure-token byte-identity assertions. Resolve
any Cycle 1 additions in this file additively; do not delete its guidance
idempotence/continuation regression coverage.

### MODIFY `tests/v2-agent-message-failfast.test.ts`

Retain the synthetic Fernet fixture helper and the focused cases covering:

- pure token and exact routing-envelope rejection;
- current/future CXC preambles and mixed slots;
- readable text before/after metadata or envelope;
- malformed padding, too-short token, invalid version, invalid CBC block
  length, noncanonical token boundaries, and output-only text;
- encrypted historical task plus plaintext current task;
- readable history plus unreadable current task;
- string content passthrough and canonical native passthrough;
- mixed combo initial filtering, no-native zero-dispatch 400, and native-only
  failover after a retryable native failure;
- static machine-readable error code and absence of ciphertext in the response.

## Rebase and conflict plan

### Preconditions

1. Wait until Cycle 1 is merged into `dev`; record `CYCLE1_DEV_SHA` and verify
   `git merge-base --is-ancestor <cycle-1-merge-sha> origin/dev` exits 0.
2. Re-read PR #336 metadata and files. Require `state=OPEN`, base `dev`, head
   `MathiasHeinke:codex/v2-fernet-guard-hardening`, and
   `maintainerCanModify=true`.
3. Fetch `origin/dev` and the contributor head, then assert the fetched head is
   the PR API's exact `head.sha`. Abort on drift and review the new diff first.
4. Record the old head as `PR336_OLD_SHA` and create a local safety ref. Do not
   push a backup branch to the contributor repository.

Suggested execution shape:

```bash
git fetch origin dev
git fetch https://github.com/MathiasHeinke/opencodex.git \
  codex/v2-fernet-guard-hardening:refs/remotes/pr336/codex/v2-fernet-guard-hardening
git switch -C codex/pr336-takeover \
  refs/remotes/pr336/codex/v2-fernet-guard-hardening
git rebase origin/dev
```

### Predicted conflict and semantic-review map

Cycle 1 does **not** modify `src/server/responses/core.ts` or
`src/responses/state.ts`. Its exact production file set is
`src/server/relay.ts`, `src/types.ts`, `src/responses/parser.ts`, and
`src/server/responses/collaboration.ts`; its focused test owner is
`tests/responses-state.test.ts`. `injectDeveloperMessage` is implemented at
`src/server/responses/collaboration.ts:284`; `core.ts:667-675` only calls it.

PR #336's actual code/test files are `src/combos/resolve.ts`,
`src/server/responses/core.ts`, `src/server/responses/encrypted-payload.ts`,
`tests/combos.test.ts`, `tests/multi-agent-compat.test.ts`, and
`tests/v2-agent-message-failfast.test.ts`, plus the two docs files listed above.
That set is textually disjoint from Cycle 1, so predicted textual conflict risk
is **LOW**. Do not manufacture a `core.ts` conflict resolution step if Git reports
none.

Mandatory semantic review remains because the files meet at a call contract:

1. Confirm `core.ts` still calls `injectDeveloperMessage` only after raw-current
   Fernet classification, previous-response expansion, parse, and route selection.
2. Confirm `collaboration.ts` still receives Cycle 1's `_replayPrefixLen` and can
   return early without duplicating parsed/raw guidance; PR #336 must not bypass,
   duplicate, or reorder that call.
3. Confirm encrypted historical tasks remain excluded from current-task
   classification while an unreadable current task still fails before provider
   dispatch.
4. Review the combo helper, encrypted-payload classifier, all three focused test
   files, and both docs files even if the rebase is conflict-free.

After rebase, compare the complete old and new series:

```bash
git range-diff \
  d9e06c8dd08df6635f5ca042bf6aa469fe1a10a8..87af85fb9df8bf8a4fbe0e1ae5fbb122bfe84fa9 \
  "$POST_WP1_DEV_SHA"..HEAD
git diff --stat "$POST_WP1_DEV_SHA"...HEAD
git diff "$POST_WP1_DEV_SHA"...HEAD -- \
  docs-site/src/content/docs/guides/sub-agent-surface.md \
  docs-site/src/content/docs/zh-cn/guides/sub-agent-surface.md \
  src/combos/resolve.ts src/server/responses/core.ts \
  src/server/responses/encrypted-payload.ts tests/combos.test.ts \
  tests/multi-agent-compat.test.ts tests/v2-agent-message-failfast.test.ts
```

The range-diff must show only rebase-equivalent commit rewriting or explicitly
reviewed conflict/context adjustments. Any unexplained semantic delta, dropped
docs commit, ninth file, or call-contract drift blocks force-push and requires a
P-phase amendment.

### Push

After all local checks pass, update only the authorized contributor branch:

```bash
git push --force-with-lease=<full-ref>:<PR336_OLD_SHA> \
  https://github.com/MathiasHeinke/opencodex.git \
  HEAD:refs/heads/codex/v2-fernet-guard-hardening
```

Re-read PR metadata immediately after push and record the new `head.sha`. Never
use an unqualified `--force`; if the lease fails, stop and review contributor
changes rather than overwriting them.

## Post-rebase SHA-bound CI refresh

### Workflow finding

`.github/workflows/ci.yml` is the applicable `Cross-platform CI` workflow. Its
`pull_request` trigger includes base branches `main` and `dev` and path filters
covering `src/**` and `tests/**`, so the six code/test files qualify; the docs
files remain part of the reviewed PR scope. Each of the
Ubuntu, Windows, and macOS jobs runs install, typecheck, isolated full tests,
GUI tests, privacy scan, release-helper syntax check, GUI lint/build, and CLI
help smoke. The three npm-global jobs are additional packaging smoke evidence.
`service-lifecycle.yml` is not applicable because none of its narrowly filtered
service/CLI/runtime paths changes.

At the live pre-rebase head
`87af85fb9df8bf8a4fbe0e1ae5fbb122bfe84fa9`, all six Cross-platform CI jobs
(Linux, Windows, macOS, and the three npm-global jobs) are completed/SUCCESS.
There is no missing-CI blocker to repair.

`MAINTAINERS.md` makes successful required CI a merge policy even though the
live API reports no `dev` branch-protection rule/ruleset enforcing named status
contexts. The takeover requirement is to re-run the full local gates before
push and obtain a new successful Cross-platform CI run whose `headSha` equals
the post-Cycle-1 rebased PR head; the current green run at `87af85fb...` becomes
stale after push.

### Concrete SHA-refresh decision

The maintainer push to the approved contributor head produces a PR
`synchronize` event and should retrigger `ci.yml`; the workflow has no blocking
path or branch mismatch. Do **not** edit a workflow preemptively. Poll the PR's
check rollup and verify all three OS jobs and their privacy-scan steps are green
for the exact new SHA.

If no `pull_request` run appears after the push:

1. verify the PR is open, targets `dev`, includes `src/**`/`tests/**`, and the
   PR head SHA equals the pushed SHA;
2. inspect Actions for a waiting-approval state and approve the fork run through
   repository controls if GitHub requests it;
3. if GitHub still suppresses the run, retain the three successful local gates,
   report the missing required signal, and stop before merge;
4. propose a workflow change only after proving a trigger defect. Any such edit
   is a separate security-boundary scope expansion requiring explicit
   justification, explicit security review, pinned actions, and its own tests.

## Verification plan

Run from a clean rebased worktree. Record exit code, head SHA, and concise test
counts for every command.

```bash
bun install --frozen-lockfile
bun test --isolate tests/v2-agent-message-failfast.test.ts \
  tests/multi-agent-compat.test.ts tests/combos.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

All commands must exit 0. The focused run must include every listed PR #336
case, especially zero-dispatch combo rejection, native-only failover,
malformed Fernet-like values, current-vs-historical task scoping, native
passthrough, and mixed-slot sanitization.

Cycle 1 regression checks are additive:

- run its focused issue #326 continuation/guidance test(s) by exact file after
  they land;
- confirm two or more `previous_response_id` continuations never accumulate
  duplicate proxy-generated developer guidance in outbound input or saved
  state;
- confirm the same continuation path still rejects an unreadable **current**
  non-native worker task, while an encrypted historical task followed by a
  plaintext current task remains allowed;
- inspect `git diff --check` and require a clean worktree after verification.

After push, query the PR check rollup by exact SHA. Require successful
`Cross-platform CI / ubuntu-latest`, `/ windows-latest`, and `/ macos-latest`.
Confirm each job's Privacy scan step succeeded. The npm-global matrix should
also remain green because it is part of the same workflow. React Doctor is
advisory and no service-lifecycle run is expected for this path set.

## PR communication plan

Post only after the rebase, local gates, and push are complete; replace all
angle-bracket placeholders with recorded facts:

```markdown
Maintainer takeover update for PR #336:

- Rebased `MathiasHeinke:codex/v2-fernet-guard-hardening` onto the current `dev` tip `<DEV_SHA>`, after the Cycle 1 issue #326 guidance-continuation fix landed.
- `git range-diff` confirmed the two-commit series remained equivalent after rebase. Textual conflict risk was low because Cycle 1 owns `collaboration.ts`, not `core.ts`; semantic review confirmed the `collaboration.ts` injection contract and `core.ts` call ordering preserve both current-task fail-fast and replay-guidance idempotence.
- Kept the material scope to the reviewed eight files: `docs-site/src/content/docs/guides/sub-agent-surface.md`, `docs-site/src/content/docs/zh-cn/guides/sub-agent-surface.md`, `src/combos/resolve.ts`, `src/server/responses/core.ts`, `src/server/responses/encrypted-payload.ts`, `tests/combos.test.ts`, `tests/multi-agent-compat.test.ts`, and `tests/v2-agent-message-failfast.test.ts`.
- Local verification on `<NEW_HEAD_SHA>`: `bun run typecheck` PASS; `bun run test` PASS (`<COUNTS>`); `bun run privacy:scan` PASS; focused PR #336 and Cycle 1 regression tests PASS (`<COUNTS>`).
- Pushed the rebased head with lease protection. Fresh Cross-platform CI must pass on `<NEW_HEAD_SHA>` before merge; the previous green run on `87af85fb` is intentionally treated as stale.

This remains the corrected follow-up to the reverted PR #283 and a fail-fast mitigation for issue #92. It does not solve or close #92.
```

If CI is still pending, say so explicitly and do not use merge-ready language.
Once fresh checks are green, append a short follow-up with links to the exact
run and maintainer approval; do not edit the evidence into a claim before it
exists.

## Completion criteria

- PR #336 head is rebased onto post-Cycle-1 `origin/dev` with lease-safe push.
- The material diff remains the intended eight files, with any deviation reviewed
  and explained before push.
- The `git range-diff` is clean/reviewed, both docs are in scope, and the
  `collaboration.ts` ↔ `core.ts` call contract preserves current-task Fernet
  fail-fast plus Cycle 1 guidance idempotence.
- Focused tests, full tests, typecheck, and privacy scan pass locally.
- Fresh Cross-platform CI and privacy-scan steps pass for the exact rebased SHA.
- At least one maintainer approval is present and the English takeover comment
  reports actual evidence only.
- No workflow/security scope expansion and no claim that PR #336 closes #92.
