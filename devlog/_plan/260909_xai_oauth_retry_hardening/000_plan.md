# xAI OAuth retry hardening — unit plan

## Reader summary

Four filed defects in `src/oauth/xai.ts` (#4045, #4046, #4047, #4048) all sit in
the token-request path that runs on every Grok login and every token refresh:
`postXaiToken` clamps the server-provided `Retry-After` to 2 s, ignores its
HTTP-date and fractional forms, and keeps retrying after the caller has aborted
whenever the abort carries a custom reason; `validateXaiEndpoint` accepts any
`*.x.ai` subdomain and URLs with embedded userinfo on the endpoint that receives
the `refresh_token`. This unit ships two pull requests: phase 1 fixes the three
retry/abort bugs as one cohesive change, phase 2 hardens endpoint validation as a
separate security change layered on phase 1. Grok-account users get retries that
honor the server and stop when cancelled; the credential-destination check stops
trusting unbounded subdomains.

## Loop spec

- **Loop archetype:** satisfy-spec — the expected contracts are stated in the four
  public issues; no candidate exploration.
- **Trigger:** delegated release-preparation task from the managing thread
  (`01a08498-4ebf-7ad3-89c2-fb56c8ea53bf`), user-authorized: implement, publish
  PRs, verify via remote CI, await serial merge assignment.
- **Goal:** PR1 (base `dev`) fixes #4045/#4046/#4047 with regression tests; PR2
  (base = PR1 head) fixes #4048 with regression tests; both carry exact-head
  remote CI evidence.
- **Non-goals:** release, promotion, `main` push, deploy, merges (merge awaits
  the managing task's serial assignment); no local product test
  suite/typecheck/build/install (user restriction — labeled NOT RUN); no changes
  to other providers' auth lanes; no GitHub native stacks (ordinary dependent PR
  chain only).
- **Verifier:** GitHub Actions `ci.yml` ("Cross-platform CI") on each pull
  request — it triggers on every `pull_request` event with no base filter and
  its `changes` gate includes `src/**` and `tests/**`, so both PRs (including
  the stacked child) receive the real PR jobs: Linux `test`, macOS
  `platform-macos`, and `gates` (`tsc --noEmit`). The Windows
  `platform-windows` and `macos-control` jobs are NOT ON PR — they run only
  via `workflow_dispatch` `lane=all`; the cumulative final-head `lane=all`
  dispatch before any merge is owned by the managing task. Exact-head check runs
  are recorded per PR. Local verifiers (`bun test`, `bun run typecheck`) are
  NOT RUN by user restriction; the plan instead maps each new test to the file CI
  executes (`tests/providers/xai/xai-oauth-retry.test.ts`).
- **Stop condition:** both PRs published with template-complete bodies,
  exact-head CI recorded, and the managing task handed the PR/head/CI report.
- **Memory artifact:** this unit directory; goalplan
  `.codexclaw/goalplans/fix-opencodex-4045-4046-4047-xai-oauth-retry-aft/`;
  scratch-only security detail in `.tmp/260909_xai_endpoint_security/`
  (gitignored) per the repository security-notes policy.
- **Expected terminal outcomes:** DONE = both PRs published with green exact-head
  CI and handoff reported. BLOCKED = CI failure that requires out-of-scope files,
  or a policy question only the managing task can answer.
- **Escalation condition:** any need to touch files outside the owned set
  (`src/oauth/xai.ts`, `tests/providers/xai/`, this unit, scratch), any merge or
  `main`/`preview` action, or a verifier verdict that contradicts the issue
  contract. A delegated slice that two agents fail returns to the main lane rather
  than being re-dispatched.

### HOTL resource bounds

- Tool/credential scope: `gh` as the repository owner for reads and PR creation
  on `lidge-jun/opencodex`; no merge, release, or settings writes.
- Write scope: `src/oauth/xai.ts`, `tests/providers/xai/xai-oauth-retry.test.ts`,
  `devlog/_plan/260909_xai_oauth_retry_hardening/`, `.tmp/` scratch. Git
  mutations use `-c core.hooksPath=/dev/null`; pushes use `--no-verify`.
- Token/cost and wall-clock budgets: none set by the user; unbounded within the
  session, reported at handoff.

## Constraints

- `src/AGENTS.md`: OAuth/token changes are security-boundary changes; regression
  coverage sits near the existing subsystem tests; public exports are preserved.
- `tests/providers/xai/xai-oauth-retry.test.ts` already exists in
  `scripts/test-layout/layout.json` `explicit` (line 1301) and
  `tests/fixtures/test-layout-expected.json`; extending it avoids layout churn.
- Root `AGENTS.md`: pre-disclosure security working notes live in scratch
  (`.tmp/`), never in `devlog/`. Issue #4048 is public and its sketch fix is
  public, but the assessment and patch plan for phase 2 are held in scratch until
  the PR diff itself is public.
- `MAINTAINERS.md` (2026-09-06): maintainer integration into `dev` without a
  second approval exists but is exercised only by the managing task; this unit
  performs no merges.

## Work-phase map (dependency-ordered)

| Phase | Doc | Output | Depends on |
|-------|-----|--------|------------|
| wp1 (this cycle) | `000_plan.md`, `010_*`, `020_*` | Locked roadmap | — |
| wp2 | `010_phase1_retry_after_abort.md` | PR1: retry/abort fixes + tests, base `dev` | wp1 |
| wp3 | `020_phase2_endpoint_validation.md` | PR2: endpoint validation hardening + tests, base = PR1 head | wp2 (same file; layered to avoid self-conflict) |

Phase order follows the build order: the retry-path repair rewrites the same
function cluster the endpoint guard sits next to, so the security layer stacks on
the repaired file rather than racing it as a parallel root.

## Independent verification

Four read-only verifier subagents (xai/grok-4.6, one per issue) re-check each
claimed defect and proposed fix against the live code before phase 1 builds; their
verdicts fold into the phase-1 audit. Live discovery evidence (2026-09-09):
`https://auth.x.ai/.well-known/openid-configuration` returns only
`auth.x.ai` hosts for `authorization_endpoint` and `token_endpoint`.
