# Docs And Release

Automatic package-tree restart holds a releasable data-plane drain until its scheduled
service-home check succeeds. A veto releases that fence; a committed shutdown uses the
permanent drain latch.

macOS shards and control use the shared fresh-process batch runner described below.
`scripts/ci/sample-macos-stall.sh` remains a standalone diagnostic helper with isolated
observer regression coverage; it is not wired into those bounded batch steps. It samples
only a single identified direct Bun child after silence and cleans up only its own
diagnostic children. Process inventories emit executable basenames; command stdout/stderr
and stack reports redact literal home/workspace prefixes before capped emission. The
catalog picker fixture retains CI-only phase boundaries.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Catalog HTTP acquisition follows the [proxy-routing contract](../catalog.md#remote-catalog-http-proxy-routing).

Refresh-lock validation covers fresh unreadable locks, descriptor-matched release, path-probe failures preserving callback outcomes, and confirmed-owner unlink error handling in `tests/codex-integration/codex-account-store.test.ts`; the [catalog contract](../catalog.md#accounts-namespaces-and-pool-rotation) explicitly does not promise atomic compare-and-delete. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction.

The CLI documents explicit Windows x64 installation observation separately from updates; observation never grants installation authority. See the [read-only observation contract](../runtime.md#explicit-codex-cli-installation-observation).

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages) is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](../runtime.md#lifecycle).

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts.

Human-readable connect and sync-refresh diagnostics follow the [terminal rendering contract](../runtime.md#cli-readiness-diagnostics), with regression coverage for both paths in `tests/cli/cli-connect-readiness.test.ts`.

`tests/cli/cli-config-show-client.test.ts` covers the separate read-only config annotation path:
`src/cli/config-command.ts` derives token ownership without importing the connect command or
triggering catalog, lifecycle, or ACL-hardening work.

The CLI default dashboard address follows the [management ingress bind](../runtime.md#hub-management-dashboard-address), covered by `tests/cli/cli-dispatch.test.ts`.

Native main reauthentication follows the [CLI JSON output contract](../runtime.md#native-main-reauth-json-output).

The Codex restart command follows the [CLI restart scope contract](../runtime.md#cli-codex-restart-scope).

The account reference documents the [Orca source-owned import](../codex-home.md#orca-source-owned-account-import).
Its local-only command is declared in `src/cli/capabilities.ts`, and the generated skill surface
lists its required source/registry paths and preview/apply flags.

Local validation follows [the contributor test policy](../../AGENTS.md#commands): run the
suite by default, with a documented resource exception requiring focused regression tests.
`scripts/setup-hooks.ts` retires only an exact match for the old managed pre-push and
post-merge shims; custom hooks are preserved. Required current-head CI and
security review remain merge requirements.

The gate preserves legacy checklist bodies and asks the author to update the first item,
clear all four boxes and save, then wait for the bot to record that checkpoint before
validating the displayed head and ticking all four boxes again. Wording-only edits do not
re-attest. The existing bot-comment state stores a versioned pending phase, real head/base,
generation, the phase publication's server timestamp and, only after rechecking, a body digest. Invalid stored state restarts the
clearing phase; a different live head/base invalidates the checkpoint. Only an author body
edit whose live snapshot agrees and whose server timestamp is later than the stored phase checkpoint
can advance it. A new phase is first persisted without a timestamp and then finalized with
the first write's server time; unfinished finalization cannot advance readiness. Hygiene
updates to the outer comment do not move this fence. Equal-second saves require a later
body edit. While re-attestation is pending, the quality check fails explicitly and defers
ordinary quality evaluation; it does not report a green gate. Before ready, the gate re-reads the PR and persisted attestation. These reads do
not make GitHub's later ready mutation atomic with concurrent edits or pushes.

## Public docs

The provider configuration reference and provider guide own the public Google tool-schema policy:
the persisted values/default, initial refusal, non-direct repair withholding, direct no-repair
behavior, and content-free diagnostics. English and all translated copies change together.

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, with French under `/fr`, Korean under `/ko`, Simplified Chinese under `/zh-cn`, Traditional Chinese under `/zh-tw`, Russian under `/ru`, Japanese under `/ja`, and Turkish under `/tr`. `docs-site/astro.config.mjs` is the locale source of truth.

Internal links are checked in two places. `docs-site/src/integrations/internal-links.mjs` runs inside the
Astro build, so the CI `docs` job and Deploy Docs both refuse a site whose generated HTML carries an
internal href or src naming a file the build did not produce, or a fragment the target page lacks. It sees
only generated HTML: client-rendered links and other hosts are outside it. `tests/ci-workflows/docs-link-targets.test.ts`
checks the docs URLs hard-coded in README files, `src/`, `gui/src/`, `skills/` and issue templates against the
content tree, without fragments, and only on pull requests that start the Bun suite.

Server-configuration credential rows in English and every locale copy distinguish data-plane `apiKeys` from the independent management admin credential and link the matching locale management reference. Credential setup instructions themselves stay in the management reference; the rows only name the separation.

Proxy-format, adapter, and provider documentation distinguishes server-level SOCKS5 configured outbound fetch from scheme-specific HTTP(S) routing, and every locale copy carrying that claim stays aligned. The public pages own the runtime detail rather than duplicating it here.

Manual navigation is defined in `docs-site/astro.config.mjs`. When adding a public page, update the
sidebar and either add localized copies or intentionally accept Starlight fallback behavior.

Provider preset totals are recounted from the current registry when a preset lands. The
documented split is 99 total: 82 key-based, 13 OAuth, three local, and one default
ChatGPT-forward preset. The English provider guide, all seven translated copies, and all eight
quickstarts carry the same counts.

That recount is no longer a manual obligation. Seventeen places restate these numbers and sixteen
of them drifted once already — the English guide reached 95 while every translation and every
quickstart, the English one included, still said 94. Both numbers read as plausible, so nothing
caught it. `tests/ci-workflows/docs-provider-preset-counts.test.ts` now derives the total and the
key-based split from `PROVIDER_REGISTRY` and asserts them against each page, so the next preset
fails every locale at once instead of drifting. Each page is located by a locale-specific phrase
rather than by its number, so rewording a sentence fails the check and asks to be re-anchored.

The fixed-host discovery limits are the same shape one layer down, and this document used to
assert their parity in prose: it claimed the guides carried the same limits, across sixteen-plus
files, verified by nobody. That claim was false when it was written — the Korean guide had no
Featherless section at all, so it documented twelve of the thirteen limited presets.
`tests/ci-workflows/docs-provider-discovery-limits.test.ts` replaces the claim with the check:
each section's byte and row ceilings are read from that preset's `modelDiscovery` and asserted
against every shipped guide, and a grouped section must first agree in the registry before one
sentence may describe both presets. Sections are located by brand name and the presence of a
`KiB`/`MiB` token rather than by a translated phrase, because a restated anchor is the same
hand-copied value the guard exists to remove; a section that is missing or duplicated fails by
name. The byte ceiling is compared as an exact token set, so a stale number left beside the
current one fails instead of passing on a substring.

Native retirement keeps active model/quota instructions aligned across locales with the
[catalog contract](../catalog.md#shared-catalog). Historical records and other providers
sharing a model-name fragment remain distinct from current Codex-native support.

The Remote Hub guide distinguishes selected-runtime readiness from general runtime diagnostics;
`tests/cli/cli-connect-readiness.test.ts` exercises that boundary and general status's single discovery pass with isolated executable fixtures.

The provider guide's OrcaRouter login section in English and all seven translated sources follows
the [bounded ingestion contract](../transports/inventory.md#bounded-response-ingestion-and-orcarouter-login):
64 KiB of valid UTF-8 JSON and one 30-second deadline covering headers and body. These are login
limits, so the public guide does not apply them to inference payloads.

## GitHub Pages

`.github/workflows/deploy-docs.yml` publishes the docs to:

```text
https://opencodex.me/
```

The workflow runs on `main` pushes touching `docs-site/**` or the workflow itself, builds
`docs-site`, uploads the artifact, and deploys with GitHub Pages.

That workflow is the deploy path, not a review gate: it first runs after promotion to `main`,
so on its own it can only report a broken site once the change has already left review. The
pull-request gate is the `docs-site-build` job in `.github/workflows/ci.yml`, selected by the
`changes` job's `docs` filter (`docs-site/**` and the workflow itself). One Linux leg installs
`docs-site` with `--frozen-lockfile` and runs the Astro build, so a manifest and lockfile that
disagree fail before the build does. The `ci` aggregate treats it exactly like the other scoped
jobs: requested when the filter is true, required `skipped` otherwise.

The deliberate omission is that `docs-site/**` is not in the `ci` filter. A prose edit has no
business starting the cross-platform suite; it only has to build.

> Decision record: [ADR-0080](../decisions/ADR-0080-github-pages.md)

Local validation:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## Container deployment recipe

The repository ships a root multi-stage `Dockerfile`, `compose.yaml`, narrow `.dockerignore`, and
container bootstrap helper, but still publishes no registry image. The source build pins the Bun
base by multi-platform digest, runs non-root with a read-only root filesystem and dropped
capabilities, publishes the data port on host loopback by default (remote binding is an explicit
`OPENCODEX_BIND_ADDRESS` opt-in), persists `OPENCODEX_HOME`, and streams the initial data token through stdin into the
owner-only canonical token file. A build-only manifest stage uses Git metadata from a read-only
context mount to run `scripts/generate-compatibility-version.ts`; remote Git contexts retain that
metadata through `BUILDKIT_CONTEXT_KEEP_GIT_DIR=1`. A verified host-generated artifact remains a
compatible input. No `COPY` includes `.git`, and the Git executable does not reach the runtime stage.
`docker/verify-compatibility.ts` compares all file hashes and the complete source inventory in the
read-only build context before source copy and again in the copied runtime tree. It rejects symlinks,
missing/mismatched entries, and extra source files.
The required roots are `package.json`, `bun.lock`, and `scripts/model-metadata.source.json`;
the context also admits the canonical generator, while the runtime includes only the metadata source.
Operators must still prove liveness, readiness, authenticated
catalog access, and a real routed response before promotion.

An official image would create a larger release surface requiring maintained base-image digest
updates, vulnerability scanning, SBOM, signing, registry provenance, rollback, and support policy.
Those controls still have no owner, so there is no image-publish workflow or official registry tag.

> Decision record: [ADR-0081](../decisions/ADR-0081-container-deployment-recipe.md)

## Windows service wrapper and incomplete updates

> Decision record: [ADR-0082](../decisions/ADR-0082-windows-service-wrapper-and-incomplete-updates.md)

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Any `pull_request`; runtime/package `push` to `main`/`preview`; manual dispatch | A pull request verifies Linux and TypeScript: Linux runs four suite shards plus `gates` alongside the scoped docs, structure, packaging, keyring, and npm-global jobs. The `platform-macos` macOS suite, the `widget` macOS widget + Tauri app-bundle build, and the `desktop-shell` Rust toolchain build are native-gated: they run on `main`/`preview` pushes and manual dispatch, and on a pull request only when the `changes` job's native path filter selects the change. `dev` pushes start nothing; dev integration is covered by the pull-request run, while `main` and `preview` must stay push triggers because `release.yml` requires a push-event run for the exact release SHA. Windows runs nine shards only on manual dispatch with `lane=all` (or empty), not on push events. Linux runs at-most-12-file processes with a 120-second process bound; Windows uses measured six-file/480-second processes and all-file scope so its full-suite contract is unchanged. The dedicated Windows batch step sets `OCX_TEST_NO_QUEUE=1` because its sequential processes are one logical runner; each process still creates an isolated home and arms the test guards before the lock boundary. No lane retries: a test failure, a process timeout and a Bun runtime crash each fail their job on the first occurrence. Aggregate `ci` is event-aware — it derives which jobs this event requested and requires `success` from each of them and `skipped` from the rest, and on a `lane=all` dispatch it reads the run's own job list and requires nine concrete successful `windows N/9` results. `npm-global-smoke` remains GitHub-hosted because it mutates the global package prefix. Manual `lane=release-gates` keeps the ordinary native-gated jobs and selected dynamic keyring/packaging matrix legs, but skips the Windows suite and unsharded macOS control. Default `all` (or empty) still requests both diagnostics; `macos-control` requests the control without Windows suite shards. Release eligibility requires successful push-event CI on the exact release SHA; a manual lane does not authorize publishing. Changes that touch only `.github/actions/` or `native/remote-workspace-helper/` run the narrow `setup-action` and `remote-helper` jobs instead of the full matrix, and Linux shard membership follows the per-file durations in `scripts/ci/test-durations.tsv`. |
| `.github/workflows/dev-version-bump.yml` | Manual dispatch with an intended version and `pre-move` or `repair` mode | Opens the reviewed pull request that moves `dev` past a release target. The default `pre-move` mode runs before promotion and publication; explicit `repair` mode retains the post-publish catch-up path. It is neither called by `release.yml` nor triggered by publication. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow. The `preflight` job checks channel, version sources, tag, GitHub release, npm, global tag ordering and the `dev` pre-move before any packaging job starts. The publish job repeats those checks, requires a successful push-event Cross-platform CI run for the exact `GITHUB_SHA` (a pull-request run does not qualify), requires `dev` to outrank the target, then checks the target against the freshly fetched global tag set before publish or dry-run. After a real publish, `release-outcomes` reports the public GitHub release, the npm version read-back and the npm dist-tag as separate rows. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Astro/Starlight docs site to GitHub Pages. This is the deploy path; the pull-request build gate is the `docs-site-build` job in `ci.yml`. |
| `.github/workflows/service-lifecycle.yml` | `pull_request` to `main`/`dev` and `push` to `main`/`preview`, both filtered on the service path set (`src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`, the workflow), or manual dispatch | Service-lifecycle smoke on three platforms: Linux systemd, macOS launchd, and Windows Scheduled Tasks. Each installs, verifies, stops via `ocx stop`, and uninstalls. The path list is kept in sync with the `release.yml` service-gate regex. |
| `.github/workflows/enforce-pr-target.yml` | `pull_request_target` (opened, reopened, edited, labeled, unlabeled, ready_for_review, synchronize) plus default-branch `status` events filtered to successful `CodeRabbit` statuses | The `enforce-target` gate: rejects pull requests whose head ancestry sits on the `main` tip while far behind `dev`, rejects empty or malformed descriptions, requires a GUI screenshot when the title/body mentions `gui` (immediately waivable with the maintainer-controlled `gui-screenshot-waived` label; legacy maintainer comments remain compatibility evidence on later PR events), keeps contributor PRs in draft until a four-box readiness checklist is complete, verifies the CI / latest-dev / Codex+CodeRabbit-findings claims (review threads plus current-head CodeRabbit review-body findings outside the diff range), and adds a `review-ready` status label at the ready moment. CodeRabbit status SHAs must resolve to exactly one open current-head PR before writes. Stacked child PRs targeting another open PR's head skip the wrong-base gate. |
| `.github/workflows/enforce-issue-quality.yml` | `issues` (opened, edited, reopened), `issue_comment` (created, edited), or manual dispatch with an issue number | Issue-template compliance gate. |
| `.github/workflows/issue-quality-tests.yml` | `pull_request` and `push` to `main`/`preview` filtered on the issue/PR automation scripts, templates, and their workflows | Tests the issue and PR automation scripts themselves, so the gates cannot rot silently. |
| `.github/workflows/issue-triage.yml` | `issues` (opened) | Duplicate detection and triage labeling for new issues. |
| `.github/workflows/pr-labeler.yml` | `pull_request_target` (opened, edited, synchronize, labeled, unlabeled) | Type and path labeling plus title sync; `labeled`/`unlabeled` let a human override enqueue a fresher run in the per-PR concurrency group. |
| `.github/workflows/react-doctor.yml` | `pull_request` (opened, synchronize, reopened, ready_for_review) and `push` to `main`; no path filter | React-focused static review. Findings fail the job; write-scoped outputs stay disabled, a contract pinned by `tests/ci-workflows/ci-workflows.test.ts`. |
| `.github/workflows/stale-needs-info.yml` | `schedule` only (daily 06:15 UTC); deliberately no manual dispatch | Closes issues left in needs-info past the grace period. Manual dispatch is omitted so a branch-selected run cannot execute that branch's body with issue write scope. |

`pull_request_target`, `issues`, and `schedule` workflows always load from the repository default
branch, not from `dev`. Landing a change to one of them on `dev` does not change live behavior until
it is promoted, so those files follow the promotion model rather than ordinary integration.

`scripts/test.ts` owns `SERIAL_FULL_SUITE_FILES`, the shared process-isolation roster. Local
full-suite runs, both macOS paths, and `scripts/ci/run-bun-test-batches.sh` execute those files
alone with fresh process homes. Hosted batches assign shard membership by the per-file durations
in `scripts/ci/test-durations.tsv` (sorted round-robin when nothing is recorded), run each shard's
files in sorted order and split only process boundaries; every selected file still runs once.
Ordinary macOS shards select 1/2 and 2/2 from the full file list; macOS control selects 1/1. Both
execute sequential batches of at most 12 files with one worker.
Storage-policy and API-usage families run as singletons, as do manifest-declared files.
This preserves full test membership but does not claim cross-batch shared-process coverage.
Every primary assertion failure, timeout or crash fails the run; diagnostic singleton
attribution never turns a failed primary green. Each control batch has a 300-second process
bound plus 15 seconds for forced reap, inside unchanged 20-minute shard and 75-minute control job caps. Other batch
lanes keep their existing defaults; optional parallelism must be a positive integer.

The Windows selector is an operational stability control, not a security boundary. A pull request
controls the `pull_request` workflow body and can rewrite an event-name check, repository variable,
or selector output. Because this is a public user-owned repository and runner groups are unavailable,
the repository setting **Fork pull request workflows from outside collaborators: Require approval
for all outside collaborators** (`all_external_contributors`) must remain enabled before any self-
hosted runner is registered. Maintainers must inspect workflow changes before approving an external
run. If that setting cannot be verified, unset `OCX_SELF_HOSTED_WINDOWS` and deregister the runner;
the workflow then fails back to `windows-latest` rather than exposing a persistent maintainer host.

Docs-only changes intentionally route through the docs workflow instead of the runtime CI gate. If a
docs change also edits runtime/package/release files, run the relevant local runtime checks before
push and let `ci.yml` provide the Linux/Windows confirmation. Service-related changes
(`src/service.ts`, `src/cli/index.ts`, and the rest of the service path set) additionally trigger the
`service-lifecycle.yml` smoke test on all three platforms.

## Root README

The root READMEs are the concise product entrypoint. They should explain what opencodex does, how to
install/start it, where Codex state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Historical docs

The root `docs/` folder is retired and declared in `absentPaths`, so the structure gate fails if a
file there is tracked again. Its notes remain readable in git history before the retirement commit.
Investigations and plans go to `devlog/`; the GUI design-system contract lives in `gui/design-system/`.
When an investigation graduates into a maintained invariant, summarize it here under `structure/`
and link public workflows from `docs-site/`.

Pull-request screenshot evidence stays out of the `dev` tree by rule. Authors attach images through
the description editor or commit them to the orphan `pr-assets` branch and link them by commit SHA;
a "Protect pr-assets" ruleset blocks deletion and force-push there so pinned links stay valid. No
workflow's `push` trigger matches that branch. `tests/ci-workflows/repo-hygiene.test.ts` enforces
only the retired paths: `docs/`, the three old evidence folders and five loose `assets/` images. An
image committed anywhere else is caught by review, not by a gate.

Cross-cutting structure contracts are maintained by editing `structure/manifest.json`, the authority
statement, and any dependent whose local explanation changes. Regenerate `structure/INDEX.md` with
the owning command and require the structure check in hosted CI. The
[structure rules](../AGENTS.md#the-source-to-doc-map) retain review of every document mapped to a
changed source area even when no text edit is needed.

## Branch and devlog policy

[`AGENTS.md`](../../AGENTS.md) and [`MAINTAINERS.md`](../../MAINTAINERS.md) are authoritative; this section
exists so the repository-shape source of truth does not omit the shape of its own history.

- `dev` is the single integration branch and the target for ordinary pull requests. `main` moves only
  by maintainer-controlled promotion; `preview` carries the `x.y.z-preview.*` train. One documented
  exception: a stacked child PR may target another **open** PR's head branch as a review workflow, and
  is retargeted to `dev` once the parent lands or closes.
- Bun-native TypeScript on `dev` is the only runtime line. The former Go native-runtime experiment is
  retired and archived, and no `go/` tree is tracked in this repository; a local `go/` directory is
  untracked leftovers. If native code returns, the expectation is an incremental module landing on
  `dev`, not a second full-runtime branch.
- `devlog/` is a tracked directory in this repository — no submodule, no private mirror. Open units
  live in `devlog/_plan/`, closed units in `devlog/_fin/`, and external parity references in
  `devlog/_chase/` (the reference clones themselves are gitignored).
- The runtime does not consume `devlog/`, so a contributor who ignores it still builds and runs.
  Repository checks do read it deliberately: `privacy:scan` scans it, and
  `tests/ci-workflows/repo-hygiene.test.ts` enforces the mechanical guards — no tracked `160000` gitlink anywhere,
  devlog Markdown tracked as ordinary blobs, no `.gitmodules`, and no open plan carrying an unresolved
  security verdict on a security-boundary topic. Some unit-scoped release gate scripts resolve their
  evidence directory from `devlog/_plan` or `_fin` as well.
- Security work in progress does not go in any tracked directory. Scratch space only; only the
  published outcome — the fix, its regression test, the release note, the advisory once public —
  reaches the repository.

## Maintenance governance

`MAINTAINERS.md` is the source of truth for current project roles and the review and merge policy.
`.github/CODEOWNERS` declares default reviewers and repeats ownership for authentication, repository
automation, release, and governance paths where an explicit security review is required. GitHub
repository settings remain the source of truth for actual account permissions and protected-branch
enforcement. For `dev`, a current maintainer with live `maintain` or `admin` access can
explicitly integrate a PR without a second maintainer approval. The optional merge-review
helper validates this actor/base exception separately from its default contributor-approval
path; it does not certify CI or security review. The PR-only bypass leaves direct pushes,
force-pushes and deletion blocked. `main` and `preview` retain their existing review rules.

A new dashboard management operation ships with its `ocx` command in the same change, declared in
`src/cli/capabilities.ts`, or with an explicit note that it is visual-only (theme, language,
navigation). CLI commands call the running management API rather than re-implementing its validation,
so the management route stays the single domain schema.

> Decision record: [ADR-0083](../decisions/ADR-0083-maintenance-governance.md)

## Package runtime (bundled Bun)

The source runs on Bun, but the published package does **not** require a user-installed Bun.
`package.json` `bin` points at `bin/ocx.mjs` (a Node shim), and the Bun runtime ships as the `bun`
npm dependency (esbuild-style: a tiny main package plus platform-specific `@oven/bun-*`
`optionalDependencies`, finalized by the dependency's own `postinstall: node install.js`).

Invariants:

- `bin/ocx.mjs` resolves the bundled binary via `require.resolve("bun/package.json")` and a size gate
  (`>= 1 MB`) that rejects the ~450-byte placeholder stub left by `--ignore-scripts`/pnpm; it then
  lazy-runs `install.js` and execs `src/cli/index.ts` under Bun, propagating exit code and signal.
- `package.json` carries `"trustedDependencies": ["bun"]` so `bun install` runs the dependency's
  postinstall, and `"engines": { "node": ">=18" }` (Bun is no longer a user prerequisite).
- The plain-Node launcher owns `OPENCODEX_BUN_PATH` selection before Bun can load project dotenv and
  stamps the chosen source/path pair. `src/service.ts` and `src/codex/shim.ts` bake that already-
  selected executable (normally the bundled binary, stable under the npm global prefix) into
  launchd/systemd/Task Scheduler and the Codex autostart shim. Bun-side code never re-selects a
  durable executable from the post-dotenv environment.
- Public docs (root READMEs + `docs-site` installation pages, all locales) state Node 18+ as the only
  prerequisite. Do not reintroduce "install Bun first" / "bun must be on PATH" guidance for npm users.

### Package-tree integrity fence

Installed npm, bun, and pnpm packages bind each server process to the package manifest identity
observed at startup. Replacing that manifest under a live process fences `/healthz`, `/readyz`, and
`/v1/*` with `package_tree_changed`. The first observed replacement starts an unref'd five-second
stability timer; if the same new manifest identity remains readable and distinct, the timer enters the existing
drain-and-restart handoff without waiting for another request. A temporarily unreadable manifest
is polled until readable and then receives a fresh full stability interval, while a return to the
startup identity cancels the pending restart. Failed restart admission retries after the same
bounded delay. Stopping the server before the accepted restart begins vetoes it, and a service child
restarts only while it still owns the service home. Source checkouts and standalone binaries remain outside this fence.

The fence withholds readiness, never identity (INV-FENCE-01). The fenced `/healthz` still answers a
local attestation challenge and reports `restartCapability`, plus the `installedVersion` on disk
once the replacement has held for the full stability interval (a readable manifest alone does not
mean the install finished).
Liveness accepts that 503 only when a caller opts in (`ocx restart`, `ocx stop`, service stop) and
only after this home's runtime record names the same pid and port and the listener proves that
record's secret; the pid in the body is never trusted alone. Ensure, update health and replacement
waits stay opted out. A fenced restart compares the CLI with `installedVersion`, because the in-place
respawn runs the replaced files at the same path, and refuses while that version is unreadable.

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build. `scripts/release.ts` accepts either an explicit version or
`--bump patch|minor|major`; the stable and preview channels use separate resolvers in
`scripts/version-line.ts`. It runs local typecheck, `bun test --isolate tests`, and
`bun run privacy:scan` before the version bump, commit/push, Cross-platform CI wait, and GitHub
Release workflow dispatch. Docs publishing is separate from npm release publishing.

The version lives in four files, and every path that moves it moves all four:
`package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the
`opencodex-desktop` entry of `desktop/src-tauri/Cargo.lock`. The desktop build reads its version
from the Tauri and Cargo files (the widget plist inherits it) while the updater manifest is derived
from the dispatch input, so a `package.json`-only move ships an app that reports the previous
version under a manifest naming the new one, and the updater re-offers that release forever.
`scripts/release-version-sources.ts` owns the list and the one-line rewrite of each file.
`scripts/release.ts` and `scripts/bump-dev-version.ts` rewrite through it, `release.yml` runs its
`check` in `preflight` and `package-desktop` before anything is built and again in `publish`, and
`dev-version-bump.yml` stages exactly those four paths and refuses a reused bump branch that
touches anything else. `tests/ci-workflows/release-version-sources.test.ts` fails on drift in the
working tree and pins that wiring.

The `package-standalone` job in `.github/workflows/release.yml` also builds Bun compiled
`ocx` archives for Linux, macOS, and Windows, bundles `gui/dist`, smoke-tests `/healthz`, and
publishes SHA-256 sidecars for the attach job.

Opening a release starts with the `dev` pre-move. Dispatch
`.github/workflows/dev-version-bump.yml` with the intended version, merge the pull request it opens,
then promote and release. A no-op is valid when `dev` already outranks the target. `release.yml`
independently enforces that readiness condition and refuses publication if the pre-move is missing.
The design and repair history live in `devlog/_fin/260904_release_version_line/`.

Opening a preview for the next core ends the current patch line. After
`vX.Y.0-preview.*` is tagged, a fix ships as part of `X.Y.0`, not as
`X.(Y-1).(Z+1)`. `nextStableRelease` refuses such a patch bump, and the release workflow's global
ordering gate prevents an explicit lower version from bypassing the resolver. This is a deliberate
policy restriction, not preservation of an unused capability: at the design audit, 103 of 143 stable
tags had `patch > 0`, and history includes `v2.6.24-preview.20260705` followed by `v2.6.23` and
`v2.7.39-preview.20260724` followed by `v2.7.37`. Reopening parallel patch lines would require a
separate channel-aware invariant and release-note baseline design.

### Release notes

The release workflow invokes `scripts/build-release-changelog.ts`, which builds notes from
the actual Git range and uses generated PR notes as enrichment. Its categorized summaries
contain one bullet per PR or direct commit, followed by `## Changelog` entries retaining PR
titles and authors or sanitized direct-commit text. A comparison baseline adds a compare link.
Preview notes are incremental; stable notes cover the range since the previous stable tag.
The standalone `scripts/release-notes.ts render` command retains its separate scope-grouped
summary and carried-preview rendering behavior.

Both renderers strip the exact leading `[WRONG BRANCH]` marker followed by one ASCII space
from PR summary bullets and full-changelog titles. Other bracketed text is preserved.
Summary bullets remove conventional commit prefixes; PR changelog entries keep those prefixes,
PR numbers, and author attribution. This normalization does not change category selection,
direct-commit coverage, or PR-target enforcement.

The deterministic renderer produces the structure but not curated prose. Maintainers who want
the OpenAI-style grouped summaries can run the optional local polish step against the rendered
body (needs an OpenAI-compatible API key):

```bash
bun scripts/release-notes.ts render ... --out notes.md
bun scripts/release-notes.ts polish --in notes.md --out notes.md
```

`polish` rewrites only the category sections, keeps the machine-rendered Changelog verbatim,
and fails closed when the rewrite drops, invents, or re-heads any PR reference. It is never
called from CI — there is no LLM credential on the runner — so the workflow ships the
deterministic body whenever the maintainer skips it.

## Release metadata invariants

Every npm release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` and the desktop version sources | `version` in `package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the `opencodex-desktop` entry of `desktop/src-tauri/Cargo.lock` equals the release workflow `version` input. |
| npm registry | `@bitkyc08/opencodex@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

Fresh publication refuses an existing npm version, Git tag or GitHub Release. An explicit
resume skips npm publication only after the official registry returns a scalar, full-length
`gitHead` exactly matching the audited `GITHUB_SHA`. `scripts/verify-release-resume.ts` validates
that metadata; the publication step also requires the preflight's matching output before it
acknowledges publication. Missing, malformed, unavailable or mismatched identity refuses resume.
This checks registry source metadata, not cryptographic provenance. Fresh publication retains
the existing OIDC trusted-publishing path.

Two ordering checks run before publication. The version on `origin/dev` must strictly outrank the
release target, proving the pre-move has landed. After a fresh tag fetch, the release target must also
outrank the global release-tag set. The only equality exception is a dry run whose existing tag points
at the exact `GITHUB_SHA`; a real publish never receives that exception.

Do not force-move public version tags by default. If release metadata is already inconsistent, treat
the version as consumed and publish the next unused patch version instead. Only rewrite a public tag
after an explicit human decision that the public history rewrite is acceptable.

Manual preflight checks when debugging a release:

```bash
npm view @bitkyc08/opencodex@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

If any of these commands reports an existing artifact for the requested version, stop fresh
publication. A previously acknowledged npm publication may use the explicit same-commit resume
path above; it never republishes npm. Otherwise choose the next unused version that outranks the
global tag set and release it through `scripts/release.ts`. A patch is not available once a higher-core
preview has closed that stable patch line.

Cross-platform CI test lanes and release proof live in [Cross-platform CI](cross-platform-ci.md).

## Remote Hub locale and release gate

The Remote Hub guide describes the
[status credential binding](../runtime.md#remote-hub-status-credential-binding)
and its matching-cache or `unavailable` result.

The Remote Hub guide and affected CLI, server-config, management-API, and dashboard references have eight sources: root English plus `fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, and `tr`. English is canonical; commands, defaults, endpoint auth, and warnings remain exact in translations. A release requires the remote-only focused/full gates, privacy scan, GUI/docs builds, protocol compatibility receipts, and the MAINTAINERS security review for the exact head.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](../providers/openai-tiers.md#quota-cache-and-short-window-history).

The account CLI and translated Codex integration guides follow the [automatic plan exclusion contract](../providers/openai-accounts.md#automatic-pool-plan-exclusions), including all-excluded pools and explicit routes.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](../remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
The Combo guides describe the distinction between display quota and single-credential inference evidence used by routing. See [scoped provider quota](../runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Provider configuration documents distinguish actual summaries from raw reasoning content. The test layout registers the summary-default contract cases and removes the obsolete content-rewrite test with its implementation.

Paginated and migration-capable history follows the [authoritative writer contract](../codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Private pool credential metadata follows the [quota-history publication identity contract](../providers/openai-accounts.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Hub/browser pairing instructions distinguish machine enrollment, session authentication, permission denial and network failure. The hosted dashboard preview is the render artifact used to review these states.
The integrations guide documents Cline CLI as a two-file, loopback-only integration. Hosted CI validates its source-backed fixtures; the packaged dashboard exposes it through the existing client list.
The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](../providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

OpenCode launcher verification distinguishes the local management catalog request from the inference child. Its transport regressions cover proxy environment, redirects, endpoint validation, credential precedence and child-env separation on hosted CI.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](../config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](../catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

The public server configuration reference documents the optional
[compaction routing override](../transports/responses-failover.md#compaction-routing-overrides). Its regression file is registered in both test-layout inventories.

Catalog synchronization follows the [reasoning metadata refresh contract](../catalog.md#reasoning-metadata-refresh).

Bun updater ownership and recovery follow the [service transaction contract](service-and-sidecars.md#bun-updater-ownership-transaction).

Linux release bundling enables Tauri verbosity on the primary attempt so linuxdeploy diagnostics remain visible. macOS signing verbosity and publication/signature gates are unchanged.

Universal macOS release builds install both aarch64-apple-darwin and x86_64-apple-darwin Rust targets. Windows builds consume the private JSON override generated by `desktop/scripts/windows-installer-config.ts`: only WiX ProductVersion uses the validated numeric public version core. Public package/application versions, tags, asset names and updater manifests retain full SemVer. The pinned Tauri MSI template permits equal-core replacement; manual MSI installation does not enforce same-core preview/stable downgrade prevention.
The existing `codex-routing`, `codex-auth-context` and `codex-quota-prime` tests cover [priority failback](../providers/openai-accounts.md#ongoing-priority-failback), including cache-default retention, stale evidence, main fencing and failed-attempt cadence.
