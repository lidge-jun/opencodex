# 260627 PR #38/#39 two-pass merge plan

## Objective

Integrate incoming PRs onto `dev` in two full PABCD work-phases:

1. Phase 1: merge PR #38 (`task/update-docs-gui-deps-and-checkout-v7`) onto local `dev`, preserving the current local commit `c560b54`.
2. Phase 2: merge PR #39 (`ingw/opencodex-hardening-dev-pr`) onto the updated `dev`, review high-risk runtime/service/auth changes, apply focused fixes when needed, then verify and commit.

## Current State

- Project root: `/Users/jun/Developer/new/700_projects/opencodex`
- Current branch: `dev`
- Local status before plan: `dev...origin/dev [ahead 1]`
- Local commit to preserve: `c560b54 fix(oauth): classify stale provider config`
- Open PRs:
  - #38, base `main`, docs/dashboard dependency and checkout workflow update, CI pass.
  - #39, base `dev`, broad hardening PR, CI pass.
- Existing unrelated dirty Cursor work was present earlier in the session and must not be staged unless it is part of the chosen PR merge.

## Phase Map

### Phase 1 PABCD: PR #38

Intent: low-risk dependency/tooling PR.

Actions:

- Fetch PR #38.
- Merge/cherry-pick PR #38 onto `dev` after the local `c560b54` commit.
- Resolve conflicts conservatively, preferring current `dev` behavior outside dependency/workflow files.
- Run:
  - `bun run typecheck`
  - `bun test tests`
  - `cd gui && bun run build`
  - `cd docs-site && bun run build`
- Commit if GitHub merge/cherry-pick does not already produce a merge commit.

Expected file surface:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy-docs.yml`
- `.github/workflows/release.yml`
- `.github/workflows/service-lifecycle.yml`
- `docs-site/package.json`
- `docs-site/bun.lock`
- `gui/package.json`
- `gui/bun.lock`

### Phase 2 PABCD: PR #39

Intent: high-risk runtime/service/auth hardening.

Actions:

- Fetch PR #39.
- Merge onto `dev` after Phase 1.
- Resolve conflicts around recent local Codex Auth duplicate bucket work and OAuth unsupported-provider classification.
- Risk review surfaces:
  - service install/start/stop/uninstall lifecycle
  - non-loopback API auth and GUI token prompt
  - provider management API validation
  - package publish contents and Node launcher
  - Codex account pool privacy/reauth behavior
  - passthrough/WebSocket request logging and outcome tracking
- Apply follow-up fixes for any concrete regressions discovered during review.
- Run:
  - `bun install --frozen-lockfile`
  - `bun run typecheck`
  - `bun test tests`
  - `bun run build:gui`
  - `bun run privacy:scan`
- Commit merge/fixes atomically.

Expected file surface:

- Packaging/release/workflows: `.github/workflows/*`, `.npmignore`, `package.json`, `bin/*`, `scripts/*`
- Runtime/service/auth: `src/server.ts`, `src/service.ts`, `src/service-secrets.ts`, `src/config.ts`, `src/oauth/*`, `src/codex-*`
- Adapters/routing/parser: `src/adapters/*`, `src/router.ts`, `src/responses/parser.ts`, `src/ws-bridge.ts`
- GUI/docs/tests matching the PR.

## Risk Controls

- Use merge/cherry-pick rather than manually copying patch text.
- Never stage unrelated local dirty files.
- Check `git status --short` before every commit.
- Treat #39 as THOROUGH verification because it touches auth, service lifecycle, credentials, packaging, and runtime routing.
- If #39 conflicts with local Codex Auth duplicate-bucket logic, preserve the local rule: personal and workspace/team/business accounts are separate duplicate buckets, with same-bucket `chatgpt_account_id + normalized email` collision checks.

## Completion Criteria

- Both PRs are integrated onto local `dev`.
- Local `dev` contains the preserved local OAuth fix plus the merged PR work.
- No unrelated dirty files are staged or committed.
- Verification commands complete successfully.
- Final status and commit list are reported.
