# Docs And Release

The activation scheduling contract is covered by `tests/codex-integration/codex-quota-auto-refresh.test.ts`, including restart recovery and bounded retries. See the [quota activation contract](../providers/openai-tiers.md#public-provider-contract). `.github/workflows/catalog-async-contracts.yml` runs portable Rust-owned Bun catalog contracts on Linux, macOS and Windows for runtime, fixture or dependency changes on pull requests or manual dispatch. It has read-only permissions and no release effect.

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

`tests/cli/cli-config-default-show.test.ts` covers optional-show parsing, offline display and explicit-action preservation; `tests/cli/cli-config-show-client.test.ts` covers the separate read-only config annotation path:
`src/cli/config-command.ts` derives token ownership without importing the connect command or
triggering catalog, lifecycle, or ACL-hardening work.

The CLI default dashboard address follows the [management ingress bind](../runtime.md#hub-management-dashboard-address), covered by `tests/cli/cli-dispatch.test.ts`.

Native main reauthentication follows the [CLI JSON output contract](../runtime.md#native-main-reauth-json-output).

The Codex restart command follows the [CLI restart scope contract](../runtime.md#cli-codex-restart-scope).

The account reference documents the [Orca source-owned import](../codex-home.md#orca-source-owned-account-import).
Its local-only command is declared in `src/cli/capabilities.ts`, and the generated skill surface
lists its required source/registry paths and preview/apply flags. The index and domain chapters follow the [CLI reference generation contract](../cli-management.md#generated-operating-reference).

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
documented split is 106 total: 85 key-based, 17 OAuth, three local, and one default
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

The workflow is manually dispatched from `dev` and selects a published stable release: the
latest stable by default, or an explicitly named stable tag. It resolves that tag to a full
commit SHA before checkout. The build has read-only contents access; only the deploy job gets
Pages and OIDC write permissions. There are no push triggers. The scoped `docs-site-build` PR
job validates the site before merge, including the internal-link integration.

A maintainer configures Pages to use GitHub Actions and restricts the `github-pages`
environment to the protected `dev` branch, with required reviewers according to repository
policy. Do not allow arbitrary branches or tags in that environment: a branch-selected workflow
can replace its own guards. Protect `dev` and release tags, and verify these settings before
deploying. The repository default branch is `dev`, so default-branch automation loads from it.
The legacy `main` and `preview` branches were deleted once the single-branch model was in place;
released history remains reachable through tags. No repository setting change or production
deploy is implied by this documentation.

Service lifecycle evidence includes the legacy CLI entrypoint `src/cli.ts` as well as the
service implementation and desktop packaging paths.

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

The scheduler wrapper retries child exits, including zero, after five seconds. Only the
opt-in CLI stay-out code ends it successfully; missing Bun/CLI paths still exit with
installation error 3. Explicit service stop terminates the wrapper itself.
Before launching, the wrapper applies the bundled-Bun size gate (`REAL_BUN_MIN_BYTES`). An
in-place npm install extracts `bun/bin/bun.exe` as a small placeholder and replaces it only when
bun's postinstall runs later; executing the placeholder exits 216 and, interactively, raises a
modal 16-bit dialog. A Bun file below the gate, or one whose size cannot be read because it
vanished after the exist check, logs `bundled Bun is not ready` and is re-checked every five
seconds without being executed, so the service starts once the postinstall lands. A Bun path
that is already missing at the exist check keeps the unchanged `bun_missing` path: backup
restore, then installation error 3. If the postinstall never runs (scripts blocked), the
wrapper keeps waiting and logging; reinstalling with `--allow-scripts=bun` (or running the
package's `bun/install.js`) is the recovery, and the next pass starts without a service repair.
Timestamp expansion in the scheduler wrapper stays outside parenthesized batch
blocks so locale dates containing parentheses cannot abort prelaunch checks or
transactional-backup recovery. Delayed expansion stays disabled to preserve
exclamation marks in paths. Recovery logs a fixed success message without expanding
the filesystem-derived backup directory name into a command.
`src/service/windows-wrapper-exit.ts` defines the opt-in contract: new wrappers set
`OCX_WINDOWS_WRAPPER_PROTOCOL=1`, and all three CLI live-owner exits return 42 in that
service context. The wrapper translates 42 into a successful exit; legacy service
contexts retain exit 0.

> Decision record: [ADR-0082](../decisions/ADR-0082-windows-service-wrapper-and-incomplete-updates.md)

## GitHub workflow map

The PR-target resolver accepts commit-index candidates only when their base repository's
owner and name match the workflow repository. Foreign or incomplete fork-network entries
cannot supply a write-job PR number. If no unique local current-head candidate remains, the existing repository-scoped open-PR lookup runs; absent or ambiguous matches emit no identity.

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Pull requests and manual dispatch | Scoped Ubuntu checks on PRs; full Linux, macOS and Windows evidence via manual `lane=all` on `dev`. The aggregate validates the requested job graph. |
| `.github/workflows/dev-version-bump.yml` | Manual dispatch | Legacy pre-move and repair tool; it is not part of the new release path. |
| `.github/workflows/release.yml` | Manual dispatch from `dev` | Resolves qualifying source evidence, stamps build checkouts and reconciles publication history; publication is held pending the remaining cutover gates, and an attested resume recovers a run that already published npm. |
| `.github/workflows/deploy-docs.yml` | Manual dispatch from `dev` | Builds a published stable release at its resolved commit and deploys to Pages; the PR build gate is `docs-site-build`. |
| `.github/workflows/service-lifecycle.yml` | Filtered pull requests and manual dispatch | Linux, macOS and Windows service checks; manual dispatch validates an exact `dev` ancestor source SHA. |
| `.github/workflows/catalog-async-contracts.yml` | Filtered pull requests and manual dispatch | Read-only catalog contracts; PRs run Ubuntu and manual dispatch from `dev` runs all three platforms. |
| `.github/workflows/enforce-pr-target.yml` | `pull_request_target` (opened, reopened, edited, labeled, unlabeled, ready_for_review, synchronize) plus default-branch `status` events filtered to successful `CodeRabbit` statuses | The `enforce-target` gate: rejects pull requests whose base is not `dev` (stacked children excepted), rejects empty or malformed descriptions, requires a GUI screenshot when the title/body mentions `gui` (immediately waivable with the maintainer-controlled `gui-screenshot-waived` label; legacy maintainer comments remain compatibility evidence on later PR events), keeps contributor PRs in draft until a four-box readiness checklist is complete, verifies the CI / latest-dev / Codex+CodeRabbit-findings claims (review threads plus current-head CodeRabbit review-body findings outside the diff range), and adds a `review-ready` status label at the ready moment. CodeRabbit status SHAs must resolve to exactly one open current-head PR before writes. Stacked child PRs targeting another open PR's head skip the wrong-base gate. `labeled`/`unlabeled` wake the gate only for `gui-screenshot-waived` and the `HYGIENE_GATE_LABELS` exported by `.github/scripts/pr-hygiene.cjs`; `tests/ci-workflows/ci-workflows.test.ts` pins the two lists together. Head-specific exception labels (`test-exception-approved`, `suppression-approved`, `generated-change-approved`, `dependency-change-approved`, `attribution-approved`) count only while the head and head-rewrite count that `pr-hygiene.yml` last recorded in its comment section are unchanged; both gates read that record and only the hygiene workflow writes it or removes the labels. |
| `.github/workflows/enforce-issue-quality.yml` | `issues` (opened, edited, reopened), `issue_comment` (created, edited), or manual dispatch with an issue number | Issue-template compliance gate. |
| `.github/workflows/issue-quality-tests.yml` | `pull_request` filtered on the issue/PR automation scripts, templates, and their workflows | Tests the issue and PR automation scripts themselves, so the gates cannot rot silently. |
| `.github/workflows/issue-triage.yml` | `issues` (opened) | Duplicate detection and triage labeling for new issues. |
| `.github/workflows/pr-labeler.yml` | `pull_request_target` (opened, edited, synchronize, labeled, unlabeled) | Type and path labeling plus title sync; `labeled`/`unlabeled` let a human override enqueue a fresher run in the per-PR concurrency group. |
| `.github/workflows/react-doctor.yml` | `pull_request` (opened, synchronize, reopened, ready_for_review) touching `gui/**` or the workflow | React-focused static review. Findings fail the job; write-scoped outputs stay disabled, a contract pinned by `tests/ci-workflows/ci-workflows.test.ts`. |
| `.github/workflows/stale-needs-info.yml` | `schedule` only (daily 06:15 UTC); deliberately no manual dispatch | Closes issues left in needs-info past the grace period. Manual dispatch is omitted so a branch-selected run cannot execute that branch's body with issue write scope. |

`pull_request_target`, `issues`, and `schedule` workflows load from the repository default branch, which is `dev`.

CI setup uses the [Bun runtime and test-runner pins](../runtime.md#bun-runtime-and-test-runner): test jobs (including development-version validation) choose `test-runner`, while release packaging, desktop/widget compilation and runtime smokes keep the default `runtime` role. Local layout verification resolves that test pin, and `gui/package.json` runs `scripts/test-with-pinned-bun.ts` to preserve its working directory, configuration and arguments on the same pin. The wrapper forwards SIGINT, SIGTERM and SIGHUP, waits for child exit and preserves interruption status (130, 143 or 129).

`scripts/test.ts` owns `SERIAL_FULL_SUITE_FILES`, the shared process-isolation roster. Local
full-suite runs, both macOS paths, and `scripts/ci/run-bun-test-batches.sh` execute those files
alone with fresh process homes, including launchd repair and standalone home/lease cases. Hosted batches assign shard membership by the per-file durations
in `scripts/ci/test-durations.tsv` (Windows: `scripts/ci/test-durations.windows.tsv`; sorted round-robin when nothing is recorded), run each shard's
files in sorted order and split only process boundaries; every selected file still runs once.
Ordinary macOS shards select 1/4, 2/4, 3/4 and 4/4 from the full file list; macOS control selects 1/1. Both
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

- `dev` is the single integration and release-source branch and the repository default branch.
  `main` and `preview` were deleted after the single-branch model was in place; released history
  remains reachable through tags. One documented exception: a stacked child PR may target another
  **open** PR's head branch as a review workflow, and is retargeted to `dev` once the parent lands
  or closes.
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
force-pushes and deletion blocked.

A new dashboard management operation ships with its `ocx` command in the same change, declared in
`src/cli/capabilities.ts`, or with an explicit note that it is visual-only (theme, language,
navigation). CLI commands call the running management API rather than re-implementing its validation,
so the management route stays the single domain schema.

> Decision record: [ADR-0083](../decisions/ADR-0083-maintenance-governance.md)

## Package runtime (bundled Bun)

The source runs on Bun, but the published package does **not** require a user-installed Bun.
`package.json` `bin` points at `bin/ocx.mjs` (a Node shim), and the Bun runtime ships as the `bun`
npm dependency pinned to `1.4.4` (esbuild-style: a tiny main package plus platform-specific `@oven/bun-*`
`optionalDependencies`, finalized by the dependency's own `postinstall: node install.js`).

Invariants:

- `bin/ocx.mjs` selects explicit override, bundled Bun, allowed installer recovery, then validated PATH Bun.
  `src/lib/bun-path-runtime.mjs` requires absolute entries, canonical regular/executable files, the >=1 MB gate, and rejects group/world-writable resolved files or parent directories on POSIX.
  Bounded version-policy and identity checks require `--version` to match `-e`'s `Bun.version`, a stable version with the pinned major at or above the pinned version (currently 1.4.4 ≤ version < 2.0.0).
  PATH selection stamps `process`; failure may name an installed Desktop CLI without executing it.
  The [Windows service wrapper](#windows-service-wrapper-and-incomplete-updates) keeps its own placeholder wait gate; updater inspection never runs installer recovery.
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
startup identity cancels the pending restart. The replacement spawns `process.execPath`, which an in-place npm install leaves as the `bun` package's small placeholder until its postinstall runs, so while that path fails the `REAL_BUN_MIN_BYTES` gate the restart waits the same way and then debounces afresh; meanwhile `installedVersion` stays unreported, so a manual restart is refused as unsettled. Failed restart admission retries after the same
bounded delay. Stopping the server before the accepted restart begins vetoes it, and a service child
restarts only while it still owns the service home. Source checkouts and standalone binaries remain outside this fence.

mise installs every version in its own directory and repoints a floating link, so `mise upgrade`
never changes the manifest the fence watches: the proxy would keep serving the old version, and once
mise pruned it the fence would report the tree unreadable and refuse traffic without restarting.
`src/update/mise-launcher-target.ts` therefore plans a launcher watch, and
`src/lib/package-tree-retarget.ts` runs it, only for the managed Linux service
(`OCX_SERVICE_MANAGED=1`) of a verified mise owner whose recorded launcher is that tool's
`<selector>/node_modules/.bin/ocx`, and only when that launcher resolves to the running package at
boot. Shims, other layouts, launchd (which pins package paths) and foreground proxies are not
followed. The watch re-resolves the launcher on its own unref'd timer, so an idle service notices an
upgrade without a request. One complete target identity, canonical package root plus manifest
identity, must hold for the settle interval; a change to either, an unresolvable target, a target
outside the tool root, or a return to the running root restarts the wait. It then enters the same
restart handler as the fence without fencing requests, retries a refused admission after another
full interval, and reports the settled target's version as `installedVersion` when the fence has
none. The replacement boots from the target, so it never restarts again.

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

Package release is npm-focused. `.github/workflows/release.yml` resolves a qualifying exact
`dev` source using the trusted workflow revision, derives the version and stamps the four version
sources in temporary build checkouts using `scripts/release-version-sources.ts`. The sources are
`package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the
`opencodex-desktop` entry in `desktop/src-tauri/Cargo.lock`. The new path remains pre-cutover:
a real publication or resume requires the repository variable `OCX_DEV_RELEASE_PUBLISH_ENABLED`
to equal `true`. Independent review of the legacy history mapping, security review, real dry-run
evidence and settings must be resolved before cutover; this text does not attest those gates.
Docs publishing is separate. Dispatch inputs are `tag` (`latest` or `preview`), `dry-run`
(default `true`), `expected-sha`, `version` and `resume-after-npm-publish`; `scripts/release.ts`
dispatches ordinary runs only, so a resume is dispatched by hand.

The `package-standalone` job in `.github/workflows/release.yml` also builds Bun compiled
`ocx` archives for Linux, macOS, and Windows, bundles `gui/dist`, smoke-tests `/healthz`, and
publishes SHA-256 sidecars for the attach job. Each archive also carries the target-matching
`@napi-rs/keyring` native addon under `keyring/`; the macOS release installs both optional Darwin
packages so its separate arm64 and x64 builds cannot silently reuse the hosted runner's architecture. Desktop preparation
copies those same pinned assets into Tauri resources. The loader and packaged-app proof are owned by the [desktop keyring contract](../desktop-shell.md#packaged-native-keyring-binding).
`src/lib/standalone.ts` recognizes Bun's file-URL virtual roots after one URL decode, including Windows `%7EBUN`, and resolves runtime assets beside the real executable. Invalid/non-file URLs and double-encoded markers remain source paths; `tests/lib/standalone.test.ts` and `tests/service/standalone-service.test.ts` cover this distinction.

The old `dev-version-bump.yml` pre-move is a legacy manual tool and is not required by the new
source-selection path. The release workflow remains subject to the unresolved cutover gates above.

### History reconciliation

Every run that is not a resume, dry runs included, runs `.github/scripts/release-history.cjs` from
the trusted workflow revision in `verify-npm`, and `publish` repeats it immediately before
`npm publish`. It requires complete Git history, reads npm history from the npm registry, reads
`dev`, tags and releases with authenticated GitHub requests, and refuses if a second read differs.
Existing npm history does not block a release. The gate reconciles it against the channel floors,
the newest stable and the newest preview npm publications, and refuses when any of these fails:

- Every npm publication from the older floor onward has a `gitHead`, a `v<version>` tag at that
  commit and a published GitHub release whose prerelease flag matches its channel. Every published
  GitHub release in that window has an npm version. An npm-only or partial publication stops for
  manual reconciliation.
- The candidate version exceeds every published npm version.
- The candidate is reachable from `dev` and contains each floor's source. For the two fixed legacy
  `2.99.0` floors, containment is replaced, not added to. Their registry `gitHead` and `v<version>`
  tag must equal the fixed legacy SHA, the legacy baseline `0627a2c2` (2.100.0) must be an ancestor
  of both the candidate and `dev`, and the legacy-to-baseline diff must be exactly the four version
  sources with only the version string changed (`verifyLegacyTreeEvidence`).
- The candidate reuses the newest floor's source only for a stable release after that preview.

Publications older than the floor window take part in the identity, version and ordering checks
only.

### Resuming after npm publication

A run that published npm and then failed before its GitHub release was complete is recovered by
dispatching again with `resume-after-npm-publish: true`, the original `version`, the original
source as `expected-sha` and `dry-run: false`. A resume missing any of these is refused. The resume
is an operator attestation that this version was published from that source; registry and GitHub
state are consistency checks, not provenance. The source still needs qualifying `dev` evidence.
The run skips version derivation and history reconciliation, and refuses unless:

- the exact version is on npm and its `gitHead` equals the supplied source
  (`scripts/verify-release-resume.ts`);
- `.github/scripts/release-resume.cjs` finds that version is the newest npm publication, with no
  higher npm version or `v` tag and no dist-tag naming an unknown version, and two reads of the
  registry, tags and release agree;
- if a `v<version>` tag or GitHub release already exists, the tag points at the source and the
  release matches the channel; the run creates a missing tag and a missing release as a draft;
- assets already on the release carry the digests in this run's verification receipt. A published
  release missing a verified asset is refused; otherwise missing assets are uploaded.

A resume never runs `npm publish`, and only the resume path reuses an existing tag or GitHub
release. If the version or source cannot be verified, the maintainer reconciles the partial
publication by hand.

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

A release version must agree across the four stamped version sources, npm package, tag and
GitHub Release; tags are intended to point to the selected source SHA. Reconciliation covers the
floor window in [History reconciliation](#history-reconciliation); do not infer that older npm
publications or legacy tag ancestry have been reconciled. An npm version is published once.
Recovery goes through the [attested resume](#resuming-after-npm-publication), never a republish,
and public version tags are never force-moved.

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

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat also honors explicit per-axis capability declarations.

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

Automatic account exhaustion and recovery use the [spendable Codex credit evidence contract](../providers/openai-tiers.md#spendable-codex-credits), including independent freshness, upstream refusal, and reset-ticket separation.
