# Issue #180 — CLI account/key parity with GUI (loop roadmap)

GitHub: https://github.com/lidge-jun/opencodex/issues/180
Goalplan: `.codexclaw/goalplans/issue-180-https-github-com-lidge-jun-opencodex-i/`
Entry mode: HOTL cxc-loop, docs-first (LOOP-DOCS-FIRST-01). This 000-range plus the
decade docs below are the deliverable of the docs-only work-phase 1; implementation
starts at work-phase 2, one decade doc per PABCD cycle.

## Loop specification

- Archetype: spec-satisfaction repair. The verifier is the issue #180 command surface
  plus the GUI↔CLI parity matrix; each slice is checkable locally (unit tests + live
  local management-API invocations).
- Trigger: GUI exposes multi-account and API-key pool management (Codex ChatGPT
  account pool, generic OAuth accounts, apiKeyPool providers) while the `ocx` CLI has
  no official command surface for it; terminal/SSH users must hand-call the
  management API with curl.
- Goal: an official, consistent `ocx account` CLI family covering every
  account/credential capability the GUI has, with masked output, `--json`, correct
  exit codes, runtime-port auto-resolution, and docs — plus a durable parity matrix
  for any remaining GUI↔CLI gaps found by the survey.
- Non-goals: GUI code changes, new auth protocols or storage formats, account/key
  add/remove flows that require new server contracts (list/switch first; add/remove
  only where an existing management endpoint already supports it), git push, release,
  npm publish. Never touch the concurrently-staged Qwen/base-url provider work in
  the git index (another session owns it).
- Verifier: `bun run typecheck`, `bun test --isolate ./tests/` (focused new test
  file(s)), and real CLI invocations against the live local proxy on 127.0.0.1
  (list/current/use, `--json`, unknown-provider and unknown-account exit codes,
  secret-masking grep over outputs).
- Stop condition: every goalplan criterion carries fresh capturedEvidence; the sol
  reviewer audit of this roadmap passed with no open High/Critical blocker.
- Memory artifact: this unit (`devlog/_plan/260720_issue180_cli_account_parity/`),
  the bound goalplan + ledger, local commits on `dev` (pathspec-scoped).
- Terminal outcomes: `DONE` on verified criteria; `NOOP` for a slice already
  satisfying criteria; `BLOCKED` if a required management contract is missing and
  cannot be added safely; `UNSAFE` if any output path could print raw secrets;
  `NEEDS_HUMAN` for product-intent gaps (e.g. command-naming conflicts);
  `BUDGET_EXHAUSTED` only at the bounds below.
- Escalation: main agent reclaims a slice after two distinct agents fail the same
  packet; any new delegated write slice is a P-phase amendment first.

## Classification and resource bounds

- Overall work: C3 cross-domain feature (CLI surface + management-API client + docs).
- Secret-handling slices: C4 verification depth for output masking — CLI must never
  print raw access tokens or API keys, matching GUI/management-API masking.
- Tool/credential scope: local repo, live local management API on 127.0.0.1 read +
  the documented PUT switch endpoints (reversible account switches only). No paid
  external calls, no new dependencies.
- Write scope: `src/cli/*`, `tests/*`, `docs-site/src/content/docs/**` (cli +
  providers pages), this devlog unit, the bound goalplan. `src/server/*` only if a
  genuinely missing contract is proven at P (amendment-required).
- Delegation bound: at most 4 concurrent agents; writes stay main-agent owned unless
  a P amendment assigns disjoint files.
- Wall-clock bound: ~3h active loop work; compaction is not exhaustion.

## Necessity gate

- Do nothing: rejected — issue #180 is an open feature request; SSH/terminal users
  currently need raw curl against the management API.
- Delete: nothing to delete; no dead CLI surface exists for this domain.
- Configure: rejected — no config flag can expose account switching in a terminal.
- Reuse: selected — reuse the existing management API endpoints
  (`/api/codex-auth/*`, `/api/oauth/accounts*`, `/api/providers/keys*`) and the
  CLI's existing runtime-port/proxy-liveness helpers; add a thin CLI command family
  on top. Exact contracts confirmed in `001_*.md`–`003_*.md`.

## Architecture anchors (pre-survey; confirmed by explorer lanes)

```text
src/cli/index.ts          command dispatch (args[0] switch)
src/cli/help.ts           usage text registry
src/cli/status.ts         existing API-talking command (port resolution pattern)
src/cli/provider.ts       existing provider command family (convention donor)
src/server/management-api.ts  oauth accounts + provider keys endpoints
src/codex/auth-api.ts     codex-auth accounts/active endpoints
gui (reference only)      CodexAccountPool.tsx, ProviderAuthPanel.tsx, pages/Providers.tsx
```

## Work-phase map (locked at WP1-D after survey synthesis)

| WP | Decade doc | Slice | Depends on |
|----|-----------|-------|------------|
| 1 | (this cycle) | Docs-only: survey + roadmap | — |
| 2 | 010_account_cli_core.md | `ocx account list|current|use` + tests | WP1 |
| 3 | 020_account_cli_extended.md | codex-pool extras (refresh/auto-switch), single-slot OAuth guidance | WP2 |
| 4 | 030_docs_and_parity_closeout.md | docs-site CLI/providers pages + parity matrix closeout | WP2 |

The WP1-D lock refines this map 1:1 onto the decade docs actually written; the map
is APPEND-friendly (LOOP-UNIT-CHAIN-01) for parity gaps beyond issue #180's scope
that the survey uncovers.

## Document index

| Doc | Range | Content |
|-----|-------|---------|
| `000_plan.md` | research | this file |
| `001_gui_feature_inventory.md` | research | GUI feature ↔ API mapping (explorer lane 1) |
| `002_cli_command_inventory.md` | research | existing CLI surface + conventions (lane 2) |
| `003_management_api_contracts.md` | research | credential endpoint contracts (lane 3) |
| `004_parity_matrix.md` | research | GUI↔CLI coverage matrix + gap classification |
| `010_account_cli_core.md` | phase 1 | diff-level design: `ocx account list|current|use` |
| `020_account_cli_extended.md` | phase 2 | diff-level design: codex-pool extras + guidance |
| `030_docs_and_parity_closeout.md` | phase 3 | diff-level design: docs updates + closeout |
