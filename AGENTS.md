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

## Optional subsystems stay off the core path

`src/lab/` (Compatibility Lab) is opt-in. A user who configures one provider and
one model — no routing profile, no Lab — must execute no Lab code and start no
Lab timer.

Three files carry every such user's request path and must not reach `src/lab/`,
directly or transitively:

- `src/router.ts`
- `src/server/lifecycle.ts`
- `src/server/responses/core.ts`

`tests/core-lab-boundary.test.ts` enforces this by walking the runtime import
graph and printing the offending chain on failure. It is not a style rule: the
original violation hid in a six-hop chain
(`assemble → quota → auth-api → native-main-admission → lifecycle → lab`) where
no single file looked wrong, and it pulled ~69 Lab modules into every install.

An optional subsystem registers into a core-owned slot at activation instead of
being imported. The existing seams are `src/server/passive-route-linker.ts`,
`src/routing/compatibility/provider-slot.ts`, and
`src/lib/optional-shutdown-hooks.ts`.

`src/server/index.ts` is deliberately exempt: a composition root is supposed to
know which optional subsystems exist. Its obligation is the gate, not the import
— activation must stay behind `labActivationRequired`, and it must stay
synchronous. Everything between `Bun.serve` and the return of `startServer` runs
in one synchronous turn, which is what guarantees a policy route can never be
evaluated before its evidence provider is registered. The synchronous
subagent-fallback chain has nowhere to await, so an `await` added before the
activation block would silently reroute subagents to a different model than the
operator configured.

That one is enforced too, in the same file: a scan reads the window between the
`Bun.serve` call and the `labActivationRequired` check and fails on any `await`
that would suspend `startServer` itself, plus on `startServer` being declared
`async`. It has to ignore comments, string bodies, and nested functions to be
usable, because the window legitimately contains three awaits inside the
`server.stop` closure and two comments that mention the word. Until it existed,
this paragraph was the only thing holding the guarantee.

Design and audit history: `devlog/_fin/260814_lab_core_decoupling/`.

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
this repository, and an agent must never perform or auto-answer them. The one
that exists today is starring the repository on GitHub, which only comes up when
an agent is *running* opencodex — not when it is working on this codebase.

The rule lives in [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md), which is the file
an installing or operating agent reads. It was moved out of here because a
development-facing file is the wrong place to trigger on it: this file is loaded
for every code change, and the consent boundary applies to none of them.

What matters for development work: the enforcement is code, not prose —
[`src/cli/agent-driven.ts`](./src/cli/agent-driven.ts),
[`src/cli/star-prompt.ts`](./src/cli/star-prompt.ts), and
[`src/server/management/sidebar-routes.ts`](./src/server/management/sidebar-routes.ts),
covered by `tests/startup-prompt.test.ts`, `tests/agent-driven.test.ts`, and
`tests/sidebar-routes.test.ts`. If you add another action that spends the user's
identity, credits, or reputation, gate it the same way rather than relying on a
prompt an agent can answer, and document it in `AGENTS_INSTALL.md`.

**Be clear about what that enforcement is and is not.** The management endpoint
requires a dashboard session, which stops the casual path — an agent that would
have POSTed there because the endpoint existed, and one holding only the admin
token. It is not a technical barrier against a determined local agent: a process
running as the user can mint its own session from the loopback dashboard
bootstrap, and can skip the proxy entirely by running `gh` itself. Every local
credential is equally reachable by both the browser and the agent, so no check
inside this process can tell them apart. The real boundary is the rule above, and
it binds you regardless of which mechanism is within reach.

## Commands

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test:changed   # import-graph tests against the resolved `dev` merge base
bun run test           # full tests/ suite (PR-ready / explicit ask only)
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

`skills/ocx/` is the operating reference for the CLI — what an agent reads to *drive* a running
proxy, as opposed to [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md) (installing and operating consent)
or this file (changing the codebase). Its surface map is generated:

```bash
bun run skill:surface        # regenerate after adding a capability
bun run skill:surface:check  # what CI asserts
```

`tests/skill-ocx.test.ts` fails if the committed map drifts from `src/cli/capabilities.ts`, and
also if the hand-written pages name a command the registry does not have. That second check is not
hypothetical: it caught a documented `ocx request-history` that never existed.

During implementation, use the smallest focused checks that directly cover the
changed subsystem. Prefer `bun test tests/<name>.test.ts` for a known file, or
`bun run test:changed` when the touch set is broader than one file. Do **not**
run repository-wide `bun run test` or a bare `bun test` with no file arguments
for a scoped change by default. `bun run test:changed` follows Bun's parsed module graph: it
selects test files that import changed modules, but it cannot see dependencies
expressed through subprocesses, source files read as data, or golden/derived
files. Run the relevant focused tests explicitly for those paths; if no reliable
focused set covers them, the full suite is required even for a scoped change.
That indirect-dependency case is the explicit exception to the scoped-change
default. The full suite is ~850 files, so otherwise reserve it for a failed or
ambiguous focused result, an explicit user request, or the PR-ready gate below.

Before creating or updating a non-trivial PR as review-ready, or before
approving such a PR, run `bun run typecheck` and `bun run test`. CI runs these
on Linux, Windows, and macOS.

Do not rerun passing checks on unchanged code merely for additional confidence.

## Minimal containers and agent sandboxes

Fresh dev containers and agent sandboxes (Cursor Cloud, devcontainers, CI
images) often ship Node but not Bun. Install it first:

```bash
curl -fsSL https://bun.sh/install | bash   # installs ~/.bun/bin/bun
export PATH="$HOME/.bun/bin:$PATH"
bun install && (cd gui && bun install)
```

Run the proxy with `bun run src/cli/index.ts start --port <port>`. `/healthz`
reports status, `/` serves the dashboard, and the management API requires the
admin token the server writes to `$OPENCODEX_HOME/admin-api-token` at startup.

`bun run test` has five known environment-only failures in such containers.
They are not regressions; do not re-investigate them:

- `service diagnostics > status summary exposes the service log path`,
  `CLI subcommand help > status prints diagnostics without starting the proxy`,
  and `CLI subcommand help > invalid service and codex-shim usage include
  remove alias` require a running systemd init; in a container PID 1 is
  typically `tini` or another minimal init, so service commands report
  "systemd not found".
- `package tree integrity > an in-place rewrite of the same byte length is
  still a replacement` and `Codex Log Guard inspection > repeat inspection is
  memoized and invalidated by a write` rely on filesystem mtime granularity
  that some container filesystems do not provide.

Everything else passes (15480 pass / 16 skip / 5 fail as of 2.35.0).

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
- **Landing another author's work:** reimplementing, superseding, carrying, or
  rebasing someone else's pull request requires a `Co-authored-by` trailer
  naming that author, in the description or in a branch commit so it survives
  the squash. Saying it in prose is not equivalent — the trailer is what GitHub
  reads for the contributor graph, and a sentence in a commit body is read by
  nothing. This repository did it both ways for months: `53c09a247` says "Clean
  reimplementation of #3193" and names the author in a trailer, `5734a1caf` says
  "Reimplements #2797 by @rrmlima" and names nobody, so that contribution is
  invisible on its author's profile. The 27 landings already in that state are
  recorded in [`CREDITS.md`](./CREDITS.md); `missing_coauthor_credit` in
  `.github/scripts/pr-carry-attribution.cjs` is why the list should not grow.

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
[`MAINTAINERS.md`](./MAINTAINERS.md), the ancestry heuristic is a CI check
rather than a branch rule. The branches themselves are protected: `dev`,
`main`, and `preview` each carry an active ruleset requiring a reviewed pull
request and blocking force-pushes and deletion, so a direct push to `dev` is
rejected regardless of `--no-verify`.

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
  the existing tests for that subsystem. During implementation, run the relevant
  focused files and use `bun run test:changed` for import-connected coverage as
  described above; the full suite is the PR-ready gate.
- **Docs sync:** user-facing behavior changes should update `docs-site/` (and
  keep translated locales from contradicting the English source).
- **Privacy:** `bun run privacy:scan` must stay green; never introduce logging
  of request bodies, API keys, or account identifiers.
