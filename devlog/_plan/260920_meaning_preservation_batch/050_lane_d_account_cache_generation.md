# Lane D — account/credential-generation evidence and cache affinity

Status: branch pushed for hosted CI. One branch, ordered commits, one PR
against `dev`, per the batch topology.

## Scope

Bundle 8 — an observation attributed to an account or credential generation
must not survive its replacement:

- #5214 (carried) — entitlement refreshes fenced behind native-main admission.
- #5145 (carried) — learned reasoning-effort refusals scoped to the credential
  identity, snapshot v2, legacy destination-wide rows ignored.
- #5229 (carried) — Cursor live wire-spelling and Max-Mode evidence keyed by
  destination+credential scope.
- Lane addition: Cursor and Devin live *rosters* (the cached model list
  itself, not just the derived evidence) are now bound to an irreversible
  credential fingerprint, including the stale fallback and the failure
  cooldown's suppression.
- Lane addition: a cancelled data-plane request's late entitlement refresh no
  longer commits — the /v1/models signal reaches the native-main token
  refresh, which re-checks it before the auth.json write.

Bundle 9 — a threshold hint is not exhaustion, and cache-loss causes must be
distinguishable:

- #5209 (carried) — shared cache-affinity bindings retire on genuine 100%
  exhaustion, not on the proactive auto-switch threshold.
- #4793 (carried) — per-model cache metrics on the Usage page (lane D owns
  this surface).
- Lane addition: opt-in privacy-bounded cache diagnostic (#5178), one record
  per finalized request in `cache-debug.jsonl`, so client prefix change,
  account change and proxy transformation change are distinguishable without
  retaining content or a durable correlation key.

All four luvs01 pull requests and xdober's #4793 are carried with
`Co-authored-by` trailers on the branch commits. The original pull requests
stay open for the coordinator.

## Branch

`codex/260920-lane-d-account-cache-generation`, cut from `origin/dev`
(`b9483b3b51`). Commits in order:

1. `fix(codex): preserve cache affinity across model detours` (carries #5209)
2. `fix(reasoning): scope learned reasoning-effort refusals to credential identity` (carries #5145)
3. `fix(cursor): isolate live roster and Max Mode evidence by account` (carries #5229)
4. `fix(codex): fence entitlement credential refreshes behind admission` (carries #5214)
5. `feat(usage): show cache metrics by model` (carries #4793)
6. `test(codex): move cache-affinity detour cases to a sibling under the file-size cap`
7. `fix(codex): bind Cursor and Devin live rosters to the observing credential`
8. `fix(codex): fence cancelled entitlement refreshes behind caller cancellation`
9. `feat(usage): opt-in privacy-bounded cache diagnostic (#5178)`

## Review findings on current dev (beyond the carried diffs)

- #5229 scoped the Cursor spelling/Max-Mode maps but not the roster cache
  itself: `provider-models.ts` read and wrote the Cursor and Devin live model
  lists by provider name alone, and the failure cooldown let one credential's
  error suppress another's discovery. Qoder already had the correct pattern
  (`authorityIdentity`); the lane extended it.
- The entitlement admission fence (#5214) covered lifecycle drains but not
  caller cancellation: `/v1/models` never passed `req.signal`, and the
  native-main refresh committed its late result without re-checking it. The
  roster-cache publication needed no change — it is already fenced by
  credential identity plus mutation epoch, which is the right boundary for a
  shared flight.
- False/unknown/absent is covered on the entitlement path
  (`model-entitlements.ts` keeps a `confirmed` bit separate from the model
  set, and the public state is tri-state) and is pinned by existing tests in
  `codex-model-entitlements.test.ts`. For usage telemetry the distinction
  rides the existing provenance enum: a measured zero is `observed`, a
  defaulted zero from a normalized wire is `synthesized`, and an absent
  counter is `unknown` — an earlier revision of this branch changed
  extraction to keep all-zero frames alive, and review rejected it because it
  reclassified spend settlement for placeholder frames.
- Deliberately NOT generation-scoped: quota/rate-limit avoidance
  (`health-store.ts`, `subagent-model-fallback.ts`). Those observations
  describe the subscription, not the token generation; scoping them to a
  credential refresh would re-hammer a known-drained account. The 401/403
  quarantine is already generation-fenced. Model static policy and live
  health were not mixed in either direction.

## Ownership boundaries respected

- Lane C owns send accounting (`sendCount`, request-wide send budget, stage
  and cause vocabulary). This lane consumes `loggedUsage`, provenance and
  the affinity enums and does not redefine any of them.
- Lane D owns #4793 and the per-model cache view; the diagnostic reuses the
  usage ledger's account label (salted, process-local) instead of inventing a
  new identifier.

## Adversarial review (pre-CI) and its dispositions

- HIGH, fixed: the carried entitlement-admission test kept its tests-root
  import paths after the domain move; all imports now resolve.
- HIGH, fixed: the diagnostic's block splitter aliased an array-valued
  `instructions` field and would have mutated the live request body; it now
  copies, pinned by a mutation regression test.
- MEDIUM, rejected with reason: persisted same-process equality tags were
  called a correlation key. The issue being closed explicitly requests
  process-scoped salted equality tags so two requests can be compared; the
  key dies with the process, the file is owner-only, and retention is bounded
  at 100 records. That is the requested design, not a breach of it.
- MEDIUM, accepted: the all-zero usage extraction change altered spend
  settlement semantics for placeholder frames; reverted. The measured-zero
  versus absent distinction needs no extraction change for any frame that
  reports tokens.
- Also fixed: a trailing blank line flagged by `git diff --check`.

## Exact-head CI at 55b512d2 and its dispositions

Run 35492856534 failed `gates`, `test 1/4`, `test 4/4` and `macos 1/2`. Three
distinct causes, none of them a flake:

- `gates` reported five typecheck errors. Two were mine and trivial:
  `cache-diagnostic.ts` narrowed `draft.promptCacheKey` through optional
  chaining and then read it again unguarded. Fixed by binding the inbound key
  once.
- The other three were the interesting ones, and they are the union class this
  batch keeps hitting. `catalog/effort.ts` and `catalog/build-entries.ts` cast
  a partially populated ladder to `Array<{ effort?: string }>` and then push a
  canonical `CODEX_REASONING_LEVELS` rung into it, which also carries
  `description`. That has always been a type error; it was invisible because
  `reasoning-effort.ts` → `providers/reasoning-metadata.ts` →
  `providers/key-store.ts` → the `../config` barrel formed an import cycle,
  and inside it the rung type degraded so the excess-property check never ran.
  Carried #5145 breaks that cycle on purpose — its new `api-key-resolve.ts` is
  a leaf module written so reasoning-metadata can import it without the barrel
  — so the latent error surfaced on this branch first. Neither file is in this
  lane's scope and neither is touched by its diff; the fix is the remedy
  `AGENTS.md` prescribes for a restated shape: `reasoning-effort.ts` now
  exports `CodexReasoningLevel`, and the three casts derive
  `Array<Partial<CodexReasoningLevel>>` from it instead of restating a
  narrower literal. Any lane that breaks this cycle would have hit the same
  wall.
- `test 4/4` (`production adapter contract rejects omitted translator budgets
  at typecheck`) spawns tsc over the project and asserts the valid fixture
  exits zero. It was downstream of the same five errors and needs no change of
  its own.
- `test 1/4` (`Cursor catalog discovery cooldown > second refresh during
  cooldown does not re-invoke discovery`) was a real regression from this
  lane. Scoping only the roster reads to the credential left the failure
  cooldown provider-wide, so the branch had to require a credential-scoped
  stale entry before honouring it — and a discovery that fails before caching
  anything has no stale entry, which reopened the timeout storm #54 closed.
  The fix moves the scope to where the observation actually belongs: a
  discovery failure now records the credential that observed it, and
  `isModelsFetchCoolingDown` suppresses only that credential. A failure
  recorded without an identity stays credential-agnostic and suppresses
  everyone, so plain-endpoint providers and the existing Qoder branch keep
  their current behaviour unchanged. This is the same thesis as the rest of the
  bundle: one account's 401 or 404 is not evidence about another account's
  catalog. `cursor-roster-account-scope.test.ts` already pins both halves.
- `macos 1/2` carried the same shard failures as the Linux shards.

The branch is now aligned on `dev` at `447ac22ca6` (lanes B and E landed).
Lane E's `run-turn-queue.ts` and `admission-model-scope.ts` do not overlap
this lane's surface; the merge was clean.

Run 35496444256 at `6bd074e0` confirmed both fixes: `test 1/4` and `test 4/4`
passed, along with every other shard, both macOS shards, `structure gate`,
`docker smoke`, `docs site build`, `api usage`, `storage policy`, keyring on
all three platforms and `npm-global` on all three. Only `gates` still failed,
on three GUI assertions, all of them the same restated-literal class and all
introduced by the carried #4793 columns:

- `usage-custom-range` listed the models-table headers as English literals and
  omitted the `API list-price` column the page already renders, so the case
  could not pass on any tree carrying both. The expectation now maps the
  ordered column keys through the `en` catalog, which is where that copy lives.
- The French accidental-English guard and the zh-TW stale-placeholder guard
  both flagged `usage.unavailable`, whose value is an em dash. Adding one more
  allowlist entry would have been literal-for-literal, so both checks now
  derive the rule from the value: with placeholders removed, a string carrying
  no letters has nothing to translate and is identical in every locale by
  construction. Keys that do carry letters, `uptime.hour` among them, stay
  allowlisted and still fail if they go untranslated.

## Verification

### The macOS sideband failure was shard composition, not the relay

`macos 2/2` then failed twice on `sideband GET /v1/live/{callId} relays the exact frame
ceiling bidirectionally`, and it is worth being precise about why, because retrying it would
not have helped and neither would touching its deadline.

The case relays a 50 MiB WebSocket frame end to end against a hard 15s deadline. It is not in
`SERIAL_FULL_SUITE_FILES`, so it runs inside `bun test --shard=N/2` sharing one process with
the rest of that half. On `dev` at `043aa435f` it lands in shard 1 and its echo leg alone
takes **7.4s of the 15s budget**. This branch adds three test files in unrelated directories,
Bun repartitioned the halves, `tests/server/server-live.test.ts` moved to shard 2, and the
echo leg went past 15s on both attempts while the peer never received the frame
(`recv=13 progress=5 moving=no`). Nothing in this lane's diff touches the sideband relay, the
live route or WebSocket handling, and the delta between the run that passed every shard and
the run that failed this one is three GUI test files and a devlog page.

So the test has been passing by accident: its result was a property of which half it drew.
The remedy is the mechanism the repository already has for this exact category —
`SERIAL_FULL_SUITE_FILES`, described in its own guard as quarantining *load-sensitive* files
into one-worker lanes. Adding `server/server-live.test.ts` there keeps the 15s deadline, keeps
the assertion, and keeps macOS in the matrix; it only stops the case from sharing a process.
It also takes the landmine out of the path of the next lane that adds a test file anywhere in
the tree. If the coordinator would rather own that change centrally, it is one line in
[scripts/test.ts](../../../scripts/test.ts) and can be lifted out of this branch.

Per batch rules, no local suites, individual tests, typecheck, build,
install or live `ocx` execution. Verification is static source review plus
exact-head hosted CI.

- NOT RUN: `bun run test`, focused `bun test`, `bun run typecheck`,
  `bun run lint:gui`, `bun run build:gui`, `bun run privacy:scan`,
  `bun run structure:check` (all forbidden locally; hosted CI decides).
- Static checks performed: file-size ratchet evaluated against
  `tests/fixtures/file-size-baseline.json` (the carried routing test would
  have grown 83 lines over its cap — moved to a registered sibling; all new
  files are far below the 2000-line threshold); both layout registries carry
  every new test file and parse as JSON; the ten GUI locale catalogs gained
  identical keys (no hand-restated roster or count); the diagnostic module's
  imports were walked for a `src/lab/` reach (none) and `responses/core.ts`
  gains no runtime import of it.
- Focused regression tests added next to the existing subsystem tests:
  roster credential binding (Cursor, Devin), cancelled-refresh fencing
  (admission + main-account refresh), measured-zero survival (usage
  passthrough), and the diagnostic itself (privacy, fingerprints, alias
  rebinding, retention, tag independence from affinity-debug).
