# 007 — Roadmap verification tooling (LOOP-REPAIR-01)

P-phase amendment, adopted after the A-gate loop hit its repair bound.

**This document does NOT relax DIFFLEVEL-ROADMAP-01.** An earlier draft of it
tried to, by declaring that decade docs need only carry contracts and
signatures. The A-gate was right to reject that: the rule is STRICT and asks
for copy-paste-executable bodies, and a unit-local doc cannot redefine a
governing gate. That draft is withdrawn.

The bodies stay. What was missing was not a lower bar — it was a **compiler**.

## 1. What went wrong

Five audit rounds, and the failure mode converged:

| Round | Blockers | Nature |
|---|---|---|
| 1 | 8 | genuine cross-phase contract drift |
| 2 | 4 | disclaimers instead of edits; two real design faults |
| 3 | 6 | four real logic faults, two transcription |
| 4 | 6 | two design, four transcription |
| 5 | 4 | **two design, two transcription** |

The design faults were worth every round — restore adopting unowned entries,
compensation losing prior ownership, an unreadable file read as absent, a
stale refresh orphaning fragments, HTTP mapping swallowing recovery data.
Those are bugs the audit caught *before* a single line shipped, which is
exactly what an A-gate is for.

The transcription faults are different, and they are structural: a mismatched
import, a type declared in one block and used differently in another, a body
that says `/* … */`. **No tool in this repository can see them**, because they
live in fenced code inside markdown. `bun run typecheck` typechecks `src/`; it
has no opinion about a doc. So each round I fixed them by hand, by eye, and
each round produced a fresh crop.

Writing a compiler-checkable artifact without a compiler is the wrong shape of
work. That is the root cause; the remaining transcription defects are its
symptoms.

## 2. The fix: give the roadmap a compiler

`tools/check-blocks.ts` (new, lives with the unit it verifies) extracts every
fenced `ts`/`tsx` block from the unit's numbered docs, classifies it, and
writes the compilable ones to `.blocks/` for `tsc`:

```
bun devlog/_plan/260802_client_toggle_api/tools/check-blocks.ts
cd devlog/_plan/260802_client_toggle_api/.blocks
bun x tsc --noEmit --skipLibCheck --strict --noResolve \
  --target esnext --module esnext --moduleResolution bundler --jsx react-jsx *.ts *.tsx
```

Classification matters, because not every fenced block is a compilation unit:

| Class | Treatment |
|---|---|
| unit (top-level decl, balanced braces) | compiled |
| diff (`+`/`-` markers) | counted, not compiled — it is a patch, not TypeScript |
| fragment (mid-function excerpt) | counted, not compiled |
| **placeholder** (`/* … */`, `/* moved verbatim */`) | **reported by path and line** — a body we did not write cannot pass silently |

`--noResolve` is deliberate: each block is checked as a self-contained unit for
syntax and internal consistency. Cross-module identifier resolution belongs to
the implementing phase, where the real imports exist and the repository's own
`bun run typecheck` covers it.

## 3. The second checker: cross-document drift

Isolated block compilation is blind by construction to the defect that kept
recurring — a canonical declaration in `006` and a consumer elsewhere
disagreeing — because each block is its own file and `noResolve` discards the
very diagnostics that would show it. The A-gate caught that claim and it was
right: green was false confidence.

`tools/check-drift.ts` closes it by comparing declared shapes across documents
rather than type-checking them:

| Rule | What it enforces |
|---|---|
| `canonical-shape` | any redeclaration of a `006`-owned type matches it field-for-field |
| `ownership` | a symbol is declared in exactly one module, and imports point at that owner |
| `propagation` | a cross-phase field (`retentionDegraded`, `snapshotCount`, `priorRecord`) appears in every layer's copy of its shape |
| `reason-first` | failure mapping branches on `result.reason`, never `result.state` (006 §5) |
| `diff-placeholder` / `diff-nested-marker` | the 18 `diff` fences — which the block checker does not read — carry no placeholder bodies or pasted-into-itself markers |

Bracket balance is deliberately NOT checked on diff hunks: a hunk legitimately
shows the middle of a file, so imbalance is normal. That rule was written,
produced five false positives on correct patches, and was removed.

**Adversarial proof.** Deleting `retentionDegraded` from `060`'s
`IntegrationStatus` makes the checker report exactly that, at that line;
restoring it returns to clean. The checker fails on the defect it claims to
guard, which is the only evidence that a green result means anything.

## 4. What the checkers caught immediately


Block checker, first run over 19 docs / 79 blocks: **1 placeholder** and
**1 syntax error** — the `ctx: {...}` pseudo-signature still sitting in `030`
after four rounds of human review. Then four real type defects: a missing
`isPlainRecord` type guard (so the YAML renderer's narrowing silently produced
`unknown`), an unannotated `Object.values` widening, a parameter initializer on
a declaration-only signature, and `020`'s retired journal contract.

Drift checker, first run: **7 findings**, including all four the A-gate had
found by hand — `021`'s `JournalEntry` missing `priorRecord`, its import of
`parseConfig` from the wrong module, two redeclarations of that symbol, and
`040` still routing failures by `state`.

That is the entire argument for this tool in one data point: the design faults
across five rounds were all caught by review, and the transcription faults were
all invisible to it.

## 5. When they run

- **Now**, and after any edit to a decade doc: both checkers must be clean
  (0 placeholders, `tsc` clean, 0 drift findings) before the roadmap re-enters
  the A-gate.
- **At each phase's P**, as part of the stale check.
- **At each phase's C**, alongside the repository gates, so a doc amended
  during B cannot drift from the code it describes.

DIFFLEVEL-ROADMAP-01 is satisfied in its own terms: every decade doc still
carries exact paths, NEW/MODIFY, real signatures, and copy-paste-executable
bodies — and now the bodies are checked by a compiler instead of by eye.

## 6. Carried-forward implementation notes

These were found by review and are fixed in the docs; the checker guards
against their reintroduction:

| Note | Phase | Guard |
|---|---|---|
| `config-io.ts` owns `parseConfig`, `loadTarget`, `defaultIntegrationIO`; `state.ts` and `merge.ts` import them | WP2 | duplicate declaration shows as a redeclaration error |
| `JournalEntry` carries `priorRecord: OwnershipRecord \| null` | WP2 | missing property errors at every construction site |
| HTTP failure mapping routes by `reason`, never `state` | WP4 | route test asserts `write_failed` in a `conflict` state still yields `integration_mutation_failed` with recovery fields |
| Prune failure is structured, marked, retried, surfaced as `retentionDegraded` | WP2 | test per `006` §5 |
| `model-rows.ts` is a verbatim cut of `model-routes.ts:114/129/182` | WP1 | existing client-config route test must pass unchanged |

## 7. Goalplan effect

No work-phase is added or removed and no deliverable is weakened. `c-docs`
keeps its meaning; `c-gates` gains "the block checker reports 0 placeholders
and clean `tsc` before each A-gate and at each phase's C."
