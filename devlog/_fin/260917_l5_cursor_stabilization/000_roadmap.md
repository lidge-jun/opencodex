# L5 — Cursor stabilization and tool-marker handling

Lane roadmap. One docs cycle, then one implementation cycle per unit.

## Why these four sit in one lane

All four are the same class of defect: a provider emits something that *looks*
like a tool call, or ends a turn in a state the next turn silently inherits, and
the adapter treats the resemblance as authority. #4815 and #4852 are the
"text that looks like a call" half. #4816 and #4875 are the "state the next turn
inherits" half. They live in three different adapter areas and are worked in
parallel on separate branches.

| Unit | PR / issue | Branch | Area |
|---|---|---|---|
| U1 | #4815 | `cursor/l1-text-toolcall-quarantine` | `src/adapters/cursor/text-toolcall.ts`, `protobuf-events.ts` |
| U2 | #4816 | `cursor/l2-observed-max-tokens` (base: U1 head) | `src/adapters/cursor/discovery.ts`, `live-transport.ts` |
| U3 | #4875 (closes #4874) | `fix/cursor-incomplete-tool-conversation-remint` | `src/adapters/cursor.ts`, `cursor-errors.ts`, `thread-continuity.ts` |
| U4 | #4852 (re-opens #4596) | new `codex/` branch off `dev` | `src/adapters/codebuddy/scaffold-guard.ts` |

U1 and U2 keep the existing stack topology: #4816 is based on #4815's head, and
that stays true through this lane. U3 is not made a child of U2 — it touches the
conversation-lifecycle half of `cursor.ts`, not the window/marker half, and chaining
it would couple two independent review surfaces. U4 is independent.

## Baseline

`origin/dev` = `f1dfda8e48` (#4876 merged). The CI stabilization round is closed;
no CI work belongs to this lane.

## Verification policy

No local verification of any kind. No `bun test`, `bun run test`,
`bun run test:changed`, `bun run typecheck`, `bun x tsc`, `bun install`,
`bun run build:gui`, or `ocx`. A local suite has previously deleted real
`~/.opencodex` data. Every claim in this lane is backed by one of two things:
static reasoning over the source and its call graph, or hosted CI at an exact head
SHA. Pushes use `git push --no-verify` because the pre-push hook runs the local
suite.

No flake management. Do not widen a timeout or budget, add a retry, skip a
platform, or mask a failure to reach green. The Windows job is
`workflow_dispatch`-only; if a change can affect Windows, tell the host and let the
host dispatch it.

Merge, rebase, and squash decisions belong to the host. This lane ends at
"PR open with exact-head CI evidence".

## Repository obligations that apply to every unit

- PR body fills every section of `.github/PULL_REQUEST_TEMPLATE.md`.
- Carrying or extending another author's PR requires a `Co-authored-by:` trailer;
  prose is not equivalent. U3 is MerryEcho's work and carries that trailer.
- A new test file needs byte-identical entries in `scripts/test-layout/layout.json`
  (`explicit`) and `tests/fixtures/test-layout-expected.json`. All four units add
  cases to existing test files, so no new layout entry is expected.
- Changing an owned `src/` area obliges the matching `structure/` doc in the same PR
  (`structure:check`). U1-U3 own `structure/providers/cursor.md`.
- None of the touched source files carry a file-size ratchet cap
  (`tests/fixtures/file-size-baseline.json` has 51 entries; its only Cursor entry is
  `tests/providers/cursor/cursor-blob.test.ts` at 3657 lines, which U3 does touch).
- Every repository artifact is English.

## Sequencing

Cycle 1 (this document) is docs-only: no production patch, no
implementation-complete claim. Cycles 2-5 each consume one decade doc below and
revalidate it at P before editing code. The four implementation cycles run
concurrently on their own worktrees because their write sets are disjoint.

- [010_u1_text_toolcall_contract.md](./010_u1_text_toolcall_contract.md)
- [020_u2_observed_window_scope.md](./020_u2_observed_window_scope.md)
- [030_u3_remint_isolation_and_budget.md](./030_u3_remint_isolation_and_budget.md)
- [040_u4_codebuddy_bare_tool_names.md](./040_u4_codebuddy_bare_tool_names.md)

Security analysis, if any arises, goes to `.tmp/`, never here.
