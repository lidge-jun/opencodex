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
- `devlog/` — planning and investigation notes, tracked in this repository. See
  "The `devlog` directory" below for what may and may not go there.

Read the nearest nested `AGENTS.md` before changing files in a scoped
directory (`src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`).

## The `devlog` directory

Planning notes, triage matrices, and investigation artifacts live in `devlog/`,
tracked like any other documentation. There is no submodule and no private
mirror. It was a private submodule until the pointer churn outgrew its value:
1723 commits touched the gitlink, and `dev`, `preview`, and `main` each carried a
different pointer, so every branch move and promotion dragged a diff.

- `devlog/_plan/` — units still open, one directory per unit, decade-numbered
  docs.
- `devlog/_fin/` — closed units, moved here once a terminal outcome is recorded.
  A `_fin` unit is a record of work already visible in public git history.
- `devlog/_chase/` — external reference material for parity comparisons.
  Reference *clones* are gitignored: they are third-party source carrying their
  own licenses and have no business in this repository's history.

Nothing in the build, typecheck, or test path reads from `devlog/`, so a
contributor who ignores it entirely still passes every gate. `privacy:scan` does
read it — that is deliberate, and it is what makes a public devlog safe rather
than merely visible.

Two mechanical guards in `tests/repo-hygiene.test.ts` back this up: no `160000`
gitlink may be tracked anywhere, and neither the vendored reference clones nor
the security triage excised before publication may reappear in the index. Both
were driven red once to prove they are not vacuous. The gitlink assertion exists
because a gitlink in a tree CI does not initialize breaks `actions/checkout` for
every contributor, which happened twice.

## Security working notes

**Security work is done in scratch space, never in a tracked directory.** That
includes unreleased findings, severity assessments, draft advisories, exploit
or bypass reasoning, reproduction steps for an unfixed defect, and
pre-disclosure patch plans.

Use `.tmp/` in the working tree (already gitignored) or a `mktemp -d` path.
`devlog/` is **not** an acceptable location — it is a public directory in a
public repository, so anything committed there is disclosed the moment it is
pushed, and the history is not practical to purge afterwards. A private
repository is not acceptable either: it gets cloned across machines and CI and
outlives the embargo.

**This binds maintainers exactly as it binds contributors and agents.** The rule
has been violated by maintainer-authored triage before: two units of open
security review accumulated under `devlog/_plan/` and had to be excised before
this directory could be published. Seniority is not an exemption, and "it is
only in the private half" is no longer a thing that exists.

The test to apply before writing a security note into `devlog/`: **is there
already a public diff that reveals this weakness?** If the fix has shipped, the
writeup discloses nothing new and belongs in `_fin/`. If it has not, the note is
pre-disclosure material and goes to scratch. That distinction is why closed
hardening records stay in the tree while open triage does not.

Only the published outcome reaches a repository — the fix itself, its
regression test, the release note, the advisory once it is public. Draft the
advisory in scratch space and delete the scratch directory once the advisory is
live.

This applies to `AGENTS.md`-following agents as much as to humans. If a task
asks you to write up a security finding, put the write-up in scratch space and
say where it is; do not add it to `devlog/`, `structure/`, or `docs-site/`.

## User-consent actions

Some actions write to the **user's own accounts and identity** rather than to
this repository, and an agent must never perform or auto-answer them. There is
currently no such product action.

If you add an action that spends the user's identity, credits, or reputation,
gate it in code rather than relying on a prompt an agent can answer. Detect
agent-driven callers with [`src/cli/agent-driven.ts`](./src/cli/agent-driven.ts)
and refuse the mutation from any management endpoint an agent can reach with a
readable token. Cover the gate with a focused regression test.

Do not reintroduce a GitHub identity mutation (starring this repository from
the CLI, the management API, or the dashboard). The repo-hygiene guard in
`tests/hardening-guards.test.ts` forbids that class of write in runtime code.

## Commands

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test           # full tests/ suite
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

During implementation, use the smallest focused checks that directly cover the
changed subsystem. Do not run repository-wide `bun run typecheck` or
`bun run test` for a scoped change unless the change affects shared runtime,
routing, config, server behavior, a focused result is failed or ambiguous, or
the user explicitly asks for full validation.

Before creating or updating a non-trivial PR as review-ready, or before
approving such a PR, run `bun run typecheck` and `bun run test`. CI runs these
on Linux, Windows, and macOS.

Do not rerun passing checks on unchanged code merely for additional confidence.

## Issues and pull requests (agents)

Agent-created issues and PRs must use the repository templates. The gates
below enforce them, so a freeform or mismatched submission is rejected rather
than nudged.

- **Creating an issue:** open it through the template chooser and use the
  matching form in `.github/ISSUE_TEMPLATE/` — `bug_report.yml` (Bug report),
  `feature_request.yml` (Feature proposal), `documentation.yml`
  (Documentation), or `provider_compatibility.yml` (Provider or API
  compatibility). Keep the form's section headings exactly as generated;
  `enforce-issue-quality` validates the headings and closes untemplated or
  mislabeled issues (`.github/ISSUE_TEMPLATE/config.yml` disables blank
  issues, so there is no freeform fallback).
- **Opening a pull request:** fill every section of
  `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist).
  `enforce-target` rejects empty, thin, or malformed descriptions, and a PR
  whose title or description mentions `gui` must include a screenshot of the
  UI change in the description. When the PR resolves an issue, add
  `Closes #<number>` to link it. GitHub auto-closes the linked issue only
  when the PR merges into the default branch (`main`); PRs here target
  `dev`, so close the issue manually once the change is on `dev`.

## Branch policy

- `dev` — the single integration branch and the target for every pull request.
- `main` — release branch. It only moves by maintainer-controlled promotion
  from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
- `preview` — prerelease train (`x.y.z-preview.*` versions).

Bun-native TypeScript on `dev` is the only runtime line. If native code
returns, the expectation is an incremental module (for example Rust via N-API)
landing on `dev`, not a second full-runtime branch.

Stacked child pull requests that target another **open** PR's head branch are
an intentional review workflow, not an alternate integration line. The
**`enforce-target`** check skips the wrong-base gate for those children; after
the parent lands or closes, retarget the child to `dev`.

Rebase pull requests are welcome. Bringing a stale branch onto the current head
is ordinary maintenance — open it as a normal pull request and name the source
commits in the description.

The **`enforce-target`** CI check rejects pull requests whose head
ancestry sits on the **`main`** tip while far behind **`dev`**, and rejects
empty, thin, or malformed descriptions; PRs whose title or description
mentions `gui` must include a screenshot of the UI change in the description.
Contributor PRs (authors without repository push permission) open in draft and
stay there until a four-box review-readiness checklist in the description is
complete: local CI green, branch on the latest `dev` commit, all correct Codex
and CodeRabbit findings fixed, and the ready-for-review confirmation. When all
four boxes are ticked the gate marks the PR ready and notifies the maintainers
listed in `MAINTAINERS.md` (excluding the author). Completion is bound to the
exact commit the PR head pointed at: if new commits are pushed afterwards, the
gate moves the PR back to draft, resets the checklist and the notification,
and asks the author to test and tick the boxes again against the latest code.
Before a completion is accepted, the gate verifies the checklist claims it
can check itself: the branch must be on the latest `dev` commit or at most
10 commits behind it, and Codex/CodeRabbit findings must be resolved. The
local-CI box is an author attestation only — fork contributors cannot start
repository CI; a maintainer has to — so the gate never disproves it; a new
push still resets every box. A disproved claim unticks the matching box and
keeps the PR a draft.
Authors with repository push permission skip the ancestry heuristic only. As with approval requirements in
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
