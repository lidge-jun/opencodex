# 000 — 260726-pr-rework-v2: Plan

## Objective

Integrate the open pull requests that a maintainer can land directly, and record
why each remaining one is held. This supersedes `260726_pr_close_rework`, whose
nine-PR map is now stale: eight of its targets are already resolved
(#437 #460 #431 #405 #459 CLOSED; #466 #468 #467 MERGED) and only #429 survives.

Baseline: `dev` = `origin/dev` = `1c33fb52`.
Inventory snapshot: 2026-07-26, taken with `gh pr list --state open`.

## Inventory — 14 open PRs

| PR | Author | Size | State | Surface |
|----|--------|------|-------|---------|
| #355 | tizerluo | — | MERGEABLE/UNSTABLE | Google Antigravity OAuth image output |
| #408 | Wibias | — | UNKNOWN | Windows UAC elevation |
| #424 | tizerluo | — | MERGEABLE/UNSTABLE | xAI OAuth image bridge |
| #426 | chrisae9 | 60 files | CONFLICTING/DIRTY | account to model credential routing |
| #429 | Aciredy | 5 files | CONFLICTING/DIRTY | Cursor prompt purity |
| #447 | coseung2 | +1573/-136 | MERGEABLE/UNSTABLE | Kiro OAuth multi-account |
| #455 | lidge-jun | Go tree | CONFLICTING | wrong-branch export trigger |
| #461 | mihneaptu | 6 files | CONFLICTING/DIRTY | `ocx opencode` launcher, copies user config |
| #464 | snowyukitty | +339/-2 | MERGEABLE/CLEAN | router baseUrl warning |
| #479 | Wibias | +3491/-63, 42 files | MERGEABLE/UNSTABLE | OAuth reliability/integrity |
| #482 | Wibias | — | MERGEABLE/UNSTABLE | release-notes automation |
| #483 | Wibias | +669/-63 | MERGEABLE/UNSTABLE | cyber_policy error fidelity |
| #489 | elppaaa | +84/-0 | MERGEABLE/UNSTABLE | forward-mode param stripping |
| #491 | wonsh42 | +102/-3 | MERGEABLE/UNSTABLE | OAuth API-key preservation |

## Classification

`MAINTAINERS.md:22-23` is the governing rule:

> Authentication, credential handling, GitHub Actions, release automation,
> dependency installation, and other security-boundary changes require explicit
> security review.

`MAINTAINERS.md:21` adds "Authors do not approve their own pull requests."

### A. Direct integration (this loop)

| PR | Why it is safe to land | WP |
|----|------------------------|-----|
| #489 | 84 added lines, one adapter function plus tests. Touches no credential path — it deletes two request fields the ChatGPT backend rejects. | WP1 |
| #464 | Diagnostic warning only. Deliberately logs `URL.origin` and withholds the path because a configured `baseUrl` path can itself be the credential. Improves the privacy posture rather than risking it. | WP2 |
| #483 | Error-fidelity plumbing across the proxy path. Preserves upstream `cyber_policy` errors instead of flattening them; no auth or credential handling. | WP3 |

### B. Security review required — do not self-merge

| PR | Boundary triggered |
|----|--------------------|
| #479 | OAuth store, refresh locking, credential integrity — the largest credential-handling change open |
| #447 | Kiro OAuth flow, credential store, multi-account binding |
| #491 | OAuth login path deleting a stored provider API key |
| #426 | account-qualified namespaces route credentials per account |
| #355 | Google Antigravity OAuth token transport |
| #424 | xAI OAuth plus paid-call surface |
| #408 | Windows UAC privilege elevation |
| #482 | release automation (`MAINTAINERS.md:22`) |

#479, #482 and #483 are all authored by the same contributor; only #483 is
outside the boundary, so only #483 is eligible here.

### C. Held for the author / wrong branch

| PR | Reason |
|----|--------|
| #455 | Titled `[WRONG BRANCH]` by its own author; carries the whole Go tree and temporary workflow triggers |
| #461 | Copies user config, duplicating secrets — needs the author's redesign, not a maintainer rewrite |
| #429 | CONFLICTING against current `dev`; the Cursor adapter moved underneath it. Rebasing it is a separate unit with its own risk. |

## Loop-spec

- Loop archetype: verifier-defined. Each work-phase lands a specific PR and the
  verifier is that PR's own tests plus the repository gates.
- Write scope: `src/`, `gui/src/`, `tests/`, `gui/tests/`, `docs-site/`,
  `devlog/_plan/260726_pr_rework_v2/`.
- Out of scope: merging any category-B PR, `dev2-go`, `feat/macos-app`, npm
  publish or GitHub Release, version bumps, `main`/`preview` promotion.
- Bounds: local gates plus the already-authenticated `gh`/`git` remote. Remote
  mutations authorized this turn: push `dev`, comment on the PRs handled here.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` (this doc) | Inventory + classification | — |
| WP1 | `010_wp1_forward_param_strip_489.md` | Land #489 | — |
| WP2 | `020_wp2_router_baseurl_warning_464.md` | Land #464 | — |
| WP3 | `030_wp3_cyber_policy_fidelity_483.md` | Land #483 | — |
| WP4 | `040_wp4_gates_and_push.md` | Full gates, push, PR close-out comments | WP1–WP3 |

Ordering is dependency-driven (PHASE-SPLIT-01), smallest blast radius first:
#489 touches one adapter, #464 one router path plus docs, #483 spans seven
source files. Each lands as its own commit.

## Integration method

Every PR is landed by cherry-picking or re-applying the author's commits so
authorship survives, never by retyping the diff as my own. Where a conflict
forces a rewrite, the commit carries `Co-authored-by:`.

## Accept criteria

- `c-roadmap` — this unit reflects verified PR state (`gh pr view` per PR) and
  every classification cites the rule or the concrete surface behind it.
- `c-gates` — after integration: `bun run typecheck`, `bun run test`, `gui bun
  run test`, `bun run lint:gui`, `bun run privacy:scan`, zero new failures.
- `c-push` — `dev` pushed; `git rev-parse HEAD` equals `git ls-remote origin
  refs/heads/dev`.
