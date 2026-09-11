# wp3 — draft bug PR triage

Seven draft bug PRs, reviewed by an independent Sol lane. Verdicts and the exact
blocking defect for each.

## #3432 @luvs01 — lab file URI privacy bypass — DRIVE-TO-GREEN
`src/lab/events/limits.ts:36` rejects standalone `file:` schemes, but ASCII tab/newline
inside the scheme normalizes to a valid file URL and evades `FILE_URI_RE`
(`"fi\nle:///..."` -> `file:///...`). Fix: strip/normalize URL whitespace before the
scheme test, add those regressions. Privacy-sensitive admission logic; not an auth path.

## #3407 @turin-dev — integrations toggle truthfulness — DRIVE-TO-GREEN
PUT persists via `setCodexIntegrationEnabled` (`src/server/management/native-integration-routes.ts:309`)
but GET still feeds the stale startup `config` into `codexStatus`, and the UI trusts it
(`gui/src/pages/integrations/overview-clients.ts:239`), so the switch snaps back after a
live toggle. Also `gui/src/i18n/tr.ts:1523` mistranslates "resumable". Needs a
PUT-then-GET regression plus a rebase (33 behind).

## #3394 @kremnyi — Grok 4.6 Responses — DRIVE-TO-GREEN
Correct after three addressed review fixes. The `enforce-target` "failure" is a
cancelled run superseded by a higher-priority gate request, not a real failure.
Needs rebase + a fresh gate run + readiness boxes.

## #3388 @zleo-ai — Grok sparse terminal output — DRIVE-TO-GREEN
Opt-in, Grok-client-only snapshot reconstruction, fail-closed, well tested. 847 lines
but the production change is one coherent compatibility boundary. Needs rebase
(44 behind) and hosted CI evidence for its claimed-baseline failures.

## #3348 @RHODIZSECURITY — failover hardening — SUPERSEDE
2338 lines / 33 files / 8 commits spanning cooldown persistence, provider quota state,
API-key 401/429 rotation, lifecycle, stream preflight, policy fallback, and public
error contracts. Individual fixes are sound (hashed key identity at
`src/providers/key-failover.ts:88`, exhaustion normalization at
`src/server/responses/policy-fallback.ts:166`), but it changes multiple independent
invariants in one diff and still has a blocker: the duplicated target-incompatibility
matcher at `src/server/responses/core.ts:3936` omits the shared generic `tool_choice`
case, so some combo children abort instead of hopping. Security-review class (credentials,
401 handling, rotation, persistence). Split into a reviewable stack, every branch commit
carrying `Co-authored-by: RHODIZSECURITY`.

## #3332 @full999 — Claude combo capabilities + output budget — DRIVE-TO-GREEN
Output-budget handling at `src/adapters/anthropic.ts:904` is correct. Blocker: the
catalog fallback maps vendor `maxTokens` onto `maxInputTokens` at
`src/codex/catalog/provider-fetch.ts:907`, shrinking a 1M Claude input window to its
128k output ceiling. Fix the mapping to `maxOutputTokens`, assert the 1M window
survives, rebase (66 behind).

## #3325 @luvs01 — ignore fork PRs in dev bump guard — DRIVE-TO-GREEN (sponsorship)
The change is correct: an owner-qualified server-side `head` filter at
`.github/workflows/dev-version-bump.yml:129` stops a same-named fork branch from
satisfying the repository-owned idempotency guard. Both `hygiene` and `enforce-target`
fail for exactly one reason: `unsponsored_surface` — a workflow file needs maintainer
security review and the `maintainer-sponsored` label. This is a maintainer decision,
not a code defect.

## #3403 @ianlyoo — dotted ns.name tool echo — COLLISION REPAIR (carried from wp2)

Handed over by wp2. The PR is correct in intent and green on CI, but it inserts dotted
aliases into `toolNsMap` (`src/server/responses/collaboration.ts:136-143`) with no
collision detection. Independently verified: namespaces come straight from the inbound
Responses `tools` array — the schema accepts an arbitrary namespace object
(`src/responses/schema.ts:117`) and `parseRequest` copies any string namespace
(`src/responses/parser.ts:221`), while `isRepresentableName` rejects only control
characters (`src/responses/namespace-tool-compat.ts:34`). Dots are legal in both halves,
and the existing `NamespaceToolCollisionError` guard covers only the `ns__name` form.
So `{a, b.c}` and `{a.b, c}` both claim `a.b.c` and the later insertion wins, which can
dispatch a provider echo to the wrong client tool.

Repair: before registering a dotted alias, check whether it is already owned by a
different `{namespace, name}` identity; on conflict register neither dotted alias (fail
closed to the unambiguous `ns__name` form) rather than picking a winner. Same treatment
in `src/server/responses-undeclared-tool-guard.ts:98` so the guard never collapses two
identities into one grant.

The repair must satisfy three properties the auditor named, because a naive "skip the
second insertion" implementation would still be wrong:

1. ORDER-INDEPENDENT. Meeting the second owner must REMOVE or tombstone the first dotted
   registration, not merely decline the second. Otherwise the winner depends on
   declaration order in the caller's tools array, which is attacker-influenced.
2. OWNERSHIP INCLUDES ALL SPELLINGS. The conflict check compares against bare and
   canonical `ns__name` wire names too, not only other dotted aliases — a dotted alias
   that shadows an existing bare or canonical name is the same authorization confusion.
3. THE LEGITIMATE CASE SURVIVES. A uniquely owned dotted alias is still registered, so
   the `default.apply_patch` echo that #3402 reported keeps working. Only ambiguous
   spellings are suppressed, and both canonical forms always remain available.

Regression coverage in `tests/responses-undeclared-tool-guard.test.ts`: the existing
unique-dotted case must keep passing; add an ambiguous catalog asserted in BOTH
declaration orders (proving order-independence), and a dotted-versus-bare and
dotted-versus-canonical collision case, each asserting no cross-identity authorization.
Execution: push onto `ianlyoo:fix-dotted-tool-alias` (`maintainerCanModify` true) so
@ianlyoo stays the PR author; otherwise a successor PR with a `Co-authored-by` trailer.

## Accept criteria
Terminality follows the rule settled in `000_research.md` §"What terminal means".
- #3403 specifically must reach MERGED or CLOSED. Its blocker is a code defect this
  session can fix and its author granted `maintainerCanModify`, so no external
  dependency justifies leaving it live. wp2 already committed to that stronger bar and
  wp3 inherits it verbatim.
- every other listed PR reaches MERGED, CLOSED, or a live PR whose ONLY remaining gate is
  maintainer CI or a maintainer decision this session cannot make (sponsorship for a
  workflow surface, product intent), with that gate named and its artifact posted.
- a posted review alone does NOT discharge an item; the reason must be a named terminal
  outcome (BLOCKED / NEEDS_HUMAN / UNSAFE) with evidence, visible on the PR.
- any superseding branch carries a `Co-authored-by:` trailer for the original author
- workflow-surface changes get an explicit sponsorship decision recorded
