# L5 auth-quota carry — roadmap

Status: roadmap locked at wp1 D (2026-10-09); wp2 and wp3 revalidate their unit doc at P.

Two contributor fixes in the auth and quota area are open but cannot land as-is: #6739 (Ollama Cloud quota reads a retired /api/usage payload, so the row silently disappears from the quota dashboard) and #6745 (ChatGPT OAuth refresh has no deadline, drops caller cancellation, and classifies refresh failures incompletely; see #6745). This lane carries both onto current `dev` as maintainer carry PRs, folds in the gaps found in review, and stops each PR at merge-ready. Users of Ollama Cloud get their quota row back; ChatGPT OAuth users stop hanging on a stalled refresh and stop being re-asked to log in after a transient failure.

## Loop spec

- **Loop archetype:** satisfy-spec, three work-phases (wp1 this roadmap, wp2 #6739, wp3 #6745).
- **Trigger:** coordinator thread 01a11e2e dispatched lane L5 (auth-quota) with HOTL cxc-loop authority.
- **Goal:** two carry PRs against `dev`, each with exact-head hosted CI green and an independent gpt-6.1-sol review PASS (security review PASS for #6745).
- **Non-goals:** merging, commenting on or closing #6739/#6745, pushing to contributor forks, approving fork workflows, release, the #6594 import-cycle refactor, any other lane's area (L1 desktop-cli, L2 service-journal, L3 compaction, L4 admission-jev, L6 lazycodex, L7 ci-infra). No full `bun run test` locally (user limit: minimal local tests).
- **Verifier:** focused test files per unit (010/020 list them with what each observes), `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`, then exact-head hosted CI on the carry PR, including the `docs site build` job for the docs edits (structure:check proves paths, not prose consistency; each unit also reads every structure owner mapped to its source area in `structure/INDEX.md`).
- **Stop condition:** both PRs merge-ready, or a NEEDS_HUMAN decision is recorded.
- **Memory artifact:** this directory; unpublished security analysis lives in the lane's `.tmp/`, never here.
- **Expected terminal outcomes:** DONE (both merge-ready); NEEDS_HUMAN (upstream API evidence contradicts #6739, or security review raises a policy question); BLOCKED (hosted CI cannot run after one retry).
- **Escalation condition:** merge approval, closing the originals, and any policy decision go to the user via the coordinator. Two failed reviewer rounds on the same blocker trigger root-cause work (LOOP-REPAIR-01).
- **Resource bounds:** tools = gh with the maintainer's existing credentials, git in `.tmp/lanes/L5-auth-quota` only; no token or time budget was set by the user.

## Order and dependencies

| Phase | Unit | Branch | Depends on |
|---|---|---|---|
| wp1 | this roadmap | committed on `codex/auth-quota-carry` | — |
| wp2 | [010 #6739 Ollama /api/balance](010_ollama_balance_quota.md) | `codex/ollama-balance-quota-carry` | wp1 |
| wp3 | #6745 ChatGPT refresh hardening (unit plan kept in lane scratch until the fix ships) | `codex/auth-quota-carry` | wp1 |

wp2 and wp3 touch disjoint source (`src/providers/quota/*` vs `src/oauth/*`) and share only `structure/providers-and-adapters.md` and the test-layout registries; whichever lands second rebases. wp2 runs first because it is a user-visible outage with a smaller blast radius; wp3 is an auth-boundary change that needs the separate security review.

The PABCD session source is pinned to `.tmp/lanes/L5-auth-quota`, so both units are built in that worktree by switching branches between cycles.

## Architect consultation

- Handle: gpt-6.1-sol subagent `01a11e35-e5fc-7290-93eb-73114804b458` (Harvey), read-only, proposal returned 2026-10-09 with decisions Q1–Q5 (#6739) and O1–O6 (#6745).
- Dispositions: all accepted, with amendments recorded per decision in 010 and in the wp3 unit plan. Q5's public doc lands in `docs-site/src/content/docs/guides/providers.md` beside the existing MiniMax quota paragraph.
- Reflection: see the "Reflection" section appended below after the same architect reviewed this revision.

## Upstream evidence for #6739

- `ollama/ollama#18829` "server: proxy cloud usage and balance APIs" shipped in Ollama v0.40.1 (2026-10-07); tracking issue `ollama/ollama#18653`.
- Third-party SDK documentation for `GET https://ollama.com/api/balance` shows legacy plans as `included.{session,weekly}.{remaining_percent,resets_at}` + `purchased.balance_usd`, and allowance plans as `included.{balance_usd,allowance_usd,period.until}`; `resets_at` is optional.
- The old `/api/usage` shape `limits.{session,weekly}.usage` (0–1) is documented in fgrehm/pi-ollama-cloud#42 as undocumented and changeable. The new request-count timeseries is attested only by the PR author's live check.

## Reflection

- Round 1 (same architect handle): MISALIGNED with seven gaps (four in 010 and the summary, three in the wp3 unit plan); all folded. Round 2: ALIGNED.

## Audit (A)

- Independent gpt-6.1-sol auditor 01a11e3d: NEAR-PASS with two wp3 test-design blockers, both folded into the wp3 unit plan. Q3 keeps today's hard-4xx terminal rule; the docs-site build job and per-unit structure-owner reads are added to the verifier.
