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
- `hub/` — optional hosted user/control plane and public portal for hubapi; it
  must remain absent from the local OpenCodex request path unless explicitly
  activated.
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

## Phase-one PRD-driven frontend secondary development

The phase-one product work in this checkout is an **incremental secondary
development of the public OpenCodex GitHub repository**, not a greenfield
rewrite. [`PRD.md`](./PRD.md) is the product and acceptance authority for this
work. This section adds project-specific implementation boundaries; all other
rules in this file and the nearest nested `AGENTS.md` continue to apply.

### Product brand boundary

- The user-facing product brand for this secondary-development line is
  **`hubapi`** (lowercase wordmark).
- Keep upstream implementation identities intact wherever compatibility depends
  on them: repository/package names, the `ocx` CLI, config paths, HTTP headers,
  storage keys, service identifiers, upstream documentation links, and protocol
  contracts remain OpenCodex unless a separately approved migration exists.
- Public marketing, hosted-portal copy, and GUI chrome must use `hubapi` and
  must not present the upstream project name as the visible product brand.
  Technical reference pages may retain an upstream name only where it is part
  of an actual command, package, path, endpoint, header, protocol contract, or
  source link; never rename those compatibility identifiers for appearance.

Apply three reasoning disciplines throughout the work:

- **Polanyi:** recover the operator's tacit workflow from surrounding code,
  tests, docs, and real UI states before changing the visible structure;
- **Occam:** choose the smallest compatible extension of the existing system,
  with no parallel abstraction when an established one is sufficient;
- **Cross-validation:** verify material product claims against at least source
  plus tests or shipped docs, and report unknowns instead of guessing.

### Authority and conflict resolution

Use this order when deciding what is true:

1. current source and tests on the latest inspected `upstream/dev`;
2. `structure/` invariants and the nearest `AGENTS.md`;
3. shipped user documentation in `docs-site/`;
4. `PRD.md` for phase-one product scope and acceptance;
5. generated mockups for visual intent only.

The PRD cannot make a nonexistent API, field, metric, or security guarantee
real. If the PRD and current code disagree, verify the current upstream state,
record the mismatch, and update or explicitly amend the PRD before
implementation. Never silently invent data or widen the backend to make a
mockup appear functional.

### Upstream baseline

Before the first implementation change and again before each milestone:

1. read `PRD.md` and the nearest scoped `AGENTS.md`;
2. fetch or otherwise inspect the current `upstream/dev` head;
3. record the exact upstream commit used for the work;
4. inspect local changes and branch divergence before rebasing or merging;
5. re-check affected routes, API shapes, tests, docs, and security invariants.

Do not replace the repository with a scaffold, copy another dashboard over it,
or build a parallel application. Preserve upstream history and keep changes
reviewable as an incremental diff. Never overwrite user changes while syncing
with upstream.

### Default writable scope

The original phase-one slice is a frontend and documentation program. The
separately approved hosted hubapi slice also permits work under `hub/` and its
focused tests, but does not silently widen the local runtime. The expected
writable scope is:

- `gui/src/` — application shell, pages, components, styles, data validation,
  routing compatibility, accessibility, and i18n;
- `gui/tests/` and directly relevant repository tests — focused regression
  coverage for changed behavior;
- `docs-site/src/` — Landing Page, public assets, styles, and user-facing docs;
- `PRD.md` and design documentation when verified scope or behavior changes.
- `hub/` — only for the optional public user, session, credit, recharge-code,
  admission, and portal implementation described below.

Reuse existing management APIs and existing GUI data-access patterns. A visual
or navigation change does not authorize changes to `src/`, config formats,
provider adapters, routing algorithms, authentication, OAuth, credential
storage, release automation, or GitHub workflows.

If a verified PRD requirement truly cannot be met with existing APIs, stop
before changing backend code and report:

- the exact requirement and user flow;
- the current API/source evidence;
- the smallest proposed contract change;
- security, privacy, compatibility, test, and documentation impact;
- a frontend-only fallback.

Backend work starts only after that expansion is explicitly approved. It must
then follow `src/AGENTS.md`, include focused tests, and preserve all core/Lab
boundaries.

### Explicitly forbidden shortcuts

- Do not copy New API or other AGPL frontend source, components, styles, text,
  or branded assets into this MIT repository.
- Do not implement the mockup-only API-key expiry, pause/resume, model ACL,
  RPM/TPM, source IP, domain, Origin, or management-permission controls unless
  a separately approved backend contract exists.
- Do not add organizations, team RBAC, wallets, payment processors, orders,
  subscriptions, invoices, or autonomous commercial actions. The approved
  hosted slice is limited to users, sessions, public API credentials, an
  integer credit ledger, and recharge codes under the isolation rules below.
- Do not edit `gui/dist` or any generated build output by hand.
- Do not introduce a second router, state framework, CSS framework, analytics
  SDK, remote font, or runtime dependency merely to reproduce a mockup.
- Do not add telemetry or external network calls from the Landing Page or GUI.
- Do not display or log prompts, response bodies, full API keys, reusable admin
  tokens, emails, or account identifiers.
- Do not weaken same-origin GUI sessions, CSRF evidence, management/data-plane
  credential separation, CORS, `X-Frame-Options`, or CSP.
- Do not import optional Lab modules into the core request path.
- Do not remove legacy hash redirects or change Back/Forward behavior without
  a documented migration and regression coverage.

### Design and content truth

Generated images are non-authoritative examples. Their dates, request counts,
model names, prices, latency, success rates, quotas, and statuses are sample
content. Every implemented value must come from a verified current endpoint or
render as an honest `N/A`, unknown, unavailable, partial-coverage, or stale
state.

Keep these distinctions visible:

- configured route preview vs. durable historical route evidence;
- measured/reported usage vs. estimated/unsupported usage;
- list-price equivalent estimate vs. a bill or charge;
- success vs. degraded success with recovery work remaining;
- empty data vs. data that failed to load;
- live data vs. cached or stale data.

Use the repository's established Chinese term `提供方`; mockups that say
`供应商` do not override shipped terminology. User-facing strings must follow
the GUI i18n rules and be added to every existing locale.

### Architecture constraints

- Keep the existing React + TypeScript + Vite + Bun GUI.
- Keep the Astro + Starlight documentation site and its existing localization
  model.
- Preserve Hash routing and all compatibility redirects listed in `PRD.md`.
- Promote or regroup navigation by reusing existing pages and components; do
  not create parallel state or duplicate API-key, Codex Auth, model, or
  integration implementations.
- Keep the public Landing Page separate from the local management surface. It
  must not call `/api/*`, infer local status, or expose a management credential.
- Preserve independent resource loading: one slow catalog or provider must not
  block unrelated key, log, or endpoint management.
- Use the existing component, token, cache, bounded-fetch, and validation
  patterns before adding abstractions.
- Default to zero new dependencies. Any dependency change requires an explicit
  need, alternatives analysis, lockfile review, and security review.

### Implementation sequence

For each PRD milestone or page:

1. name the PRD requirement and acceptance criteria being implemented;
2. inspect the current page, API handler, response types, tests, docs, and
   nearby reusable components;
3. write a small implementation plan with affected files and data contracts;
4. implement the smallest coherent vertical slice;
5. add or update focused tests for behavior, routing, data validation, and
   accessibility where applicable;
6. run proportional checks before moving to the next slice;
7. inspect the page in a real browser at the required responsive sizes and in
   light/dark themes;
8. update user documentation when behavior or navigation changes;
9. report exactly what was verified and what remains unverified.

Do not claim a whole page or milestone complete because static layout renders.
Completion requires real API-backed states, loading/empty/error/stale states,
keyboard behavior, responsive behavior, i18n, tests, build, and visual
inspection as specified by `PRD.md`.

### Phase-one validation gates

For GUI milestone completion:

```bash
cd gui
bun test tests
bun run lint
bun run lint:i18n
bun run build
```

For Landing Page or public documentation changes:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

If approved work changes `src/`, shared behavior, dependencies, auth, routing,
or config, also run the repository-level gates required by the relevant scoped
instructions, including `bun run typecheck`, `bun run test`, and
`bun run privacy:scan` where applicable.

Before calling phase one complete, satisfy every item in the PRD Definition of
Done. A PR that changes the GUI must include real screenshots, target `dev`,
and follow the repository PR template and review policy.

## Optional hubapi hosted control plane

The hosted hubapi capability is an **optional public admission and accounting
edge**, not a replacement provider router. OpenCodex remains the only component
that selects providers, adapts protocols, and sends provider requests. Public
user traffic reaches the edge first; the edge authenticates and accounts for
the request, replaces the public credential with an internal admission secret,
then streams the request to a private OpenCodex listener.

This boundary is required because the existing GUI and `/api/*` management
routes are a local operator surface. A public user credential, session, or
recharge code must never authenticate to or be forwarded into that surface.

### Activation and isolation

- Hosted mode is off by default. Ordinary `ocx start` must import no `hub/`
  module, open no hub database, start no hub timer, and bind no hub listener.
- Start the public edge through an explicit hub command/configuration. It must
  use a different listener and route namespace from the private management UI.
- `src/router.ts`, `src/server/lifecycle.ts`, and
  `src/server/responses/core.ts` must not import `hub/`, directly or
  transitively. The public edge calls the existing data-plane HTTP contract;
  it does not register a second routing engine inside core.
- Hosted startup fails closed when its internal admission secret, public
  origin, database path, proxy target, or production bind configuration is
  missing or unsafe. Placeholder/default secrets are forbidden.
- Single-node SQLite is permitted for the first hosted slice only. The process
  must take an exclusive instance lock and document that multiple replicas are
  unsupported until a transactional PostgreSQL adapter exists.

### Authentication and secret handling

- There is no default administrator or known bootstrap password. Create the
  first admin only through a one-time, local-only bootstrap command/token and
  invalidate the bootstrap capability after use.
- Hash passwords with `Bun.password` Argon2id. Never offer plaintext or
  reversible password modes.
- Browser authentication uses opaque server-side sessions in `Secure`,
  `HttpOnly`, `SameSite` cookies. Rotate on login and privilege change; store
  only a session digest; enforce expiry, revocation, Origin checks, and CSRF on
  state-changing requests.
- Public API keys and recharge codes use CSPRNG material, are revealed once,
  and are stored as an HMAC digest with a non-secret prefix/suffix for lookup
  and display. Never store or return their full plaintext after creation.
- Secrets, session IDs, full API keys, recharge codes, emails, prompts,
  response bodies, and reusable account identifiers must not appear in URLs,
  browser storage, ordinary logs, analytics, error bodies, or cache keys.

### Ledger and authorization

- Credits are integers in a documented smallest unit; floating-point balances
  are forbidden.
- The ledger is append-only. Recharge, reservation, settlement, refund, and
  administrative adjustment each require an immutable reason and unique
  idempotency key. Balance is derived or transactionally maintained from ledger
  entries; it is never changed by an unrecorded update.
- Recharge redemption and request charging must be atomic under concurrency.
  A code redeems once, and a request settles once even after retries.
- Every user resource is authorized by the authenticated subject on the
  server. An object ID, request ID, or URL is never treated as authorization.
- Admin actions require a distinct admin role, recent authentication for
  sensitive actions, an audit event, and rate limits. Public user roles never
  gain access to OpenCodex management routes.

### SimpleCard secondary-development boundary

`runtimepoet/simplecard` may be used as an MIT-licensed domain reference only.
Do not vendor its Next.js/Spring Boot runtime or dependency graph. Reimplement
the approved concepts in Bun/TypeScript and the existing React/Vite design
system. If any substantial source fragment is copied, retain the required MIT
notice and record the exact file/commit provenance.

Detailed security findings belong only in ignored scratch space under `.tmp/`
until fixed or publicly disclosed. Tracked documents may state generic security
requirements and the integration decision, but must not publish an unfixed
exploit path or pre-disclosure reasoning.

### Hosted-slice validation gates

Every authentication, authorization, credential, ledger, or admission change
requires focused regression tests plus:

```bash
bun run typecheck
bun run test
bun run privacy:scan
bun run audit:high
```

Also test session fixation, CSRF/origin rejection, brute-force throttling,
cross-user object access, one-time secret reveal, concurrent recharge, request
idempotency, insufficient credit, log redaction, private-management isolation,
stream cancellation, and local-mode zero activation. Payment, wallet signing,
external publication, and any action spending the user's identity, credits, or
reputation remain human-approved and outside this slice.

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
