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
- `go/` — retired Go native-runtime experiment; kept only where the TypeScript
  runtime still references it. New work does not go here.
- `structure/` — maintainer invariants and architecture notes; read before
  changing shared subsystems.
- `scripts/` — release and maintenance tooling; `scripts/release.ts` is the
  release authority.
- `devlog/` — maintainer-only planning and investigation notes. This is a
  **private submodule** (`lidge-jun/opencodex-internal`), not a directory of
  this repository. See "The `devlog` submodule" below.

Read the nearest nested `AGENTS.md` before changing files in a scoped
directory (`src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`).

## The `devlog` submodule

Planning notes, triage matrices, and investigation artifacts live in the private
`lidge-jun/opencodex-internal` repository, wired in as the `devlog` submodule.
They quote live infrastructure state, provider behaviour, unfixed defects, and
internal triage reasoning, so a public clone should carry the runtime and its
docs and nothing else.

The pointer is deliberately **loose**, so a missing or stale `devlog` can never
fail a check:

- `.gitmodules` declares `ignore = dirty`, `update = none`, and `shallow = true`.
  A dirty or moved submodule working tree does not show up in `git status` on
  the parent, and `git submodule update` will not touch it unless asked
  explicitly.
- No workflow checks it out. `actions/checkout` runs without `submodules:`, so
  CI clones the public tree only and the private URL is never resolved.
- Nothing in the build, test, typecheck, or privacy-scan path reads from
  `devlog/`. Contributors without access see an empty directory and every gate
  still passes.
- `devlog/` stays listed in `.gitignore` for the working tree; the submodule
  gitlink is tracked, its contents are not.

Two rules keep it that way. Never commit anything under `devlog/` to *this*
repository — commit inside the submodule, then update the pointer here as a
separate commit. And never nest a git repository inside the submodule: a
`160000` gitlink in a tree that CI does not initialize breaks
`actions/checkout` for every contributor, which is exactly what happened before
this split.

## Security working notes

**Security work is done in scratch space, never in a tracked directory.** That
includes unreleased findings, severity assessments, draft advisories, exploit
or bypass reasoning, reproduction steps for an unfixed defect, and
pre-disclosure patch plans.

Use `.tmp/` in the working tree (already gitignored) or a `mktemp -d` path.
`devlog/` is **not** an acceptable location, and neither is a private
repository: both get cloned across machines and CI, both outlive the embargo,
and neither history is practical to purge afterwards.

Only the published outcome reaches a repository — the fix itself, its
regression test, the release note, the advisory once it is public. Draft the
advisory in scratch space and delete the scratch directory once the advisory is
live.

This applies to `AGENTS.md`-following agents as much as to humans. If a task
asks you to write up a security finding, put the write-up in scratch space and
say where it is; do not add it to `devlog/`, `structure/`, or `docs-site/`.

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

- `dev` — the single integration branch and the target for every pull request.
- `main` — release branch. It only moves by maintainer-controlled promotion
  from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
- `preview` — prerelease train (`x.y.z-preview.*` versions).

### The retired `dev2-go` line

The project previously ran a parallel `dev2-go` integration line that was
rebuilding the runtime as a Go native port, and every merge into `dev` had to be
carried onto it. That dual-track policy is over: maintaining two integration
lines cost more than the port returned, and dogfooding the Go runtime kept
surfacing new defects.

`dev2-go` has been deleted, along with the `codex/260728-go-port-*` and
`tmp/dev2-go-source-export` side branches. The full history lives in
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive)
and the final tip is tagged `archive/dev2-go` in this repository. There is no
carry or port obligation attached to a `dev` merge any more, and the
`needs-go-port` label is gone.

Bun-native TypeScript is the only runtime line. If native code returns, the
expectation is an incremental module (for example Rust via N-API) landing on
`dev`, not a second full-runtime branch.

The Claude Desktop integration formerly carried on the `claudedesktop` branch is
now fully merged into `dev`, and that branch has been retired. Desktop work
continues as normal pull requests against `dev`.

Porting and rebase pull requests are welcome. Forward-porting a fix from one
integration line to another, or rebasing a stale branch onto the current head,
is ordinary maintenance rather than noise — open it as a normal pull request
and name the source commits in the description.

The **`enforce-target`** CI check rejects pull requests whose head
ancestry sits on the **`main`** tip while far behind **`dev`**, and rejects
empty, thin, or malformed descriptions; authors with repository push permission
skip the ancestry heuristic only. As with approval requirements in
[`MAINTAINERS.md`](./MAINTAINERS.md), this is enforced by convention until
branch protection is configured.

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
- **Branch targeting:** flag any pull request that does not target `dev`
  (releases and maintainer promotions are the only exceptions).
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
