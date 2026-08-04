# 000 — gpt-live-proxy-login-pool: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Build a safe account-pool CLI in the standalone repository at
`/Users/jun/Developer/new/700_projects/gpt-live-proxy`.  The current binary has
only `Config::from_env()` and therefore cannot persist, select, or enumerate
multiple managed credentials.  Preserve the existing no-argument env path.

The implementation plan and detailed threat model are mirrored at
`gpt-live-proxy/devlog/_plan/260726_login-pool-cli/000_plan.md`.

## Loop-spec

- Loop archetype: judged, C4 because bearer credentials and public CLI contracts
- Write scope: `gpt-live-proxy/{src,Cargo.toml,Cargo.lock,tests,README.md,docs}`
- Out of scope: OpenAI/ChatGPT OAuth minting or refresh, GUI, opencodex runtime
- Bounds: one work-phase, one independent A audit, full existing CI-equivalent
  checks, local commit only; no push without a fresh explicit user instruction

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | `010_phase1.md` | keychain account pool, CLI, serve overlay, docs/tests | current `main` at `56f982f` |

## Accept criteria

- `login add/list/current/use/remove` and `serve --account` match the documented
  grammar and exact output/exit behavior.
- Tokens never appear in argv, metadata, stdout/stderr, Debug, JSON, git diff,
  or test artifacts; metadata writes are private and atomic.
- No-argument server startup remains the current env-only behavior.
- Account selection reuses `Config::from_source`; official Realtime remains the
  `apikey` default and ChatGPT is labeled private/subset-only.
- Fresh fmt, all-feature test/clippy, Node conformance, fixture, mutation,
  audit, gitleaks, isolated process smoke, and MSRV checks pass.
