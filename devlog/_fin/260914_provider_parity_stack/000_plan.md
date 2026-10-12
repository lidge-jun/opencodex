# Provider parity stack — plan

Unit opened 2026-09-14. Base `origin/dev` `df7dc1be53`. Worktree
`/Users/jun/.codex/worktrees/provider-parity-260914/opencodex`.

## Objective

Fix the provider-compatibility defects independently reproduced in the 2026-09-14
audit, and publish them as a dependency-ordered manual stack of four pull requests.
Every layer is standalone: its own thesis, its own tests, its own docs.

Evidence and source anchors are in [`001_audit_evidence.md`](001_audit_evidence.md).
Architect proposals and their dispositions are in
[`002_architect_dispositions.md`](002_architect_dispositions.md).

**[`003_blocker_corrections.md`](003_blocker_corrections.md) is authoritative over
every decade doc below.** Independent review found material errors in the first
draft — F2 was corrected from an ingress strip to final-target sanitization, F3 from
silently ignoring a schema to an explicit error, F5 from a claimed fix to an explicit
residual, F9 from a one-branch fix to both branches, F8 to a deliberate ordering
change. Read it before executing any layer.

Deliberate non-coverage is in [`050_residuals.md`](050_residuals.md).

## Constraints

- Branches `agent/provider-parity-*` only, in this worktree. The original checkout
  and every other open PR stay untouched.
- Commits use an `[agent] <type>:` subject prefix and explicit staging. No
  `[skip ci]`, no workflow-file edits, no dependency or lockfile edits.
- No merge, no release, no self-approval. A layer whose full gate cannot be
  obtained is published as a draft and reported as such.
- Desired-behavior regressions go red before they go green. The prior audit probe
  suite asserts the defects and is not reused as the fix gate.
- No new remote fetch is introduced on any request path.

## Stack topology

Four layers, merged bottom-up. Each child's base is the preceding open parent head.

| # | Branch | Base | Thesis | Findings |
|---|--------|------|--------|----------|
| 1 | `agent/provider-parity-01-ingress` | `dev` | Normalize inbound Chat images before route selection; preserve an explicit reasoning disable | F1, F7 |
| 2 | `agent/provider-parity-02-controls` | layer 1 | Scope the Responses control strip to canonical ChatGPT; carry assistant reasoning and penalties through translation | F2, F6 |
| 3 | `agent/provider-parity-03-wire` | layer 2 | Google structured output onto the `generateContent` wire; Anthropic parallel-tool disable | F3, F4 |
| 4 | `agent/provider-parity-04-modality` | layer 3 | Preserve tool-result images, and refuse unsupported modalities explicitly instead of silently | F8, F5, F9, Kiro |

## Dependency order

Two different things order these layers, and the distinction is stated rather than
blurred (architect D8, `002_architect_dispositions.md`).

**Real source dependency — layers 1 and 2.** Layer 1 owns the inbound boundary: it
decides which pipeline a Chat request enters and what an effort value means once it
is inside. Layer 2 edits the same two files: both change
`src/server/chat-completions.ts` and `src/chat/inbound.ts`, so layer 2 cannot be
reviewed or merged independently of layer 1.

**Serialization, not dependency — layers 3 and 4.** Layer 3 reads
`options.textFormat` and `options.parallelToolCalls`, neither of which layers 1-2
touch; at source level it could open against `dev` in parallel. It is stacked
because every layer edits the same two test-registration files, and layers 2-4 all
edit `structure/providers/chat-compat.md` — four parallel PRs would conflict on
each of them. Layer 3's PR body states this plainly instead of implying a
dependency it does not have.

Layer 4 is last on its own merit: an explicit refusal is only honest once the
preceding layers have stopped losing payloads for unrelated reasons.

Files touched by more than one layer:

| File | Layers |
|---|---|
| `src/server/chat-completions.ts` | 1, 2 |
| `src/chat/inbound.ts` | 1, 2 |
| `scripts/test-layout/layout.json` | 1, 2, 3, 4 |
| `tests/fixtures/test-layout-expected.json` | 1, 2, 3, 4 |
| `structure/providers/chat-compat.md` | 2, 3, 4 |

`src/adapters/openai-chat.ts` and `src/responses/parser-content.ts` are touched by
layer 4 only.

## Work-phase map

| Work phase | Cycle | Output |
|---|---|---|
| wp1 | docs only | this unit; no production patch |
| wp2 | layer 1 | branch, tests, docs, PR |
| wp3 | layer 2 | branch, tests, docs, PR |
| wp4 | layer 3 | branch, tests, docs, PR |
| wp5 | layer 4 | branch, tests, docs, PR |

## Verification status

**No local product check runs on this Mac, by standing user instruction.** The full
status table, the coordinator's baseline observations at `df7dc1be53`, and what
`structure:check` does and does not observe are in
[`003_blocker_corrections.md`](003_blocker_corrections.md) §C0.

In short: every gate for this unit's changes is **NOT RUN BY USER INSTRUCTION** and
is never reported as passing or provisional. Layers publish as DRAFT. Evidence comes
from hosted GitHub Actions at the exact pushed head and from independent static
review. Red-first execution is impossible under this restriction, so regressions are
written to assert desired behavior and reviewed statically.

## Source-of-truth sync

`structure/INDEX.md` maps each changed source area to the docs that must move with
it. The bindings this unit will touch:

- `src/chat/` and `src/server/` -> `structure/data-planes/inbound-compat.md`
- `src/adapters/` -> `structure/providers/chat-compat.md`, `structure/adapters/registry.md`
- Google -> `structure/providers/google.md`
- Kiro -> `structure/providers/kiro.md`

Public user-visible behavior changes also update `docs-site/`.

## Out of scope

- `#4501` / PR `#4511` (operator `modelCapabilities` text-only in the native
  describer, audit F10). Already owned elsewhere; this unit must not duplicate it.
- `#4505` gateway modality metadata — the audit found a display/policy
  inconsistency, not evidence of that gateway's native vision behavior.
- `#4513` Devin image passthrough — already fixed.
- `#4528` — adjacent to F2; this unit fixes the adapter-scope defect, not that PR's subject.
- Cursor native/external image path differences — not confirmed as a real loss.
- Qoder's deliberate image refusal and the CodeBuddy/Qoder vendor-tools-disabled
  policy. Both are intended behavior and stay.
