# Make existing CLI commands discoverable

OpenCodex already has broad commands, but its 92-line entry help hides the next
step and nested help drops the user's requested path. This unit adds a complete
reference escape, preserves explicit help paths, presents common tasks first,
and makes failed lookups recoverable without executing a correction.

## Loop specification

- Archetype: satisfy-spec, C3 CLI presentation and argument classification.
- Trigger: user requested a cxc-loop and stacked PRs, then explicitly narrowed the
  work to UX after `ocx --help`, excluding client support additions.
- Goal: readable root, useful family/declared leaf help, and concise recovery.
- Non-goals: new clients/providers, GUI/TUI, runtime command redesign, JSON schema
  changes, credentials, live proxy changes, package updates, release or merge.
- Verifier: focused CLI tests, isolated terminal transcripts, typecheck,
  test:changed, structure and generated surface checks, privacy scan, docs build,
  independent review, and each PR's current-head hosted checks.
- Stop: agreed three layers published with validation/review evidence; unresolved
  external CI is recorded truthfully and prevents a ready/passing claim.
- Memory artifact: this numbered unit and ignored `.tmp/cli-ux/` raw logs.
- Outcomes: DONE means implemented, checked and published; external blocking or
  resource exhaustion preserves unfinished work and evidence, never weakens scope.
- Escalation: main resolves architectural findings; new external authority needs
  the user. No user token/time cap was specified; use available host limits.
- Permissions: inherited-model leaf agents may read or edit assigned disjoint
  files; main owns Git and FSM. Push/PR creation authorized; merge is excluded.

## Structure and dependencies

```text
src/cli/registry.ts + capabilities.ts (existing declarative owners)
  -> help-catalog.ts + help-models-context.ts (pure help resolution/data)
  -> help.ts (human rendering) <- root.ts (early help classification)
  -> help-navigation.ts (root/family discovery)
  -> help-recovery.ts (bounded suggestions) <- dispatch.ts unknown-root exit
```

No runtime command imports enter the help renderer. Command parsers remain the
execution authority; capabilities are incomplete and are never called a complete
command tree. The complete reference retains all existing public banner rows.

| Work phase | Deliverable | Dependency | Branch / PR base |
| --- | --- | --- | --- |
| wp0 | Audited docs-only roadmap | baseline | first layer carries plan docs |
| wp1 | Explicit help paths, full reference, shared context usage | wp0 | `codex/cli-ux-help-foundation` -> `dev` |
| wp2 | Compact root and family discovery | wp1 | `codex/cli-ux-navigation` -> foundation |
| wp3 | Contextual recovery without automatic execution | wp2 | `codex/cli-ux-recovery` -> navigation |
| wp4 | Review, publication and hosted proof | wp3 | evidence/docs on stack tip |

Branches form an ordinary manual chain; no GitHub native stack registration.
Each layer owns its tests and user-facing documentation. Lower-head changes must
cascade into descendants before publication/readiness.

## Decisions and consultation

Architect handle: `01a100e3-732b-7300-b5a3-1286e55db053` (inherited settings,
logical architect on V1; no claim of a separate native sandbox/model family).

- CLI-UX-01 accepted: preserve full help before compacting root; carry nested
  paths and supplement registry with capability help. Amended: shared exact
  context usage is imported by its runtime owner, not duplicated.
- CLI-UX-02 accepted: compact root, family discovery, no provider self-loop.
- CLI-UX-03 accepted: contextual conservative suggestions, never execute them.
- CLI-UX-04 accepted: no updater/bin changes or competing config/usage fixes.

Concrete plan revision: these 000/002/010/020/030/040 documents. Same-architect
reflection found the deliberately unregistered `internal` runner must be
explicitly admitted before unknown-root rejection; CLI-UX-03 now records that
exception and a regression. Bare-help positions and the whitespace-sensitive
models runtime usage consumer were also clarified. Updated reflection and
independent audit will be recorded before implementation.
Final same-architect reflection: ALIGNED on CLI-UX-01 through CLI-UX-04;
no remaining architecture-plan gaps (2026-10-03).

Rejected alternatives: an interactive wizard adds state to routine help; importing
command handlers risks side effects; replacing all parsers or generating a full
command tree from incomplete capabilities would expand scope and fabricate grammar.

## Scope boundaries and verification

The missing-CODEX_HOME import failure is recorded but deferred: changing import
bootstrap/path validation is a separate lifecycle change. Tests use existing empty
homes and prove no writes. Bare `help` in later operand positions and `--`
pass-through get explicit classification coverage; do not globally change
`hasHelpFlag` for unrelated callers. These delimiter guarantees apply to the
Bun CLI head: the unchanged published Node updater guard scans later arguments
even beyond `--` (bin/ocx.mjs:950). Do not claim launcher-wide parity.

Any new test file is added to both test-layout manifests. The 600-line runtime
structure doc is updated by replacement/consolidation, never by raising its cap.
Full local testing follows repository policy; if resource contention makes it
impractical, record exact focused proof and leave broader coverage to CI in draft.

## Continuity

wp0 in progress: source/UX evidence in 001; design in 002; all later phases are
specified in the decade documents. No production implementation yet.

Independent A reviewer `01a100ec-f604-7710-b4f6-c625286d646d`: GO-WITH-FIXES
(blockers=1). Main accepted the verified missing wp3 migration of the existing
unknown-help stdout-banner assertion; 030 now explicitly preserves and updates
that regression. No design decision changed. Source/plan coverage complete.

Fresh-reader UX reviewer `01a100ef-71b8-7c21-a4ce-3c98534289c1` understood
the problem/journey and requested two clarifications. Main folded partial-family
coverage wording and concrete distant/nested/undeclared-help examples into 002/030.

## wp0 Done

Roadmap locked: three dependent CLI UX implementation layers, no client additions.
Independent final docs audit PASS; fresh-reader recheck CLEAR. The seven-document
shape verifier and whitespace check pass. Baseline source tests/typecheck and
structure/surface/docs build are evidence of available verifiers, not changed UX.
No production code changed. The rejected direction was adding client support;
the user's corrected objective is terminal command discovery and recovery.
Next direction: revalidate 010 against the unchanged runtime source and implement
wp1's explicit help paths/full reference without shortening the root yet.

wp1 B amendment: existing mutating-help regression exposed a compatibility gap.
Flag-appended help falls back to known parent when detailed metadata is missing;
explicit `ocx help <path>` remains strict. This keeps service/shim help safe and
successful. Exact amendment and activation tests are in010.
Same architect reflected ALIGNED on wp1's compatibility amendment after tracing
runCli -> renderer and real CLI safety fixtures. Builder reports 85 focused tests
passing plus the final explicit service-install regression; main verification and
independent implementation review remain pending.

## wp1 Done (implementation scope; review readiness pending)

Explicit help paths, complete reference, shared context grammar, safe appended
flag-help fallback, tests and docs are implemented. Independent review PASS and
all affected-scope gates/11CLI scenarios pass. Full local suite has four failures,
three reproduced on untouched baseline and one unresolved snapshot failure;
011 records them without a waiver. Publication is draft until wp4 resolves the
required hosted evidence. The loop goal remains active.
Next direction: consume020 to make root/family navigation concise while retaining
wp1's full reference and compatibility behavior. No service/runtime changes are
inferred from the unrelated verification investigation.

wp2 P revalidated020 against de02ff1d00. Accepted architect CLI-UX-02 amendments:
entry canonical/declared-child presentation fields, curated context link, updated
root/full tests, incidental old error-banner behavior, and both provider usage
consumers consolidated with an explicit successful-help output sink. Same
architect final reflection ALIGNED; no execution/parser/JSON scope expansion.
wp2 independent A review PASS atde02ff1d00; both provider usage consumers,
transient sink/entry metadata, test migrations and draft limitations reviewed.
Main clarified that92is a measured full-reference baseline, not a permanent
assertion; visible registry coverage protects future command additions instead.
## wp2 Done (implementation scope; PR remains draft)

Root help is26logical lines/max80columns, with standard usage, common tasks,
registry-backed descriptions and the full-reference escape. Family/alias links,
curated context topic and provider single-owner help are implemented. Both
provider output channels and appended-help fallback remain correct.

Five meaningful RED tests preceded135focused passes. Changed-import verification
initially exposed a complete-reference test still reading compact help; preserving
all assertions and switching its renderer fixed it. Final:1,097pass/1skip/0fail
across46files. Typecheck, structure, skill surface, privacy, layout18tests and
docs561pages/77,929links pass.18real CLI QA scenarios and a40x24PTY capture confirm
outputs, exits, no ANSI dependency and no state writes. PTY, child and temp home
were closed/removed. Independent reviewer inspected16/16files:PASS.

The full local suite's prior four failures remain recorded in011; no full-green
or merge-readiness claim. PR6498's current head has23successful checks and8
workflow-policy skips, including a successful CI aggregate and format gate.
Next direction: consume030 for concise contextual recovery, keeping all wp1/wp2
behavior. Publication uses ordinary dependent draft PRs; no merge.
