# 000 — Integrate cursor-call onto dev and reach release-ready state

## Objective

Land the `cursor-call` tool-call hardening campaign on the current `dev` head, then
carry it to a release-ready state. The campaign shipped against `f64c0639`
(merge-base); `dev` has moved 100+ commits since, and two of the source files we
changed were changed there too — one of them for the SAME defect, in the opposite
shape.

**Moving-ref discipline (audit `r2` finding 2).** `dev` advances during this work:
it was `87f7f970b` (+104) when the collision sweep ran and `e1bdbc1e5` (+124) a few
minutes later. Every count below is therefore pinned to an immutable SHA, and the
rebase re-reads `origin/dev` immediately before running rather than trusting a
number written here. The COLLISION SET is what matters, and it was re-checked at
the later head: still the same two paths.

This unit is the integration record, not a re-decode. The decode unit is
`devlog/_plan/260817_cursor_toolcall_decode/`.

## Audit history

Round `r1-20260818030046` returned **FAIL** with 6 findings; every one was verified
against the tree and every one was accepted. See `005_audit_r1.md`. The findings
changed the work-phase map (a new WP for the usage regression, gates moved BEFORE
the merge, the stack claim replaced) — they were not absorbed as wording tweaks.

## Evidence base

| Fact | Command |
|------|---------|
| merge-base = `f64c06391` (immutable) | `git merge-base origin/dev cursor-call-prerebase-260818` |
| snapshot `cursor-call-prerebase-260818` = `fe2237038`, **31 commits** (immutable) | `git rev-list --count <base>..cursor-call-prerebase-260818` |
| `cursor-call` is a MOVING ref: 32 commits at `66b9df9ef`, 34 at `be1b881ec`, and it keeps growing as this unit is written | `git rev-list --count <base>..cursor-call` |
| `origin/dev` is a MOVING ref: +104 at `87f7f970b`, +124 at `e1bdbc1e5` | `git rev-list --count <base>..origin/dev` |
| snapshot touches **28** paths (18 source/test + 10 devlog) (immutable) | `git diff --name-only <base> cursor-call-prerebase-260818` |
| only 2 of the 28 were touched on dev — re-verified at `e1bdbc1e5` | per-path `git log --oneline <base>..origin/dev -- <path>` |

The earlier draft said "18 files" while listing a devlog wildcard row; `r1` finding 6
was right. 18 is the source+test count; 28 is the full path count.

## Collision inventory (all 28 paths)

18 source/test paths:

| File | dev commits | Collision |
|------|-------------|-----------|
| `src/adapters/cursor/live-transport.ts` | 3 (`6a64db19d`, `08eb65d1f`, `1824a0148`) | **SEMANTIC** — same defect, opposite shape |
| `src/adapters/google.ts` | 6 (`aca3c0241`, `0be660a2e`, `f6c88febf`, `812255d3a`, `d62cc4029`, `343e5d7a3`) | **TEXTUAL** — identity work; our hunk drifts 939 → 946 |
| `src/adapters/anthropic.ts` | 0 | none |
| `src/adapters/command-code.ts` | 0 | none |
| `src/adapters/cursor/cursor-errors.ts` | 0 | none |
| `src/adapters/cursor/native-exec.ts` | 0 | none |
| `src/adapters/cursor/protobuf-request.ts` | 0 | none |
| `src/adapters/cursor/request-builder.ts` | 0 | none |
| `src/bridge.ts` | 0 | none |
| `src/responses/truncated-stop-reason.ts` | 0 (absent on dev — we add it) | none |
| `tests/anthropic-error-stop-reason.test.ts` | 0 | none |
| `tests/bridge-nonstreaming-terminal.test.ts` | 0 | none |
| `tests/command-code-error-finish.test.ts` | 0 | none |
| `tests/cursor-cancel-provenance.test.ts` | 0 | none |
| `tests/cursor-eof-terminal.test.ts` | 0 | none, but its EXPECTATION changes (see `010`) |
| `tests/cursor-request-builder.test.ts` | 0 | none |
| `tests/cursor-tool-result-image.test.ts` | 0 | none, but its COVERAGE is insufficient (see `005` F1) |
| `tests/google-buffered-stop-reason.test.ts` | 0 | none |

Plus 10 `devlog/_plan/260817_cursor_toolcall_decode/*` docs, zero dev commits.

An INDIRECT-breakage sweep, run twice (once by the collision investigator, once
adversarially in `r1`), found no compile break. `AdapterEvent.done.stopReason`
still exists (`src/types.ts:366-387`), the Cursor tool-definition exports we
reference are intact, and the adapter factory signature is compatible. **The real
upstream hazard `r1` found is not a renamed import — it is request PREPROCESSING
(finding F1).**

## Loop-spec

- Loop archetype: verifier-defined (typecheck + full suite on lidge decide done).
- Write scope: the 18 source/test paths above, plus this unit. `src/vision/index.ts`
  and `src/providers/registry.ts` are **out** of scope: audit `r2` finding 3 is right
  that a conditional clause letting WP2b expand into vision policy contradicts the
  explicit deferral of F1. WP2b is about EOF usage and authorizes nothing in vision.
  No version bump, no npm publish, no `main` promotion.
- Tool/credential scope: local git, `ssh lidge` for verification, `gh`/GitHub app
  for PRs and the merge. Push to `origin/cursor-call` is pre-approved
  (`--no-verify`); force-push is inherent to the requested rebase and the snapshot
  branch is the recovery path.
- Bounds: no stated token budget. Wall-clock dominated by the lidge suite (~8 min).
  CI is NOT checked (user waived) — but see `005` F2 for what that waiver can and
  cannot license.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1-integration-roadmap | this unit + `005` | conflict inventory, audit absorption, roadmap (docs-only) | — |
| wp2-rebase | `010` | rebase with evidence-based conflict resolution | wp1 |
| wp2b-eof-usage | `015` | **NEW (r1 F3):** the surviving EOF error event must carry partial usage | wp2 |
| wp3-remote-verify | `020` | typecheck + full suite + privacy:scan + audit:high on lidge | wp2b |
| wp4-prs | `030` | PR(s) targeting `dev`, topology-honest, template filled | wp3 |
| wp5-merge | `040` | merge onto `dev` + ancestry proof, with the governance position stated | wp4 |
| wp6-release-gates | `050` | gates re-run on merged `dev` + go/no-go note | wp5 |

`r1` F1 (Cursor tool-result images stripped upstream by the vision sidecar) is
**NOT** folded into this integration. It is a real defect and it makes one
capability claim in the decode unit's 020 overstated, but fixing it means changing
vision preprocessing policy — a different subsystem, a different blast radius, and
a decision about ordinary user images too. It is recorded in `005` and appended as
a follow-up work-phase candidate, and the overstated claim gets corrected in the
decode unit's docs. Landing a rebase does not make it worse.

## Accept criteria (mirrored into the goalplan)

- `c1-roadmap-unit` — this unit with research + diff-level decade docs.
- `c2-conflict-inventory` — the 28-path table, produced by the named commands.
- `c3-rebase-clean` — rebase lands, no conflict markers, dev head is an ancestor.
- `c4-resolution-audited` — every resolution passes an adversarial audit round.
- `c5-remote-green` — typecheck + full suite green on lidge at the SHA.
- `c6-prs-open` — PR(s) against `dev` matching the ACTUAL topology, template filled.
  (Revised by `r1` F4: "stacked" is no longer required if the history does not
  support an honest split.)
- `c7-merged-on-dev` — `git merge-base --is-ancestor` proves it, not an API reply.
- `c8-release-gates` — privacy:scan, audit:high, typecheck, full suite green.
- `c9-go-no-go` — a written note on whether to cut a version.
- `c10-eof-usage` — **NEW:** the EOF truncation error carries partial usage, with a
  regression test that fails before the fix.

## Out of scope (carried follow-ups, NOT this unit)

1. **Cursor vision preprocessing (`r1` F1)** — all Cursor models are in
   `noVisionModels` (`src/providers/registry.ts:978-982`), so
   `describeImagesInPlace`/`stripImagesInPlace` replaces tool-result images with
   text before the adapter runs (`src/server/responses/core.ts:2225-2243`,
   `src/vision/index.ts:252-259,565-581`). The 020 encoder work is correct but
   currently unreachable in production.
2. Kiro `completionMode: "disabled"` drops `stopReason` (`kiro.ts:1315`, `:1485`).
3. Google ordinary mode forwards only `MAX_TOKENS` + five safety values; four
   other reasons become reasonless `done` (dev `google.ts:786-795`).
4. User-message images still flattened (`request-builder.ts:206-214`).
5. Phase 030 (xai apply_patch) remains NOT REPRODUCED. New information: dev landed
   `bc229433a` + `8a4040384`, which stop the code-mode guidance from forbidding a
   separately-advertised top-level `apply_patch` — the same affordance surface 030
   suspected, fixed independently on dev. Re-probing needs a user-supplied failing
   case.
