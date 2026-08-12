---
title: FAB-00 Live Repository Assessment
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
base_branch: fab/00-agent-fabric (from origin/main @ f9b9440, v2.10.0)
---

# 010 -- Live Repository Assessment

## 1. Repository identity

- Package: `@bitkyc08/opencodex` v2.10.0 on `origin/main` (`f9b9440`) after a `git fetch` refreshed a stale local remote-tracking ref (which initially showed v2.6.25/`bbb630e`); `origin/dev` carries preview work. License: MIT. Runtime: Bun (TypeScript), Node>=18 shim. Cross-platform macOS/Linux/Windows (no WSL required on Windows).
- Purpose (canonical, `structure/00_overview.md`): a **local Responses-compatible proxy for Codex** -- routes Codex `/v1/responses` to any LLM provider; manages a ChatGPT account pool for Codex auth.
- GitHub description (2026-08-03): "Universal provider proxy for OpenAI Codex **& Claude Code** -- use any LLM ... with Codex CLI, App, SDK, and Claude Code." Note: Claude Code is now also a *proxied client* of opencodex, not a managed target.

## 2. Remotes, branches, worktrees

- `origin` = github.com/lidge-jun/opencodex ; `fork` = github.com/Wibias/opencodex.
- Origin branches: `main`, `dev`, `dev-B`, `preview`, `codex/gpt-56-sol-terra-luna-rollout`, `cursor-fixes`, `cursor-provider-stack`, `ingw/fix-provider-error-classification`.
- FAB-00 worktree: `C:\Users\ws\opencodex-fab00` on branch `fab/00-agent-fabric` from current `origin/main` (`f9b9440`, v2.10.0) -- initially created at the stale `bbb630e` ref, then `git reset --hard origin/main` applied after a fetch revealed current main at v2.10.0. Main checkout `C:\Users\ws\opencodex` on `fix/cursor-multi-account-oauth` (clean). No other worktrees pre-existing.
- Branch policy (`ci.yml`): PRs target `main`/`dev`; `dev` is the normal integration line; `preview` stages `dev-B` merges.

## 3. Source-of-truth documents (read in full)

- `structure/00-07_*.md`: maintainer SOT -- product boundary/invariants, runtime entrypoints, config & CODEX_HOME, catalog & subagents, transports & sidecars, GUI & management API, docs & release, design methodology.
- `docs/`: dated investigations (`codex-path-investigation`, `codex-app-model-catalog`) + ADRs 0001-0003. Each marked "archive, not current behavior."
- `docs-site/`: public Astro/Starlight docs (en/ko/zh-cn).
- `.github/workflows`: `ci`, `release`, `deploy-docs`, `service-lifecycle`.

## 4. Governance gap (recorded finding)

- **No** `AGENTS.md`, `CONTRIBUTING.md`, or `MAINTAINERS.md` at repo root. The launch prompt's required first action ("read root AGENTS.md/CONTRIBUTING.md/MAINTAINERS.md") could not be satisfied from the root. PR #923's body cites "MAINTAINERS.md / contributing" as a primary-source standard, implying such guidance exists at a non-root path not located in this pass. Recorded; does not block FAB-00 (planning-only) but is a governance finding for FAB-01.

## 5. CI / required checks

`ci.yml` (ubuntu/windows/macos, fail-fast:false): `bun install --frozen-lockfile`; `bun x tsc --noEmit`; `bun test tests`; `bun run privacy:scan`; release-helper build; GUI build; CLI help smoke. Plus `npm-global-smoke` (Node 20, no Bun). FAB-00 changes are docs-only under `devlog/_plan/**` and do **not** match ci.yml path filters, so CI is not triggered; the privacy-scan invariant (no prompts/secrets committed) is honored by the privacy decision in `100`.

## 6. Local state and Codex integration boundary

- OpenCodex-owned: `~/.opencodex/{config.json, auth.json (multiauth OAuth), catalog-backup.json, usage.jsonl (0o600, no prompts)}`.
- Codex-owned, edited by OpenCodex: `$CODEX_HOME/{config.toml, opencodex.config.toml, opencodex-catalog.json, models_cache.json}`. `CODEX_HOME` resolved via `src/codex/paths.ts` (set+valid dir else `~/.codex`).
- **DIRECTION (critical)**: OpenCodex is **DOWNSTREAM** -- Codex calls OpenCodex as a *provider* (`http://127.0.0.1:<port>/v1/responses`). OpenCodex does **not** drive Codex sessions. The master plan sec.12 premise ("Use Codex App Server for managed execution") is the **opposite** direction (UPSTREAM controller). This is a NEW role for OpenCodex, not an extension of an existing seam. See `030` sec.3.

## 7. Dependencies

`@bufbuild/protobuf` ^2.12 (protobuf already a dependency -- relevant to contract representation, `060`), `@modelcontextprotocol/sdk` ^1, `zod` 4.4.3, `bun` 1.3.14, `typescript` 5.9.3.

## 8. Go migration line -- ABSENT (critical stale assumption)

- No `go.mod`, no `*.go` anywhere in the repo (only vendored `node_modules/flatted/golang` and, after the spike, the disposable `spikes/spike-c-kernel/`). Repo is 100% TypeScript/Bun. Re-verified against current `origin/main` (`f9b9440`, v2.10.0) via `git ls-tree -r origin/main` -- **no `go.mod`, no `*.go` on current main either**.
- Master plan sec.7 premise ("a parallel Go migration line ... applicable behaviour must eventually exist in the Go runtime") is **not grounded in current repo state**. OpenAI Codex itself is Rust (`codex-rs`), not Go.
- System-wide Go **is** installed (`go1.26.4 windows/amd64`) but the project does not use it. See `120`.

## 9. Architecture entrypoints (for adapter/workspace design)

`src/server/index.ts` (Bun server, `/v1/responses` HTTP+WS, `/v1/models`, `/api/*` management), `src/router.ts`, `src/adapters/{openai-responses,openai-chat,anthropic,google,azure,kiro,cursor}`, `src/codex/{paths,inject,shim,catalog}`, `src/service.ts` (launchd/systemd/schtasks), `src/usage/{log,summary}`, `src/oauth/`. Adapter output stays internal `AdapterEvent` until `bridge.ts` converts to Responses SSE/WS frames.

## 10. Issues/PRs overlap (GitHub REST API, 2026-08-03)

Inspected open issues/PRs. Visible items are provider-preset additions (PR #923 "Command Code preset") and routing/compact bugs (#913, #914 pool 429/402). **None** overlap: Codex App Server managed execution, multi-agent, Go migration, worktree, handoff, agent fabric, or usage/conversation correlation as task continuity. No existing issue/PR contests or pre-empts the Fabric programme. (Full pagination beyond the first result page was not completed; recorded as a minor scope note.)

## 11. Spike runtime availability

`codex` CLI 0.133.0; `claude` Code 2.1.220; `go` 1.26.4; `bun` 1.3.14; `node` 26.4.0; `python` 3.14.5. `~/.codex` home populated (sessions, hooks, memories, mcp-oauth-locks). `CODEX_HOME` unset (defaults to `~/.codex`). All three spikes are executable live. See `140`/`150`.

## 12. Working-tree state (start of FAB-00)

Worktree `fab/00-agent-fabric` clean at `f9b9440` (origin/main, v2.10.0) -- rebased from the initial stale `bbb630e` ref after a fetch revealed current main. No native Codex storage mutated. No credentials committed. The canonical master plan (`000_master_plan.md`) was placed at `devlog/_plan/800_agent-fabric/000_master_plan.md` from the provided source file (35,085 bytes) -- this is the master plan's own sec.0 instruction and required-output file #1; it was **copied**, not reconstructed from the launch prompt.
