# N4 responses/quota lane — roadmap

Base: `origin/dev` 730d898457. Lane worktree: `opencodex-lanes/261009-N4-responses-quota`.

## Loop spec

- Archetype: satisfy-spec, two independent bug fixes.
- Trigger: sweep lane N4 dispatched from the coordinator chat for #6747 and #6800.
- Goal: each issue fixed by a merge-ready dev PR, or closed out as NEEDS_HUMAN with evidence.
- Non-goals: see "Out of scope"; no merge, release, or edits to other lanes' PRs.
- Verifier: focused `bun test` files named in 010/020 (pre-change run of the existing
  ones: 382 pass, exit 0; they import `src/responses/state.ts` and the main-quota modules
  directly) plus `bun run typecheck`; exact-head hosted CI for the rest.
- Stop: both PRs READY, or a recorded NEEDS_HUMAN/BLOCKED verdict per item.
- Memory artifact: this unit plus the PR descriptions.
- Resources: none stated; host limits apply. Writes limited to the lane worktrees and
  `codex/n4-*` branches.
- SoT sync: `structure/transports/responses.md` (both), `structure/providers/openai-accounts.md`
  and `openai-tiers.md` (wp2).

## Objective

Two independent fixes, each a separate dev-targeted PR:

| Work phase | Issue | Doc | Branch |
|---|---|---|---|
| wp1 | #6747 durable spill admission refuses instead of reclaiming headroom | [010](010_spill_admission_headroom.md) | `codex/n4-responses-quota` |
| wp2 | #6800 `__main__` quota stops updating for caller-owned main traffic | [020](020_main_quota_observation.md) | `codex/n4-main-quota` |

wp1 and wp2 share no source file and can land in either order. This unit (000 + 010)
rides the wp1 PR; the wp2 PR carries only 020 so the two PRs never add the same path.

## Constraints

- `src/responses/state.ts` sits at 1352 lines against a ratchet cap of 1371; wp1 may
  spend at most 19 lines there. `tests/responses/responses-state.test.ts` is at 3982 of
  3983, so wp1 adds its regression cases in a new sibling file and edits existing
  assertions in place only.
- `tests/responses/openai-responses-passthrough.test.ts` is at its cap (4809/4809); wp2
  adds a new test file instead.
- New test files are registered in both `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.
- `/api/system/memory` exposes a reviewed field set pinned by
  `tests/responses/continuation-dedup.test.ts`; any new metric must be added there
  deliberately and documented in `docs-site`.
- Local verification is limited to focused tests for changed behaviour and
  `bun run typecheck`; the full suite runs in exact-head hosted CI.

## Dependency order

wp0 (this roadmap) → wp1 and wp2 in parallel. Each ends READY only with green
exact-head CI, an independent review PASS (wp2 also a security review PASS), and a
MERGEABLE PR against the latest `dev`.

## Out of scope

- A per-thread "newest continuation" pin for spill eviction (#6747 suggestion). It is a
  retention-policy change, not the admission defect.
- Compact's final quota capture (`src/server/responses/compact.ts` admits only `pool`).
  Adjacent gap, not the reporter's path.
- Raising the 1 GiB spill cap or adding a production knob for it.

## Architect consultation

| Doc | Architect handle | Proposal | Reflection | Main disposition |
|---|---|---|---|---|
| 010 | sol `01a1204b-a886` | D1–D8: headroom parameter, footprint+inherited at admission, superseded-only headroom at shutdown, unchanged eviction order, no per-thread pin, sibling test file, fail-closed, ratchet budget | MISALIGNED: impossible shutdown fallback still pruned unrelated spills; missing shutdown/deferred/reload tests; test reset is field-by-field; structure doc must be unconditional | All folded: infeasible headroom now evicts nothing; tests 6–9 added; reset lines budgeted; structure doc made mandatory. Counters added beyond the proposal and documented as logical events. |
| 020 | sol `01a1204b-a99a` | D1–D7: keep pool gate, process-local dispatch proof, capture from materialized credential, owned-credential equality only, separate canonical HTTP/WS observation, credential-generation fence, focused tests and docs | MISALIGNED: HTTP await between proof check and write; WS early return at :125 must be replaced and proof captured in the closure; tests for persistence, wrong workspace, invalid headers, retry path, WS replacement between frames; docs-site and two more structure owners | All folded: post-import re-check, closure capture, tests 8–13, docs list extended. Compact capture stays out of scope (recorded above). |
