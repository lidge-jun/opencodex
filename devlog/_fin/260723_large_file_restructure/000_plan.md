# 000 — Large-file restructure: objective, constraints, work-phase map

Date: 2026-07-23 · Branch: `codex/260723-large-file-restructure` (linked
worktree `/Users/jun/.codex/worktrees/0c1a/opencodex`, based on `dev` 71ebf77b)
Goalplan slug: `split-and-restructure-the-five-highest-value-ove`

> Recovery note: the original ephemeral worktree was pruned mid-cycle by the
> environment, taking the first copies of 000/010/030/050 and the `.codexclaw`
> FSM/goalplan state. 020/040 survived on disk. This worktree is now a proper
> linked worktree of the main repo so branch/commits persist in the shared
> `.git`. The four lost docs were rewritten from the same inventoried evidence.

## Origin

A 2026-07-23 full-repo census (`git ls-files | xargs wc -l`, >500 lines) found
75 code files / 83,993 lines over the threshold (src 28, tests 27, gui 18,
docs-site 2), plus generated `src/adapters/cursor/gen/agent_pb.ts` (15,274,
`protoc-gen-es` output — exempt). Five parallel Luna explorer lanes audited
cohesion; the main session verified two actionable claims (protobuf generation
confirmed; an i18n key-parity claim was refuted by direct grep). This unit
restructures the five files the audit judged genuinely worth splitting.

## Objective

Reduce the five highest-value oversized files to cohesive modules/components
behind compatibility re-exports, with zero behavior change. Every pre-existing
test case must still run; every public export and import path must keep
working.

## Constraints (hard)

- Pure refactor. No behavior, wire-format, API-surface, or export-signature
  changes. New internal modules are reached only through the original file
  path (facade re-exports) so unplanned caller edits never happen.
- Local commits only on `codex/260723-large-file-restructure`. No `git push`
  (DEV-GIT-PUSH-01). `dev`/`main` untouched.
- Generated code (`agent_pb.ts`) and all out-of-scope files below are never
  edited.
- Each phase verifies with fresh output: `bun run typecheck`, `bun run test`,
  `bun run privacy:scan`; phase 4 adds `bun run lint:gui` and
  `bun run build:gui`.

## Out of scope (explicit)

`src/server/request-log.ts`, `src/server/relay.ts`, `src/codex/routing.ts`,
`src/codex/history-provider.ts`, `src/types.ts`, `src/providers/registry.ts`,
`gui/src/pages/Usage.tsx`, `gui/src/pages/Dashboard.tsx`,
`gui/src/pages/Models.tsx`, all `gui/src/i18n/*`, all CSS, `agent_pb.ts`,
devlog prose. Rationale: single-domain cohesion (request-log/relay/routing/
history-provider), structural type-hub or data-registry size (types/registry),
already well-factored (Usage), or structural dictionary/style size (i18n/CSS).

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

Ordering principle: foundations before consumers; test infrastructure before
the code it will regression-protect; no effort bucketing.

| WP | Decade doc | Target | Why here in the order |
|----|-----------|--------|------------------------|
| wp1 | `010_tests_helpers.md` | tests/helpers extraction + split management blocks out of `tests/combos.test.ts` and `tests/server-auth.test.ts` | Test-only surface; builds the shared harness every later phase's C-run depends on. Zero src coupling, so it cannot conflict with later splits. |
| wp2 | `020_catalog_split.md` | `src/codex/catalog.ts` (2408) → metadata / parsing / effort-clamp / provider-fetch / aggregation modules + facade | Foundational data module: `management-api.ts`, `responses.ts`, `server/index.ts`, and 20+ tests import it. Splitting it first (facade-preserving) means wp3/wp5 see unchanged import paths. |
| wp3 | `030_management_api_split.md` | `src/server/management-api.ts` (1940) → domain route modules + thin registration core | Consumes catalog (wp2) symbols; independent of responses.ts. Route-table split is mechanical once catalog imports are stable. |
| wp4 | `040_providers_tsx.md` | `gui/src/pages/Providers.tsx` (1426) → OAuth panel, provider card list, account/key-pool hook, JSON-editor hook | GUI surface, fully independent of src/ work; placed after the src/server pair so the riskier shared-state extraction does not block the server foundation chain. |
| wp5 | `050_responses_split.md` | `src/server/responses.ts` (2146) → collaboration / encrypted-payload / combo / compact domains + core | Highest coupling risk (shared request/abort closures); runs last so all other surfaces are already stable and its C-run regressions are attributable to this split alone. |

wp0 (this docs-only cycle) is the roadmap lock: its D finalizes the map above
against the real tree.

## Per-phase acceptance (mirrors goalplan criteria)

- c2 `bun run typecheck` exit 0; c3 `bun run test` fully green with every
  pre-existing case still running; c4 `bun run privacy:scan` green.
- c5 (wp4 only) `bun run lint:gui` + `bun run build:gui` green.
- c6 original path < ~800 lines or thin facade; import surface preserved
  (verified by `rg` for import-specifier changes limited to planned moves).
- c7 all work committed locally; `git status` clean at each D; nothing pushed.

## Split doctrine (applies to wp2/wp3/wp5)

1. Create sibling internal modules (e.g. `src/codex/catalog/*.ts`) holding the
   moved symbols.
2. The original file becomes a facade: it re-exports the full prior public
   surface from the internal modules, preserving names and types exactly.
3. Module-level mutable state (caches, warning-signature sets) moves with its
   owning concern; reset-for-tests helpers keep working through the facade.
4. No caller outside the target file changes its import specifier.

## Risk register

- catalog.ts: `mergeCatalogEntriesForSync`/`syncCatalogModels` touch nearly
  every concern — they stay in a sync-orchestration module that imports the
  others; six module-level mutable states must not be duplicated across
  modules (single-owner rule).
- management-api.ts: route registration order and shared config-mutation
  helpers must move to the thin core, not a domain module.
- responses.ts: `handleResponses` and `handleComboResponses` are mutually
  recursive and share `HandleResponsesOptions`; they stay together in one core
  module, and only the independent leaf concerns are extracted.
- Providers.tsx: `aliveRef`, `oauthLoginGenerationRef`,
  `accountRequestGenerationRef` cross concerns — the account/key-pool hook
  takes generation refs as inputs rather than owning them.
- Tests: moving cases between files must preserve `beforeEach`/`afterEach`
  semantics (isolated codex home, combo-state cleanup); the runner discovers
  `./tests/` recursively (`bun test --isolate ./tests/`), so new files are
  picked up automatically.
- Environment: the ephemeral worktree was pruned once already; this linked
  worktree keeps branch/commits in the main repo `.git`, and B commits early
  and often so a directory wipe never loses landed work.

## SoT sync target (SOT-SYNC-01)

`structure/` holds maintainer architecture notes. Each implementation phase's
C updates the relevant `structure/` note if the module layout it documents
changed (catalog/server/gui), so SoT and code do not diverge.
