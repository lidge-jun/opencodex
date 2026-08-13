# 060 — adopt-with-changes replacements: #1155, #1152, #1169

Three PRs with correct intent and a specific defect each. The defect is named
before implementation so the replacement is not a re-post of the original.

## #1155 — web-search buffered upstream policy

Intent: preserve the buffered-upstream policy through the web-search loop
instead of forcing streaming (the bypass behind closed issue #1143).

Two problems in the author's diff:

1. It routes through `openai-responses.parseResponse`, which is compaction-only
   and rejects function-call-only payloads at
   `src/adapters/openai-responses.ts:1286-1293`. The PR's test uses OpenAI Chat,
   which masks it — a Responses turn carrying only a function call is exactly
   the web-search case.
2. Buffered adapter batches are retained but never released when intercepted, so
   repeated search iterations accumulate leases.

Targets: `src/server/responses/core.ts:2519-2533`;
`src/web-search/loop.ts:243-285,364-412,536-560`;
`src/web-search/progress-stream.ts:29-35,139-156,218-230`;
`tests/web-search.test.ts:557`; `tests/web-search-progress-stream.test.ts:124`.

Tests:

- `buffered Responses web-search preserves function calls` — an
  `openai-responses` function-call-only turn dispatches the sidecar and completes
  downstream as SSE.
- `buffered intercepted iterations release translated leases` — repeated
  iterations under a small translator budget do not accumulate discarded
  batches.

Also correct the five locale docs, which claim absolutely that all events are
buffered.

## #1152 — account picker selector initialization

The namespace and collision-detection foundations are sound and drew no
substantive review objections. But `initializeDefaultCodexAccountNamespaces` has
no production caller, so the PR title promises behavior the diff does not
deliver.

An earlier draft of this doc said to invoke it "inside the explicit
picker-enable transaction". The audit found no such transaction exists. In the
current tree `codexAccountPickerEnabled` appears only as schema and validation
(`src/config.ts:1065`, `:1720-1722`, `:1957-1981`), a type
(`src/types.ts:807`), and a read helper
(`src/codex/account-namespaces.ts:155-158`). No management route writes it, and
`src/server/management/routing-profile-routes.ts:303-339` creates and updates
routing profiles — an unrelated surface.

So there are two honest options, and the choice must be made before coding:

**(a) Foundations-only.** Retitle the replacement to match what it does — add
namespace allocation and collision detection with no caller — and file the
wiring as a follow-up. Small, truthful, reviewable.

**(b) Build the enable path.** Design the management entry point that writes
`codexAccountPickerEnabled` and allocates namespaces in one atomic
config write. This is a real API surface addition — a new route, its auth scope,
its validation, and its GUI caller — and is a larger change than PR #1152.

Recommendation: **(a)** for this stack. Option (b) is a feature, and this unit
is a bug-fix stack; smuggling a new management route into it would make the
stack incoherent and expand the review surface for no user-visible bug fix.
File (b) as its own issue and reference it from the PR body.

Targets for (a): `src/codex/account-namespaces.ts:18-131`;
`src/config.ts:1112-1130`; `src/routing/profile.ts:17,154-178`.

Tests: opt-in persistence; no mutation when allocation fails; non-empty map
identity and order preserved; pre-save rejection of policy and profile-prefix
collisions without leaking private ids.

## #1169 — codex-shim readiness warning

Advisory-only design is right: warn when a shim install cannot prove routing,
without failing the install. Secret-leak coverage is already focused.

One defect: `currentExternalCodexModelProvider()` can throw on an unreadable or
racing config, which turns a successful install into a failing command. An
advisory probe must never do that.

Targets: `src/cli/index.ts:1035-1041`; a readiness helper beside `src/cli/`;
`src/codex/inject.ts:83-86`.

Catch probe failure as "unverifiable" and keep exit 0. Test the unreadable-config
path and assert the warning discloses neither the proxy URL nor credentials.

## Stacking

`#1155` overlaps `src/server/responses/core.ts` with the #1095 rewrite, which is
deliberately out of this unit — so within this stack it is free-standing.
`#1152` and `#1169` touch disjoint files. Order: #1152, #1169, #1155, putting
the largest surface last.

Each phase closes its original PR with a comment naming the replacement number.

Phase 040 also edits lifecycle locale files that #1169's docs touch; whichever
lands first, the second rebases.
