# AGENTS.md

Guidance for AI agents (and humans) working on or reviewing this repository.

## What this project is

opencodex (`ocx`) is a universal provider proxy for OpenAI Codex and Claude Code:
one local proxy that lets Codex CLI/App/SDK and Claude Code use many LLM
providers (Claude, Gemini, Grok, DeepSeek, Ollama, and more). The runtime is
Bun-native TypeScript with no separate server compile step.

## Repository layout

- `src/` — proxy runtime: routing, provider adapters, config, management API.
- `tests/` — flat Bun tests (`tests/*.test.ts`); shared fixtures in
  `tests/helpers/`, broader scenarios in `tests/e2e-style/`.
- `gui/` — React + Vite dashboard; packaged output is served from `gui/dist`.
- `docs-site/` — public docs (Astro + Starlight), deployed to GitHub Pages.
- `structure/` — maintainer invariants and architecture notes; read before
  changing shared subsystems.
- `scripts/` — release and maintenance tooling; `scripts/release.ts` is the
  release authority.
- `devlog/` — planning and investigation artifacts (mostly gitignored).

## Commands

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test           # full tests/ suite
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

Run `bun run typecheck` and `bun run test` before proposing or approving any
non-trivial change. CI runs these on Linux, Windows, and macOS.

## Branch policy

- `dev` — integration branch and the default target. A pull request goes here
  unless it belongs to a scoped line below.
- `dev2-go` — parallel integration line for the Go native port: `go/`,
  `bin/native-runtime.mjs`, `src/lib/runtime-entry.ts`, and the Go
  release-asset tooling. Open for pull requests: the target-branch check
  accepts `dev` and `dev2-go` as integration targets. Keep it to scoped Go
  native-port work — the check cannot tell an intentional target from a
  mistaken one, so that boundary is a review decision. It converges back
  through maintainer-controlled merges, and promotion to `main` still happens
  only from `dev`.
- `main` — release branch. It only moves by maintainer-controlled promotion
  from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
- `preview` — prerelease train (`x.y.z-preview.*` versions).

The Claude Desktop integration formerly carried on the `claudedesktop` branch is
now fully merged into `dev`, and that branch has been retired. Desktop work
continues as normal pull requests against `dev`.

Porting and rebase pull requests are welcome. Forward-porting a fix from one
integration line to another, or rebasing a stale branch onto the current head,
is ordinary maintenance rather than noise — open it as a normal pull request
and name the source commits in the description.

[`MAINTAINERS.md`](./MAINTAINERS.md) is authoritative for review and merge
policy (approvals, CI requirements, security review, promotion). This file
summarizes; it never overrides it.

## Review guidelines

These rules apply to all code reviews on this repository, including automated
reviewers (Codex, CodeRabbit).

- **Language:** always review in English, regardless of the PR or issue
  language. Be detailed and specific: name the file and line, describe the
  concrete failure mode, and suggest a fix. Avoid vague or purely stylistic
  commentary.
- **Branch targeting:** flag any pull request that targets neither `dev` nor
  `dev2-go` (releases and maintainer promotions are the only exceptions).
  `dev2-go` is accepted by the automation but scoped by review: if a pull
  request targets it without touching `go/`, the native runtime entrypoint, or
  the Go release-asset tooling, ask the author to retarget to `dev`. The
  automation cannot make that judgement, which is why it is yours.
- **Security boundary (highest priority):** changes touching authentication,
  credential/token handling, OAuth flows, GitHub Actions workflows, release
  automation (`scripts/release.ts`, `.github/workflows/release.yml`), or
  dependency installation require explicit security review per
  `MAINTAINERS.md`. Treat token logging/serialization, secret exposure,
  workflow permission escalation, and mutable third-party action refs as
  release blockers.
- **Runtime constraints:** the proxy is Bun-native. Flag Node-only APIs,
  assumptions about a compile step, or code paths that break `bun run
  typecheck` / `bun run test`.
- **Tests:** behavior changes in `src/` need a focused regression test near
  the existing tests for that subsystem. Shared routing, adapter, config, or
  server changes need the full suite green.
- **Docs sync:** user-facing behavior changes should update `docs-site/` (and
  keep translated locales from contradicting the English source).
- **Privacy:** `bun run privacy:scan` must stay green; never introduce logging
  of request bodies, API keys, or account identifiers.
