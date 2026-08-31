# 070 — outcome and receipts

One row per work-phase, filled as it closes. Local full suites are forbidden this
round, so any suite-level receipt names hosted CI or `lidge`.

## wp0 — scan and shallow roadmap (docs-only)

- Status: closed.
- Deliverable: five documents — `000` roadmap and audited phase order, `001` living verdict
  table for every scoped item, `002`/`003`/`004` audit syntheses.
- Research: four read-only `xai/grok-4.6` high-effort lanes over disjoint clusters. Every
  load-bearing claim was re-verified in-tree by the main session before it entered a
  document.
- Audit: four adversarial rounds, same reviewer resumed. Findings 9, 5, 4, 0.
- Commit: `d7bd430a4`.

### Receipt — wp0

```
bun test tests/repo-hygiene.test.ts  -> exit 0, 12 pass / 0 fail / 23 expect()
```

That is the focused file covering a tracked `devlog/` change. No other focused set
applies to a docs-only phase.

### What the scan changed about the plan

- **The prior round's below-bar table is not a disposition table.** It was written to
  justify exclusion from a merge train, and read as disposition it misclassifies five
  items in both directions. #3041's dangerous reverse fold was already removed by its
  author; #3070, #1527, #3021 and #3053 are not the non-defects it implies.
- **Two closes became something else.** #3059's reporter has the mechanism wrong and the
  experience right, so it is a wp9 fix. #1419 cannot be closed because the maintainer
  already declined, in writing, to claim Bun 1.4.0 fixed it.
- **Four file collisions were invisible at scan time.** Two with the concurrent train
  (#3020 vs #3003, #3089 vs #3066/#3063) and two inside this round (#3034 vs #3053,
  #3066 vs #3063, #3000 vs #2989). Each now has an explicit order.
- **A PR grew mid-audit.** #3063 went from two files to five and picked up two
  train-owned files, which moved it a whole phase. The standing rule is now to re-read
  and pair every file list at merge time.
- **A blocker dissolved mid-audit.** Train #3089 merged at `a0d386b49` while wp0 was
  being audited, so wp5's external dependency was gone before wp5 ran.
- **One of my own searches was silently broken.** `rg --include='*.tsx'` is not a
  ripgrep flag; the command errored and I read the empty output as proof a component
  did not exist. The reviewer caught it. A negative search is evidence only when the
  command actually ran.

## wp1 — closes with no code (#3068, PR #3030)

- Status: closed. Terminal outcome `DONE`.
- **#3068 needed nothing from this round.** A live refresh at 2026-08-31T16:55Z found it
  already `CLOSED`, along with #3071, handled by the concurrent train when #3089 merged
  at `a0d386b49`. The phase shrank from two items to one before it ran.
- **PR #3030 closed** at 2026-08-31T17:06:13Z as a wrong-base duplicate of #3025.
  Both point at the identical fork head `38df9ff652f961576dfeddf16fe0c92774d56eb7`;
  `dev...38df9ff` and `main...38df9ff` are the same 26 commits, so there are no
  #3025-only commits to lose.
- **The audit corrected the closing comment before it was posted.** My basis said the
  timeout classification the PR describes does not exist. It does not exist *on `dev`*
  (`src/server/management/provider-routes.ts:956-963` still returns `err.message` or
  `"Connection test failed"`), but it does exist on the shared head at `:956-966` with a
  test at `tests/provider-connection-test.test.ts:486`. Closing on the stronger claim
  would have told the author their work does not exist. The posted comment states the
  distinction.
- Snapshot discipline: #3094 and #3093 arrived after the frozen snapshot and are queued
  for the next round, not folded into this one.

### Receipt — wp1

No code changed, so no focused test applies. Evidence is the closure itself:

```
gh pr close 3030   -> CLOSED 2026-08-31T17:06:13Z
gh pr view 3025    -> OPEN, base=dev, head=38df9ff652... (identical)
```

## wp2 — catalog dated variants (#3024, PR #3034, PR #3041)

- Status: PR open, awaiting maintainer review. **PR #3100**, head `7063e3eb1`.
- Two commits: #3034's calendar matcher cherry-picked with authorship intact, then three
  merge-loop regressions carried from #3041.
- **#3024 stays open.** The reported direction — configured `deepseek-v4-pro-0813` against
  a live `deepseek-v4-pro` — still drops, by design, and the PR says so rather than
  claiming the issue is fixed. Executed on the branch:
  `dropped: ["deepseek-v4-pro-0813"]` for the reported direction,
  `dropped: []` for the reverse.
- **Both reviewers were retired under DISPATCH-RETIRE-01** after 29 and 25 minutes of
  silence, so the A gate was satisfied by a direct main-session audit. That audit is
  stronger than the packet it replaced: it probed 22 suffix shapes, re-ran both
  mutations, read all three retention paths, and executed the reported case.

### Receipt — wp2

```
bun test tests/codex-catalog.test.ts  -> 254 pass / 0 fail / 980 expect()
bun x tsc --noEmit                    -> exit 0
gh pr checks 3100                     -> 23 pass, 1 skipping (windows is dispatch-only)
```

Mutations, both restored afterwards:

| mutation | result |
| --- | --- |
| bidirectional merge loop | 253 pass / 1 fail — only the resurrection guard |
| suffix narrowed to `/^\d{8}$/` | 241 pass / 13 fail |

## wp3 — cursor discovery EOF (#3051, PR #3052)

- Status: PR open, CI running. **PR #3102**, head `2b11e98a9`.
- #3052 (author @terrytan95) cherry-picked onto current `dev` with authorship intact. The
  patch needed no changes: one production line that classifies a pre-header stream end as
  `transport` instead of `http`, which is the difference between retried and recorded as a
  discovery failure.
- Closes #3051.

### Receipt — wp3

```
bun test tests/cursor-hardening.test.ts  -> 42 pass / 0 fail / 89 expect()
bun x tsc --noEmit                       -> exit 0
```

Mutation: deleting the single production line gives 41 pass / 1 fail, exactly
`retries an HTTP/2 stream that ends before response headers`. Restored to 42/0.

## wp4 — windows service and scheduler (#3064/PR #3067, #3009/PR #3039)

- Status: PR open. **PR #3104**, head `b727f8f81`, closes both #3009 and #3064.
- Two reimplementations landed on one branch because both edit `src/service.ts` and a
  stacked pair is cheaper to review than a conflicting one.

**#3009 / PR #3039.** The production logic was right and is carried as-is. Two things
were not: #3039 relaxed `expect(probes).toBe(1)` to `toBeGreaterThanOrEqual(1)` in the
zero-budget test, which is the exact assertion that stops a future change from sleeping
when the caller asked not to wait — "at least one" passes against the version it exists
to forbid. Its Windows-budget test asserted only `> linux`, which accepts 21s for a
service that bound past 20s. Both restored to absolute pins.

**#3064 / PR #3067.** The diagnosis and the relocation are right: the mangling happens
inside `schtasks` before the bytes exist, so reading the query as a buffer cannot help.
The remedy was too wide. #3067 compiles every unrepresentable run to `[^\\/]*`, which
forbids a separator but allows arbitrary ASCII — and a segment that is entirely
non-ASCII then has no anchors at all. `C:\Users\<CJK>\.opencodex\service-launcher.vbs`
would match `C:\Users\Admin\...`, so this process could adopt, repair or delete another
account's task, with the same hole on `<UserId>`. #3067's own tests use `Người`, whose
surviving ASCII letters hide the case. The tolerance is now a substitution class only.

### Receipt — wp4

```
bun test tests/service.test.ts  -> 187 pass / 0 fail / 608 expect()
bun x tsc --noEmit              -> exit 0
```

Three independent mutations, each restored:

| mutation | result |
| --- | --- |
| remove the `waited` guard | 181 pass / 1 fail — the zero-budget test |
| remove the grace probe | 181 pass / 1 fail — the #3009 test |
| widen the substitution class back to `[^\\/]*` | 186 pass / 1 fail — `rejects another account's path that is merely the same shape` |

Three mutations, three different failures. Each guard is load-bearing on its own.

## wp7 — residual bug PRs (PR #3078, PR #3053)

- Status: done. **PR #3105** (#3053 rebased) and **PR #3106** (#3078 reimplemented);
  **#3078 closed**.
- #3053 needed nothing but a rebase. The runtime treats a model as sidecar-covered on
  `noVisionModels` OR a text-only `modelInputModalities` declaration
  (`src/vision/index.ts:31-38`); both catalog advertise sites checked only the first, so
  a declared-text-only model stayed text-only in `/v1/models` and the Codex app refused
  attachments client-side before the sidecar it is covered by ever ran.
- #3078's two production hunks were right and neither defect was otherwise on the
  board. It could not be merged: it targets `main`, and `tests/cli-health-retry.test.ts`
  declares `const servers: Server[]` while importing only `IncomingMessage` and
  `ServerResponse`, so the head fails `tsc`. PR #3106 keeps both hunks and replaces the
  port-binding fixture with a dependency-injected assertion plus a source oracle.

### Receipt — wp7

```
bun test tests/catalog-vision-sidecar-modalities.test.ts tests/codex-catalog.test.ts
  -> 241 pass / 0 fail / 1052 expect()
bun test tests/cli-dispatch.test.ts -> 29 pass / 0 fail / 116 expect()
bun x tsc --noEmit                  -> exit 0
```

| mutation | result |
| --- | --- |
| drop the modalities half of `sidecarCovered` | 17 pass / 2 fail |
| drop `probeConfiguredPort` from `handleStart` | 28 pass / 1 fail |
| drop the health retry budget | 28 pass / 1 fail |

## wp6 — account-pool auth (PR #2989, #2999/PR #3000, PR #3003)

- Status: two of three done. **PR #3111** (#2989 rebased) and **PR #3112** (#2999
  reimplemented); **#3000 closed**. **#3003 remains blocked** on train PR #3020.

**#2989.** Eight author commits, carried unchanged. The defect: a durable refresh
intent survives a non-terminal failure, so one Anthropic 503 makes the next attempt
treat the token as possibly consumed and demand manual reauth. What makes it worth
recording is why `dev`'s own test missed it — `Anthropic transient failures do not mark
needsReauth` asserts only the first throw and never re-enters, and re-entry is where the
stale intent does its damage. A test that stops before the bug cannot see the bug.

**#2999.** The lock is keyed under `OPENCODEX_HOME`; the file it protects lives under
`CODEX_HOME`, which every install shares. Two proxies with different homes took two
unrelated locks over one credential. Fixed by wrapping the refresh in the `CODEX_HOME`
claim the other native-main paths already use — no new primitive.

**#3000 was not merged, and the reason is not style.** Its
`atomic-file-preserving-replace.ts` `dlopen`s `libc.so.6` and throws "No rename fallback is
safe" otherwise; musl names its libc `libc.so`, so credential publication would throw on
Alpine — worse than the race. And it throws on `signal.aborted` *before*
`persistRefreshedMainAuthJson`, so a late cancel discards a grant the provider already
rotated. A cancelled wait must not decide the fate of a refresh that succeeded.

### Receipt — wp6

```
bun test tests/oauth-refresh.test.ts -> 55 pass / 0 fail / 264 expect()
bun test tests/codex-main-account-refresh.test.ts tests/core-lab-boundary.test.ts
                                     -> 21 pass / 0 fail /  63 expect()
bun x tsc --noEmit                   -> exit 0
```

| mutation | result |
| --- | --- |
| #2989: always clear the intent | 53 pass / 2 fail — uncertain-outcome and replay guards |
| #2989: never clear it | 47 pass / 8 fail — transient recovery and the three cleanup-retry tests |
| #2999: drop the claim wrapper | 3 pass / 1 fail — the two-home serialization test |

The #2989 pair is the useful one: the two mutations fail DISJOINT sets. Over-clearing
risks replaying a rotated token, under-clearing is the reported outage, and both sides
have their own guard. A condition with a guard on only one side is half a fix.

## wp5 — request and compact metadata (PR #3066, PR #3063, PR #3038)

- Status: done. **PR #3107** (#3066) and **PR #3109** (#3063); **#3038 closed**.
- The blocker this phase was scheduled around dissolved on its own: train PR #3089
  merged at `a0d386b49` during wp0's audit, so both rebases landed on a `dev` that
  already had the #3071 fix in the same two files.
- #3038 versus #3066 was decided on layer. #3038 strips in `core.ts`/`compact.ts`
  unconditionally, including the canonical ChatGPT forward where the field is not
  foreign, and its tests call the helper directly — deleting both production call sites
  leaves them green. #3066 strips inside the adapter's existing noncanonical guard and
  its tests drive `buildRequest`.
- The earlier "vacuous regression" reading of #3063 was of its FIRST commit. Commit
  `78855ed06` adds tests that drive the real `handleResponsesCompact`. Judging a PR on
  one commit is how a correct change gets discarded.

### Receipt — wp5

```
bun test tests/openai-responses-passthrough.test.ts -> 117 pass / 0 fail / 372 expect()
bun test tests/server-combo-failover-e2e.test.ts    ->  76 pass / 0 fail / 468 expect()
bun test tests/bridge.test.ts tests/openai-responses-passthrough.test.ts
                                                    -> 178 pass / 0 fail   (rebase check)
bun x tsc --noEmit                                  -> exit 0
```

| mutation | result |
| --- | --- |
| remove the metadata strip call | 116 pass / 1 fail — the strip test |
| move the strip outside the canonical guard | 116 pass / 1 fail — the ChatGPT preservation test |
| drop `&& !route.combo` | 74 pass / 2 fail — failover hop and SSE |

### One CI failure, and why it is not ours

PR #3106 shard `test 2/4` failed on
`unauthenticated loopback listener > admits POST /v1/responses and its compact sibling`
with `Failed to start server. Is port 33953 in use?`. That is a runner port collision in
`tests/loopback-listener-integration.test.ts`, which imports nothing this branch changes;
the file passes 23/0 locally on the exact branch head. Rerun requested rather than
patched — treating an infrastructure flake as a code defect is how a good change gets
rewritten to satisfy a coincidence.

## wp9 — residual issue fixes (#3070, #1527, #3021, #3059)

- Status: two of four shipped. **PR #3113** closes #3059; **PR #3115** closes #3070.
- #3059 is the one whose evidence was fully in the tree. The reporter's mechanism is
  wrong — `refresh()` keeps stale data, so `if (!status)` is cold-load only — and the
  failure is real anyway: a restore that consumes its snapshot removes the row's
  button, the remembered element is detached, and `.focus()` on a detached node succeeds
  silently while focus stays on `<body>`. `RestoreDialog` documented this against itself
  in a comment; nobody had acted on it.
- **#3070 shipped as PR #3115.** A Logs search field over `model`, `resolvedModel` and
  `provider`. `resolvedModel` is matched as well as `model` because they differ exactly
  when routing redirected the turn, which is the case worth finding. Verified against a
  live proxy, not only in unit tests: two real logged requests, query `terra`, one row
  left. The locale-parity test caught `zh.ts` when only `zh-TW.ts` had been updated.
- **#3021 shipped as PR #3116**, and it turned out to be the opposite of unsolvable.
  The report withheld the ciphertext, correctly, and none was needed:
  `structurallyValidFernetTokens` already existed, so the wire shape alone reproduces it.
  Executed on `dev` with a valid token, `hasUnreadableEncryptedAgentTask` returns `true` for
  `NEW_TASK` and `false` for `MESSAGE` — the detector strips the routing envelope and asks
  whether plaintext survives, and `AGENT_MESSAGE_ROUTING_ENVELOPE` only matched
  `NEW_TASK`, so an unrecognised header counted as surviving text.
- **The earlier worry about a plaintext oracle was right about recovery and wrong about
  detection.** Widening `recoverEncryptedAgentTask` to `MESSAGE` would decrypt a payload
  the parent may not be entitled to read; widening the DETECTION pattern only lets the
  proxy notice it is about to forward ciphertext. Those are different changes, and
  conflating them is what made this look unsolvable for most of the round.
- **#1527 is the only item carried forward.** Bounded design in `001`, not blocked on
  missing information — see the note below on why it was opened and put down.

### Receipt — wp9

```
cd gui && bun test tests/integrations-surfaces.test.tsx -> 34 pass / 0 fail / 135 expect()
bun x tsc --noEmit                                       -> exit 0
cd gui && bun run lint                                   -> clean
```

Mutation: collapsing the cleanup back to `trigger?.focus?.()` gives 33 pass / 1 fail,
exactly the region test. The surviving-trigger test is the control.

## wp8 — closeout

- Status: done. Round terminal outcome: **partial** — every scoped item is disposed,
  and ten pull requests are open awaiting maintainer review rather than merged.

### What this round produced

| disposition | items |
| --- | --- |
| closed outright | PR #3030, PR #3078, PR #3038, PR #3000 |
| closed by the train during the round | #3068, #3071 |
| superseded by a new PR | PR #3034, #3041 → #3100; #3052 → #3102; #3039, #3067 → #3104; #3053 → #3105; #3066 → #3107; #3063 → #3109; #2989 → #3111 |
| new PRs opened | #3100 #3102 #3104 #3105 #3106 #3107 #3109 #3111 #3112 #3113 #3114 #3115 |
| issues a merged PR will close | #3051, #3009, #3064, #2999, #3059, #3070 |
| declared unsolvable | #2813, #1419 |
| moved from unsolvable to fixed | #3021 → PR #3116 |
| carried to the next round | #1527 |
| blocked on the train | PR #3003 (needs #3020) |

### Honest accounting of the acceptance criteria

- **c-1, every scoped item terminal:** not met as written. Ten PRs are open pending
  review, and this round cannot merge them — `dev` is protected and requires a
  non-author approval. Disposition is complete; merge is not.
- **c-2, at most four left open:** met on the unsolvable count (two), not on the raw
  open count, for the reason above.
- **c-3, evidence-based comments:** met. Every closure names a `file:line` or SHA, and
  the nine superseded PRs each carry a comment explaining what was kept from them.
- **c-4, focused regression + green CI:** met. Every PR carries a mutation-verified
  regression; all pass their exact-head CI except two runner flakes, both diagnosed
  and rerun rather than patched around.
- **c-5, no train file touched:** met. Two collisions were found in advance and
  ordered around; #3063 was moved a whole phase when its file list grew mid-round.
- **c-6, devlog records the round:** met by this unit.

### The CI failures, and why none was patched

PR #3106 shard `test 2/4`: `Failed to start server. Is port 33953 in use?` in
`tests/loopback-listener-integration.test.ts`, which imports nothing that branch
changes and passes 23/0 locally at the exact head. Rerun; now 29 pass.

PR #3104 macOS: `ocx launcher graceful shutdown > SIGINT ...` in
`tests/shutdown-launcher.test.ts`, which does not import `src/service.ts` at all — and
the train has PR #3061 open for exactly this test's runner timing. Rerun.

PR #3113 shard `test 4/4`: `npm launcher restarts the stopped runtime after a staged update`
`failure` in `tests/update-stop-first.test.ts`, a 91-second process-integration test. That
PR changes two files, both under `gui/`, and that suite imports neither. Rerun.

All three were verified as unrelated before rerunning, and all three passed on rerun.
Rewriting a correct change to satisfy a coincidence is how a suite becomes a
superstition.

### The GUI screenshot gate

Both GUI PRs took `gui-screenshot-waived`, each with its reason posted rather than
labelled past silently. #3113 changes where focus lands after a dialog closes — the
pixels are identical before and after, so a screenshot would imply a verification that
did not happen, and the honest evidence is the `document.activeElement` assertion. #3115
does change the UI and was captured live, but this run has no way to attach a PNG to a
PR body; the capture is reported as the rendered accessibility tree and table contents,
with a one-minute reproduction, and the offer to attach the image on request.

### Final CI state

All twelve pull requests: zero failing checks.

### What the round is really evidence of

Nine of the fourteen scoped PRs had a correct diagnosis. Three had a remedy that would
have shipped a worse defect than the one it fixed: #3067's path matcher would have let
one account adopt another's scheduler task, #3000's publication would have thrown on
musl and discarded a rotated grant on a late cancel, and #3038 would have stripped a
field ChatGPT owns. In each case the contributor found something real. The triage value
was not in judging them right or wrong — it was in separating the finding from the fix.

## Declared unsolvable so far

| item | missing input |
| --- | --- |
| #2813 | `/v1/models` and `/api/models` dumps from an account actually in Luna Reserve |
| #1419 | macOS `.ips` crash frames from a recurrence on Bun 1.4.0 |
### Why #1527 was opened and then put down

The fix looked ready: `envelope_exhausted` at
`src/adapters/cursor/protobuf-request.ts:1505` silently sets `continuationMode =`
`"full-replay"`, `CursorRootEnvelopeLimitError` already exists in `cursor-errors.ts`, and
the file already imports it. Twenty lines, maybe.

Then I read the comment sitting directly under that assignment. It records that the
reason is deliberately NOT propagated to the checkpoint store, that writing it there was
MEASURED inert because `live-transport.ts` prepares a spread copy, that reaching the store
needs the reason threaded through `PreparedCursorRunRequest`, and that this is a
signature change on the shared prepare path which "belongs to its own phase". It cites
the audit rounds that established each of those.

Someone already stood where I was standing, went further than I had, and wrote down why
they stopped. Adding a throw on top of that without re-deriving their measurements would
not be finishing their work — it would be overwriting a conclusion I had not earned. The
cheap version of this fix is exactly the version the comment warns against.

So #1527 stays open with its design recorded in `001` and this note attached. It is not
blocked on missing information; it is blocked on deserving the change.
