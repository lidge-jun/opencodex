# 260718 — PR #145 absorb + PR #147 combo stack rebuild on dev

## Objective

User decision (2026-07-18): absorb both community PRs onto `dev` ourselves via
cherry-pick/manual re-landing ("체리픽을하던지해서 수동 병합"), stacked slowly
through repeated PABCD cycles, fixing every Sol review finding in the process.
No push / no GitHub write without separate approval.

## Source refs (immutable snapshots)

- PR #145 head: `fa4ca861` → local branch `codex/source-pr145-fa4ca861`
  (6 files, +212/−81, base main).
- PR #147 head: `6824e7bc` → local branch `codex/source-pr147-6824e7bc`
  (14 files incl. new `6824e7bc feat(combos): defaultEffort fills missing
  client reasoning` which POST-DATES the Sol review of `a4abda1` — the
  defaultEffort delta needs its own review pass during 020's P).
- Review evidence: Sol reviewer verdicts 2026-07-18 (PR145: NEEDS CHANGES 3×P2;
  PR147: NEEDS CHANGES P0=1 P1=5 P2=3 P3=1; details summarized per phase doc).

## Attribution contract

Same as `260717_pr139_140_stacked_rebuild/000_plan.md`: wholly reconstructed
contributor behavior → author `Wibias <37517432+Wibias@users.noreply.github.com>`
with maintainer committer; maintainer repairs/redesign → maintainer author +
`Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`. Commit bodies name
source PR + exact source head.
Immutable `codex/source-*` refs are never rewritten.

For PR #147, "wholly reconstructed" is commit-level, not feature-level. A contributor-
authored commit may contain only source-faithful primitives/cooldown plumbing. Narrowed
types, strict normalization, deterministic SWRR, the narrowed failure policy, fresh-child
execution architecture, and all hardening are maintainer-authored with the exact Wibias
co-author trailer. Do not place redesigned behavior in a Wibias-authored commit merely
because it serves the same feature.

## Phase map (dependency-ordered)

| Phase | Doc | Scope | Depends |
|-------|-----|-------|---------|
| 010 | `010_pr145_absorb.md` | 403-label absorb with 401-precedence fix, provider-scoped access-denied, real-path integration tests | — |
| 020 | `020_pr147_domain.md` | combo types/resolve/config/management-API: validation parity, deterministic selection contracts, orphan prevention + reachable disabled-member handling, defaultEffort delta review; RR remains honestly pinned until 030 production success notification | 010 (errors.ts adjacency) |
| 030 | `030_pr147_failover.md` | per-target execution/failover: production RR activation, combo PUT/DELETE cooldown resets, current-parser ignored-value compatibility, connection/cross-adapter hops, post-commit no-replay, post-hop vision/effort recompute, XAI OAuth refresh scoping | 020 |
| 040 | `040_pr147_catalog_usage.md` | member-derived catalog capabilities, per-attempt usage attribution, broad-suite close | 030 |

GUI/i18n for combos: deferred follow-up work-phase (append via LOOP-UNIT-CHAIN-01
when 040 closes), matching the PR author's own deferral.

## A-gate audit decisions folded 2026-07-18

1. 020 stays response-execution-free and therefore declares RR selection static/pinned
   at its tip. Pure transitions are tested with explicit success notes; 030 activates
   production rotation at the adapter-specific commit boundary.
2. Deleted/missing member closure is prevention, not a supported runtime activation:
   config/PUT reject it and provider DELETE returns 409. Existing provider PATCH drives
   the reachable disabled-member runtime test; direct map deletion is defense in depth.
3. 030 modifies combo PUT/DELETE to call `clearComboTargetCooldowns(id)` after successful
   save and proves both routes through `handleManagementAPI` while another combo remains
   untouched.
4. No parser hardening is planned: current `reasoning:null` and unknown/empty string
   efforts are accepted then ignored; non-string effort remains the existing schema 400.
   Combo defaults never overwrite any client-owned raw effort value.
5. 030 adds a consumed heartbeat→text→error E2E proving A hit once, backup hit zero,
   one output delta, one terminal failure, and no replay/completed event.
6. The three copy-paste gaps are replaced with complete implementations: combo issues,
   runTurn replay/bounded failure consumption, and catalog warning/usage attribution
   sanitization including the legacy row.
7. 020/030 commit plans separate source-faithful Wibias-authored kernels from every
   maintainer redesign; maintainer commits retain the exact Wibias co-author trailer.

## Conflict surface (verified 2026-07-18)

`git merge-tree` vs dev reports content conflicts in `src/router.ts` and
`src/server/responses.ts`; overlap with landed 139/140 rebuild surface in
`management-api.ts`, `types.ts`, `catalog.ts`, `config.ts`. Therefore: no direct
cherry-pick of 147 commits — re-derive hunks against current dev per slice.
145 is expected to cherry-pick nearly clean (errors.ts/request-log/i18n), then
receive the precedence repairs on top.

## Accept criteria (roadmap cycle)

- 010–040 docs each carry exact paths, NEW/MODIFY/DELETE, before/after behavior,
  test commands, rollback, and the Sol findings they close (copy-paste-executable).
- Sol A-gate audit of this unit returns PASS or GO-WITH-FIXES with blockers folded.
- Goalplan wp1–wp6 map 1:1 onto 260718_issue146_92_docs_fix{010,020} +
  this unit's {010,020,030,040}.

## Audit fold-back 2026-07-18

- Blockers 1–7: added the locked A-gate decisions above, refined phase scopes, and made
  commit-level attribution boundaries explicit.
- Rebuttal: none; the audit blockers were accepted as stated.
