# Lane B — bug-labelled PR triage (#3489, #3484, #3480, #3469, #3407, #3388, #3348)

Read-only adversarial review. Worktree `/private/tmp/ocx-closeout.xomWAA/wt`, detached at
`origin/dev` = `0f27bbeb3ce6a92077652695e161d49b88eedc7a` ("test(hygiene): fail on duplicate test
basenames, and close out the 429 unit (#3527)"). Every PR head was fetched with
`git fetch origin pull/<n>/head`; no checkout of `dev` was performed and no tracked file was
modified. Index re-read immediately before verdict (see "Index re-read" at the bottom).

## Summary

| Item | Disposition | One-line reason |
| --- | --- | --- |
| #3489 | LAND_WITH_FIX | Approved, fully green CI on exact head, real SSRF-safe fix; conflict is only the `tests/providers/` rename plus one comment-line drift. |
| #3484 | LAND_AS_IS | Mergeable, green, defect proven at [integration-routes.ts:379](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/integration-routes.ts:379); only `BLOCKED` on a missing approval. |
| #3480 | LAND_AS_IS | Author rebased mid-review onto `0f27bbeb3`: now MERGEABLE, test correctly in `tests/adapters/google/`, escape bug fixed; only needs the stale `CHANGES_REQUESTED` dismissed and CI to finish. |
| #3469 | LAND_WITH_FIX | Approved, green, defect reproduced live on dev; conflict is purely the two `tests/adapters/google/` renames. |
| #3407 | REIMPLEMENT | Real config-path defect, but draft with 5 failing CI jobs on its exact head, 121 commits behind, and a tracked 166 KB PNG that does not belong in the tree. |
| #3388 | DEFER | Draft, 132 commits behind, test shards never ran, and a 327-line client-specific stream rewriter lands on the protected `responses/core.ts` path with no maintainer review yet. |
| #3348 | REIMPLEMENT | Generic 410/413 are correctly terminal now, but the 2165-line diff bundles unrelated disk-persistence and a silent policy-fallback status change; land a bounded classification-only subset. |

## Cross-cutting finding: the `tests/<domain>/` migration is the conflict source

Six of the seven "CONFLICTING" states are not semantic. Between `8b6e4542a` and `0f27bbeb3`, dev
moved most of `tests/` into `tests/<domain>/` and added a guard,
[test-layout.test.ts](/private/tmp/ocx-closeout.xomWAA/wt/tests/test-layout.test.ts:20), that fails
if a file resolves to a migrated domain but still sits at the root. Resolution is mechanical: apply
each PR's test hunk to the file's **new** path and rewrite relative specifiers one level deeper
(`../src/` -> `../../src/`). Resolver output for every touched test file:

| PR | Test file | New path on dev | Migrated |
| --- | --- | --- | --- |
| #3489 | `provider-model-discovery-contract.test.ts` | `tests/providers/` | yes |
| #3489 | `command-code-fakeip-discovery.test.ts` (new) | `tests/providers/` | yes |
| #3484 | `management-integration-journal-delete.test.ts` | `tests/` root | no |
| #3480 | `google-adapter.test.ts` | `tests/adapters/google/` | yes |
| #3469 | `google-errors.test.ts`, `google-vertex-http.test.ts` | `tests/adapters/google/` | yes |
| #3469 | `error-fidelity.test.ts` | `tests/` root | no |
| #3407 | `native-codex-toggle.test.ts` | `tests/codex-integration/` | yes |
| #3388 | both snapshot-repair tests | `tests/responses/` | yes |
| #3348 | 10 of 16 test files | 6 different domains | yes |

A new test file must also be placed at its resolved target, so #3489's new
`command-code-fakeip-discovery.test.ts` has to be created under `tests/providers/`, not the root.

## Stack order

Only two real file-level dependencies exist in this lane:

- **#3388 and #3348 both edit `src/server/responses/core.ts`.** #3388 adds a rewriter to the
  `blockRewrites` list around line 4785; #3348 rewrites ~268 lines of the same file. Whichever
  lands first forces a manual rebase of the other. Since #3348 is a REIMPLEMENT and #3388 a DEFER,
  neither blocks the other today.
- **#3407 and #3484 both edit `gui/src/pages/integrations/IntegrationsOverview.tsx`.** #3484 adds a
  404-reconciling catch inside the delete dialog; #3407 rewrites the toggle/consequence-dialog
  wiring. They touch different regions but the same file: land **#3484 first** (it is
  merge-clean), then rebase the #3407 reimplementation on top.

#3489, #3480 and #3469 are independent of every other item. #3469 and #3480 both touch the Google
adapter area but different files (`google-errors.ts`/`google-http.ts`/`lib/errors.ts` vs
`google.ts`), so they can land in either order.

---

## #3489 — fix(discovery): allow canonical model endpoints through fake-IP TUN DNS

**Disposition: LAND_WITH_FIX**

| Field | Value |
| --- | --- |
| Head SHA | `dbcfde8ca445c8dd04b04932904798664aae9cab` |
| Base / merge-base | `dev` / `56a084aa9` (22 behind, 3 commits) |
| Mergeable | `CONFLICTING` / `DIRTY` |
| CI on exact head | **fully green** — 24 checks including all 4 test shards, macOS 15m41s, gates, storage policy, react-doctor |
| Review | `APPROVED` by Ingwannu after explicit security-boundary review |
| Author | Flowershangfromthebranches |

**Defect.** `resolvePublicAddresses` only tolerates Clash/Surge fake-IP (198.18.0.0/15) DNS answers
when an outbound proxy env is configured. On dev,
[provider-outbound.ts:157](/private/tmp/ocx-closeout.xomWAA/wt/src/lib/provider-outbound.ts:157)
passes `allowBenchmarkAddresses: proxyConfigured && !noProxyMatches(parsed)`. In TUN mode there is
no proxy env, so every model-discovery fetch to a canonical endpoint is rejected even though the TUN
intercepts the fake-IP destination itself and the request would succeed.

**Fix shape.** A new `isRegistryModelDiscoveryUrl` proves the *final request URL* equals the
registry's own fixed discovery URL, and that proof is injected into the transport as a dependency
(`isCanonicalUrl`), defaulting to `() => false` so a caller that forgets the seam fails closed.

**Security review (this is the part that matters).** The exception is genuinely narrow, and I tried
to break it:

- Proof is on the URL, not the provider name — correct, because an OAuth/forward name matches any
  `baseUrl` by design, so a renamed custom row pointing at an attacker host gets no exception.
- `protocol !== "https:"`, `username`/`password`, and `hash` are all rejected outright.
- Query equality is exact (`candidate.search === expected.search`), so `?token=` smuggling on an
  otherwise-canonical origin+path is rejected. A missing or extra parameter is also rejected.
- Literal `198.18.x.x` URLs never reach the exception; the literal gate in `resolvePublicAddresses`
  rejects first.
- `noProxyMatches` still short-circuits to `false`, so a `NO_PROXY` direct route keeps the
  benchmark answer rejected.
- `privateNetwork` is untouched, so the private-network gate and image/Lab fetch paths are
  unchanged (they never pass the flag).

I could not construct a path where a non-registry destination gains the exception. No privacy,
Node-only-API, or unrelated-churn problems in the diff.

**Test evidence.** Yes — `tests/command-code-fakeip-discovery.test.ts` (378 lines, new) plus 60
lines added to `tests/provider-model-discovery-contract.test.ts`. These are RED on dev because
`isRegistryModelDiscoveryUrl` does not exist there at all (`git grep` on `0f27bbeb3` returns
nothing), so the import fails outright.

**Conflict.** Mechanical. Two causes, both trivial:

1. `tests/provider-model-discovery-contract.test.ts` moved to `tests/providers/` on dev; the new
   `command-code-fakeip-discovery.test.ts` must also be created there.
2. `src/codex/catalog/provider-fetch.ts` — the only overlapping source file — changed on dev in
   exactly one line, and it is a **comment**: `8b6e4542a` rewrote a test path inside a comment at
   line 720. The PR's own hunk at line ~1669 is untouched by dev.

**Fix list.**

1. Rebase onto `0f27bbeb3`; take dev's side of the `provider-fetch.ts` comment line.
2. Move both test files to `tests/providers/` and rewrite `../src/` -> `../../src/`.
3. Re-run `bun test tests/providers/` and typecheck on the rebased head.

---

## #3484 — fix(integrations): reconcile journal deletion cleanup

**Disposition: LAND_AS_IS**

| Field | Value |
| --- | --- |
| Head SHA | `a4c50d104778d2ac11fc4c91b29b3e505cb68c2a` |
| Base / merge-base | `dev` / `066146980` (27 behind, 1 commit) |
| Mergeable | **`MERGEABLE`** / `BLOCKED` |
| CI on exact head | **fully green** — 24 checks, all 4 test shards, macOS 16m1s |
| Review | `REVIEW_REQUIRED` (this is the only thing `BLOCKED` means here) |
| Author | Ingwannu |

**Defect — two of them, both proven on dev.**

1. **Stale prune-failure marker.** At
   [integration-routes.ts:379](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/integration-routes.ts:379)
   dev reads `if (!pruned.ok) store.markPruneFailure(...)` with no success branch. A successful
   prune therefore never clears an earlier failure marker, so `retentionDegraded` stays latched
   forever. This is provably an oversight rather than a design choice: the *other* two call sites
   already pair the clear with the prune —
   [journal.ts:180](/private/tmp/ocx-closeout.xomWAA/wt/src/integrations/journal.ts:180) and
   [store.ts:97](/private/tmp/ocx-closeout.xomWAA/wt/src/integrations/store.ts:97) both call
   `clearPruneFailure` on `pruned.ok`. The route handler is the one place that forgot.
2. **404 dead-end in the GUI.** `integration_operation_not_found` exists on dev
   ([integration-routes.ts:343](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/integration-routes.ts:343))
   but no client-side predicate consumes it, so a second tab completing the same delete leaves the
   first tab's dialog offering a retry that can only 404 again.

**Test evidence.** Yes — `tests/management-integration-journal-delete.test.ts`, test *"a successful
delete-triggered prune clears an older failure marker"*. It marks a failure, deletes, and asserts
`pruneFailures.hermes` is `undefined`. On dev that assertion fails because nothing ever clears the
marker. `gui/tests/integrations-surfaces.test.tsx` adds 69 lines covering the 404 reconcile path.

**Blockers.** None found. The server change is two lines and preserves the documented post-commit
ordering; `isMissingJournalEntry` is a narrow `instanceof` + status + code check, not a message
match. Docs are updated in all 8 locales, matching the repo's docs-sync rule. The
`gui-screenshot-waived` label is already applied, so the `gui` screenshot gate is satisfied.

**Conflict.** None — this is the only `MERGEABLE` item in the lane, and its test file resolves to
the `server` domain, which has **not** been migrated yet, so the root path stays correct.

**Dependency.** Touches `IntegrationsOverview.tsx`, which #3407 rewrites. Land this first.

---

## #3480 — fix(google): steer Google models away from unrendered LaTeX math formatting

**Disposition: LAND_AS_IS**

> **The author rebased this PR while the lane was in progress.** My first pass reviewed
> `63623c64` (31 behind, CONFLICTING). The current head is `74ef8faae`, rebased onto
> `0f27bbeb3`, and it is now `MERGEABLE` with the test already in its migrated location. The
> disposition below reflects the **new** head; the mechanical-rebase fix I had listed is done.

| Field | Value |
| --- | --- |
| Head SHA | `74ef8faaed94d61835a6ffbade7bdc345829408b` (was `63623c64`) |
| Base / merge-base | `dev` / `0f27bbeb3` — 1 behind, 1 commit |
| Mergeable | **`MERGEABLE`** / `BLOCKED` (blocked only by the stale review) |
| CI on exact head | in flight — `hygiene`/`label`/`resolve-pr` pass; `enforce-target` and CodeRabbit pending. Shards had not started at re-read time. |
| Review | `CHANGES_REQUESTED` (Ingwannu) — **stale**, see below |
| Author | benedictusrey |

**Defect.** Google-family models emit `$...$`, `\\(...\\)`, `\\text{}` etc., which the Codex desktop
markdown renderer does not render (no KaTeX/MathJax), so the raw delimiters stay on screen. Dev's
`GOOGLE_BREVITY_INSTRUCTION`
([google.ts:49](/private/tmp/ocx-closeout.xomWAA/wt/src/adapters/google.ts:49)) has four bullets and
says nothing about formatting; `git grep -i latex` on `0f27bbeb3` returns nothing. Defect confirmed
present.

**The `CHANGES_REQUESTED` is stale — I verified this byte-exactly.** The reviewer's objection was
that single-backslash `\text{}` in a normal JS string becomes a tab at runtime. On the current head
`63623c64`, `git show tmp-pr-3480:src/adapters/google.ts` line 55 contains `\\(...\\)`,
`\\text{}`, `\\times`, `\\le`, `\\ge` — properly escaped — and the test now uses `String.raw`
for both assertions, making them independent of the source spelling. The requested fix is genuinely
in. The review state simply was never re-dismissed.

**Test evidence.** Yes — `tests/google-adapter.test.ts`, *"systemInstruction includes formatting
guidance against unrendered LaTeX math"*. It would be RED on dev: I ran
`bun test tests/adapters/google/google-adapter.test.ts` at `0f27bbeb3` (32 pass / 0 fail) and dev's
instruction string contains no LaTeX text at all, so `toContain` cannot match.

**Blockers.** The real blocker is **CI coverage, not code**. Only 5 non-test checks ran on this
head; the test shards, `gates`, and macOS never executed. An approval here would rest on the
author's local claim ("33 pass, 0 fail"), which per the repo's own gate description is an
unverifiable author attestation. No security, privacy, or Node-only concerns — it is a
one-line prompt string plus one test.

One judgment note worth flagging: this steers Google models globally, including for non-Codex
clients that *can* render LaTeX. That is a deliberate product tradeoff the maintainer already
endorsed in the review thread (priority 50/80), so I am not treating it as a blocker.

**Conflict.** **None.** The rebase already happened: the new head's diff is exactly two files,
`src/adapters/google.ts` (+1) and `tests/adapters/google/google-adapter.test.ts` (+10) — the test
is in its migrated location with correct specifiers. Nothing left to reconcile.

**Remaining actions (none are code changes).**

1. Ask Ingwannu to dismiss the now-satisfied `CHANGES_REQUESTED`; it is the only thing holding
   `BLOCKED`.
2. Let the in-flight run finish and confirm green `test 1..4/4` + `gates` before merge — this head
   is the first one that will actually exercise the shards.

---

## #3469 — fix(google): classify "User location is not supported" as location/permission error

**Disposition: LAND_WITH_FIX**

| Field | Value |
| --- | --- |
| Head SHA | `e11089af85f8c1da4e67fe388b768d09078e8dcb` |
| Base / merge-base | `dev` / `1a5c9ab23` (37 behind, 2 commits) |
| Mergeable | `CONFLICTING` / `DIRTY` |
| CI on exact head | **green** — 25 checks incl. shards 1/4 and 2/4, macOS 15m32s, gates, linux-systemd, macos-launchd, windows-schtasks |
| Review | `APPROVED` (Ingwannu) |
| Author | agentHits |

**Defect — reproduced live, not inferred.** I executed dev's classifier directly:

```
classifyError(400, "upstream_error", "User location is not supported for the API use.")
  -> { type: "invalid_request_error", code: "invalid_request_error" }
classifyError(403, "location_not_supported", "Region is not supported")
  -> { type: "permission_error", code: "permission_denied" }
```

A geo-blocked account is told its *request* was malformed. The cause is
[errors.ts:272](/private/tmp/ocx-closeout.xomWAA/wt/src/lib/errors.ts:272): the generic stop-list
matches `"invalid request"`/`"not found"` and there is no location branch anywhere in the file
(`git grep -i location` on `0f27bbeb3` in `src/lib/errors.ts` returns nothing).

**Fix shape.** Adds `LOCATION_UNSUPPORTED_PATTERNS` + `isLocationUnsupportedMessage` to
`src/lib/errors.ts`, a `permission_error`/`location_not_supported` branch placed *before* the
generic invalid-request branch, a shared re-export in `google-errors.ts` (so adapter and lib cannot
drift), and a `console.warn` hinting at TUN/IPv6 leak when the rejection is geo-based.

**Falsification attempt.** CodeRabbit worried the matcher was too broad. It is not: every pattern
requires an explicit `location`/`region`/`country` cue, and the PR's own test asserts the negative
case `isLocationUnsupportedMessage("not supported for the api use") === false`. Matching is on a
single lowercased copy, so mixed case is handled once. The warning goes to `console.warn` with a
static string — no request body, key, or account identifier — so `privacy:scan` is unaffected.

**Test evidence.** Yes, three files, all RED on dev: `tests/error-fidelity.test.ts` (asserts
`code: "location_not_supported"`, which dev returns as `invalid_request_error` — proven above),
`tests/google-errors.test.ts` (imports `isGoogleLocationUnsupportedText`, which does not exist on
dev), and `tests/google-vertex-http.test.ts` (positive + negative warning assertions).

**Blockers.** None. Note the shard matrix shows only `test 1/4` and `test 2/4` in the check list;
shards 3 and 4 are absent from the run rather than failing. Worth confirming on the rebased head.

**Conflict.** Mechanical: `google-errors.test.ts` and `google-vertex-http.test.ts` both moved to
`tests/adapters/google/`. `error-fidelity.test.ts` resolves to the unmigrated `server` domain and
stays at the root. No source file overlaps dev.

**Fix list.**

1. Rebase onto `0f27bbeb3`; move the two Google test hunks into `tests/adapters/google/` with
   `../../../src/` specifiers; leave `error-fidelity.test.ts` at root.
2. Confirm all four shards run green on the rebased head.

---

## #3407 — fix(integrations): make Codex dashboard toggle truthful

**Disposition: REIMPLEMENT**

| Field | Value |
| --- | --- |
| Head SHA | `38d45300a644dd0aa641a0a9b76f293169ab8ef9` |
| Base / merge-base | `dev` / `ea3231a82` (**121 behind**, 2 commits) |
| Mergeable | `CONFLICTING` / `DIRTY` |
| CI on exact head | **FAILING** — `ci`, `gates`, `macos`, `test 1/4`, `test 2/4` all fail |
| Review | `REVIEW_REQUIRED`; **draft**; CodeRabbit skipped (draft) |
| Author | turin-dev |

**Defect is real and worth fixing.** On dev,
[native-integration-routes.ts:686](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/native-integration-routes.ts:686)
calls `codexStatus(config, getConfigPath())` — it hands the **opencodex** config path to the
**Codex** client status. `codexStatus`
([native-integration-routes.ts:164](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/native-integration-routes.ts:164))
writes that straight into `configPath`, so the dashboard reports the wrong file for the Codex row,
while `claudeStatus` on the same line legitimately uses `getConfigPath()`. The PR's one-line fix
(`join(getCodexHome(), "config.toml")`) is correct. A second real defect: the switch renders
`row.applied` (observed routing) rather than `desiredEnabled`, so the toggle can contradict the
user's setting.

**Why REIMPLEMENT rather than LAND_WITH_FIX.**

1. **Five CI jobs fail on the exact head**, including `gates` and two test shards. This is not a
   layout-rename artifact — those would surface as conflicts, not test failures — so there is a
   genuine unresolved regression to diagnose.
2. **121 commits behind dev**, and the overlap is the widest in the lane: all 9 i18n locale files,
   `IntegrationsOverview.tsx`, `gui/tests/integrations-surfaces.test.tsx`, and the
   `codex-integration` guide. i18n files are append-heavy and conflict badly.
3. **A 166 KB PNG is committed to `docs/pr-assets/3407-codex-disable-dialog.png`.** The `gui`
   screenshot requirement asks for a screenshot *in the PR description*, not a binary tracked in the
   repository. This is unrelated churn and should not land.
4. The `codexRow` rewrite carries a backward-compatibility branch for `nativeSettled === undefined`
   that exists only to keep older callers working — dead weight in a reimplementation that can
   update the callers.

**Test evidence.** `tests/native-codex-toggle.test.ts` (+17) and `gui/tests/` (+148) exist and would
be RED on dev for the config-path assertion. They are worth carrying, but they currently fail on the
PR's own head, so they cannot be trusted as-is.

**Fix list for the reimplementation.**

1. Carry the one-line `codexConfigPath` fix and the `toggleOn = row.toggleOn ?? row.applied` switch
   correction onto current dev.
2. Carry the `codexResource.refresh()` addition and the `"codex"` case in `blockedText`.
3. Add `CODEX_DISABLE_COPY` and the 6 i18n keys across all 9 locales, applied to current dev's i18n
   files.
4. Drop the tracked PNG; put the screenshot in the PR description instead.
5. Drop the `nativeSettled === undefined` compatibility branch; update callers directly.
6. Place the test at `tests/codex-integration/native-codex-toggle.test.ts`.
7. **`Co-authored-by: turin-dev`** trailer is mandatory per AGENTS.md — a prose mention is not
   equivalent, and `missing_coauthor_credit` exists specifically to stop the CREDITS.md list from
   growing.

**Dependency.** Rebase after #3484 lands (shared `IntegrationsOverview.tsx`).

---

## #3388 — fix(responses): repair sparse terminal output for Grok Build

**Disposition: DEFER**

| Field | Value |
| --- | --- |
| Head SHA | `007076ebd528c50ad5742e6eb0208300385cded7` |
| Base / merge-base | `dev` / `e71386434` (**132 behind**, 1 commit) |
| Mergeable | `CONFLICTING` / `DIRTY` |
| CI on exact head | **only 5 checks** — `enforce-target`, `hygiene`, `label`, `resolve-pr`, CodeRabbit (skipped: draft). No shards, no gates, no macOS. |
| Review | `REVIEW_REQUIRED`; **draft** |
| Author | zleo-ai |

**The problem is plausible and the implementation is careful.** Grok Build renders text deltas live
but builds its durable assistant turn from `response.completed.response.output`; a native Responses
stream can put the items in `output_item.done` and finish with an empty array, so Grok classifies a
visibly-streamed answer as empty and replays a billable turn.
`createGrokResponsesSparseTerminalBlockRewrite` does not exist on dev, so the gap is real.

The rewriter is genuinely fail-closed: it taints on malformed JSON, gaps, duplicate indices,
add/done identity mismatch, byte-budget overflow, or any open item at terminal; it requires
contiguous indices from zero, at least one *visible* item, and an absent-or-empty terminal output;
and it never promotes synthesized or field-repaired items. It correctly leaves the provider opt-in
repair untouched and does not import `src/lab/`.

**Why DEFER anyway — the reasons are procedural, and they are decisive.**

1. **327 new lines land on `src/server/responses/core.ts`**, one of the three files AGENTS.md names
   as carrying every user's request path. That file demands full-suite evidence. This head has
   **never run a single test shard**.
2. **Draft, 132 commits behind, no human review**, and CodeRabbit was skipped because of the draft
   state. There is no reviewed judgment on this design at all yet.
3. **The gate is `logCtx.surface === "grok"`, a client marker, not a provider opt-in.** That means
   every Grok-surface stream on any provider gets a terminal rewriter. Dev uses that same marker for
   `heartbeatStyle` ([core.ts:5698](/private/tmp/ocx-closeout.xomWAA/wt/src/server/responses/core.ts:5698)),
   so the precedent exists — but broadening it from a heartbeat cosmetic to *rewriting the terminal
   response body* is a materially larger claim that deserves an explicit maintainer decision.
4. It conflicts with #3348 on the same file.

**This is a "not yet", not a "no".** The concrete unblock is: bring it onto current dev, take it out
of draft so the full matrix and CodeRabbit run, move both tests to `tests/responses/`, and get a
maintainer ruling on the client-marker gate. The 481 lines of new tests are thorough and would be RED
on dev (the export does not exist), so the work is not wasted.

---

## #3348 — fix(combos): harden failover across quotas, credentials, and streams

**Disposition: REIMPLEMENT** (a bounded subset is landable; the whole is not)

| Field | Value |
| --- | --- |
| Head SHA | `a64ed325020afc48584bed751ce818ab42d2c338` |
| Base / merge-base | `dev` / `c91c8c5b2` (10 behind, **12 commits**, 35 files, +2165/-196) |
| Mergeable | `CONFLICTING` / `DIRTY` |
| CI on exact head | **only 5 checks** — `enforce-target`, `hygiene`, `label`, `resolve-pr`, CodeRabbit. **No shards, no gates, no macOS**, despite the `review-ready` label. |
| Review | `REVIEW_REQUIRED` |
| Author | RHODIZSECURITY |

### The 410/413 question: resolved, and the answer is no

**Generic HTTP 410 and 413 becoming retryable is NOT present in the current head.** I verified both
by executing dev's classifier and reading the PR's:

Dev baseline (executed):

```
comboFailureDecision(410, "resource is gone")      -> stop
comboFailureDecision(413, "request too large")     -> stop
comboFailureDecision(410, "...end of life...")     -> hop   (lifecycle, intended)
comboFailureDecision(413, "refused", input_admission_refused) -> hop (intended)
```

In the PR, `isModelLifecycleGone` still requires `status === 410` **plus** a structured lifecycle
code or explicit model+lifecycle prose, and the hop status list is
`[401, 402, 403, 404, 408, 425, 429]` — 410 and 413 are absent. The PR's own tests assert
`comboFailureDecision(410, "resource is gone") === "stop"` and
`comboFailureDecision(413, "request too large") === "stop"`, and add a server-level test *"generic
410 remains terminal before backup"* expecting a 410 response. The earlier concern was addressed.

There is a related but *different* change: `comboFailureCooldownScope` now returns the new
`"none"` scope for `status === 413` and request-shape codes, so an oversized request no longer cools
a healthy target. That is a correct refinement, not a retryability change.

### The landable subset

Genuinely valuable and reviewable on its own — a classification-only PR of roughly 150 lines:

- `comboFailureCooldownScope` gaining `"none"` for request-shape failures (413,
  `input_admission_refused`, `context_length_exceeded`, `tool_catalog_too_large`,
  `cursor_root_envelope_limit`, `target_incompatible`) and `"provider"` for 401/402/403 and
  credential/billing codes.
- `comboFailureDecision` recognizing `model_not_found`/`model_unavailable`/`unsupported_model` as
  target-local hops, and adding 402/425.
- Moving `free_rate_limited` out of provider-scoped quota into a request-local free-prompt cap
  (`isRequestLocalFreePromptCap`) — dev currently cools an entire provider for a per-request cap.
- `"malformed upstream" -> 502` in `inferHttpStatusFromAdapterMessage`
  ([errors.ts:365](/private/tmp/ocx-closeout.xomWAA/wt/src/lib/errors.ts:365)) — upstream garbage is
  a provider failure, not a client error.
- The missing `!isComboTargetInCooldown(...)` predicate in `pickComboTarget`
  ([resolve.ts:155](/private/tmp/ocx-closeout.xomWAA/wt/src/combos/resolve.ts:155)) — dev cools a
  target and then picks it anyway. This is a clear standalone bug.
- `key-401` added to `AttemptRecoveryKind` and `COOLDOWN_RECOVERY_KINDS`.

### What must NOT ride along

1. **Two new disk-persistence modules** (`src/combos/cooldown-disk.ts`,
   `src/providers/key-cooldown-disk.ts`, ~177 lines) plus `startServer` hydration and shutdown
   flush. New on-disk state files in the config dir are their own design decision and deserve their
   own review.
2. **Blocker — the debounce timers are not `unref()`'d.** Both modules do
   `persistTimer = setTimeout(..., 250)` with no `unref`. Every other debounced persister in this
   repository unrefs: `(persistTimer as { unref?: () => void }).unref?.()` at
   [state.ts:1573](/private/tmp/ocx-closeout.xomWAA/wt/src/responses/state.ts:1573) and
   [google-antigravity-replay.ts:224](/private/tmp/ocx-closeout.xomWAA/wt/src/adapters/google-antigravity-replay.ts:224),
   the latter commented "never keep the process alive". A pending 250 ms timer can hold the event
   loop open at exit. Must be fixed before any version of this lands.
3. **A silent behavior change in `policy-fallback.ts` that is not in the PR title.** Dev returns the
   last upstream response when candidates are exhausted
   ([policy-fallback.ts:161](/private/tmp/ocx-closeout.xomWAA/wt/src/server/responses/policy-fallback.ts:161):
   `if (!next) return response;`). The PR replaces it with a synthesized 503
   `policy_unavailable` (or 413 `policy_input_too_large`), **discarding the real upstream status and
   body**. It also converts two `return overload` paths into `response = overload`, letting a pacing
   overload continue the hop loop. Both are defensible, both change client-visible behavior, and
   neither is announced. They need their own PR.
4. `exhaustedQuotaRecoveryMs` reading cached provider quota to derive multi-day key cooldowns — a
   31-day cooldown ceiling driven by cache is a big lever; separate review.
5. The `cooldownKey` signature change from `keyId` to raw `apiKey` (hashed internally via
   `apiKeyPoolEntryId`). Privacy is fine — persisted rows carry only 8-char SHA-256 prefixes, and
   `isSafeCooldownRowKey` enforces `/^[0-9a-f]{8}$/` — but passing raw secrets through more call
   sites is a widened surface that deserves deliberate sign-off.

**Test evidence.** Substantial (+1200 test lines across 16 files) and much of it would be RED on dev.
But 10 of those 16 files moved into 6 different domain directories on dev, so this is the worst
rebase in the lane.

**Blockers summary.** Unreffed timers (must fix); undisclosed policy-fallback status change (must
split); `src/server/index.ts` hydration — I checked this against the AGENTS.md synchronous-activation
invariant and it is **fine**: both hydrate calls are synchronous and sit at line ~650, far before
`Bun.serve` at line 2367 and the `labActivationRequired` gate at 2516, so no `await` is introduced
into the protected window. No privacy or Node-only-API violations found.

**Fix list for the reimplementation.**

1. Cut PR A: classification-only (the subset above) onto current dev, tests placed in their migrated
   domains. This is reviewable and independently valuable.
2. Cut PR B: disk persistence, **with `unref()` on both timers** and an explicit decision on the two
   new config-dir state files.
3. Cut PR C: the policy-fallback exhaustion/pacing semantics change, described honestly in the title
   and description.
4. `Co-authored-by: RHODIZSECURITY` on every carried piece.
5. Push so the full shard matrix actually runs; the `review-ready` label is currently not backed by
   any test evidence.

---

## Index re-read before verdict

Re-read immediately before issuing verdicts, and **it caught two changes** — recording them rather
than reporting a stale snapshot:

1. **dev advanced** `0f27bbeb3` -> `6580694c7` ("test(oauth): restore a deleted contract test, and
   fail when one disappears (#3530)"). That commit touches only `tests/repo-hygiene.test.ts` and
   `tests/routing/anthropic-quorum-cache.test.ts`, so **no finding in this document is affected**:
   no lane PR touches either file, and every cited `src/` line is unchanged between the two dev
   commits.
2. **#3480 was rebased by its author mid-review**, from `63623c64` (CONFLICTING, 31 behind) to
   `74ef8faae` (MERGEABLE, 1 behind). Its section and the summary row were rewritten against the
   new head; the disposition moved LAND_WITH_FIX -> LAND_AS_IS.

Other verification state at re-read:

- `git status --porcelain`: clean apart from this new file.
- The other six head SHAs are unchanged: `dbcfde8ca`, `a4c50d104`, `e11089af8`, `38d45300a`,
  `007076ebd`, `a64ed3250`. GitHub reported `mergeable=UNKNOWN` for them at re-read because it was
  recomputing merge state against the new dev tip; the `CONFLICTING` states above were read on
  `0f27bbeb3` and the conflict *causes* (the `tests/<domain>/` renames) are unchanged by `#3530`.
- No `src/`, `tests/`, or `gui/` file was modified; no repository-wide suite was run. Focused runs
  only: `tests/adapters/google/google-adapter.test.ts` (32 pass), `tests/server/error-fidelity.test.ts`
  + `tests/adapters/google/google-errors.test.ts` (10 pass), plus two direct `bun -e` evaluations of
  `classifyError` and `comboFailureDecision` on dev.
