# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, with Korean under `/ko`, Simplified Chinese under `/zh-cn`, Traditional Chinese under `/zh-tw`, Russian under `/ru`, and Japanese under `/ja`. `docs-site/astro.config.mjs` is the locale source of truth.

Manual navigation is defined in `docs-site/astro.config.mjs`. When adding a public page, update the
sidebar and either add localized copies or intentionally accept Starlight fallback behavior.

## GitHub Pages

`.github/workflows/deploy-docs.yml` publishes the docs to:

```text
https://opencodex.me/
```

The workflow runs on `main` pushes touching `docs-site/**` or the workflow itself, builds
`docs-site`, uploads the artifact, and deploys with GitHub Pages.

[Decision Log]
- 목적과 의도: Serve the public documentation from the memorable first-party `opencodex.me` domain.
- 기존 구현 및 제약 조건: The project Pages site was built for `lidge-jun.github.io/opencodex`, so Astro emitted a `/opencodex` base path that returns 404 under a root custom domain.
- 검토한 주요 대안: Keep the GitHub project URL as canonical; redirect the custom domain through Cloudflare; configure the custom domain directly on GitHub Pages and build for the domain root.
- 선택한 방식: Keep GitHub Actions Pages hosting, configure `opencodex.me` as the repository custom domain, publish root-relative assets and routes, and retain the default GitHub URL only as GitHub's automatic redirect.
- 다른 대안 대신 이 방식을 선택한 이유: Direct Pages hosting preserves the existing deployment and HTTPS lifecycle without adding a second proxy or redirect service.
- 장점, 단점 및 영향: Public links and canonical metadata become stable and branded. DNS and the Pages custom-domain setting are now deployment dependencies, and old hardcoded `/opencodex` links must not be reintroduced.

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
owner-only canonical token file. Before every image build, operators run
`bun scripts/generate-compatibility-version.ts` in the host Git checkout. The runtime copies
that untracked JSON artifact without including `.git` in the Docker context or changing the
generator's tracked-source authority. `docker/verify-compatibility.ts` rejects stale manifests
by comparing all file hashes and the complete source inventory in the read-only build context
and copied runtime tree. It rejects symlinks, missing/mismatched entries, and extra source files.
The required roots are `package.json`, `bun.lock`, and `scripts/model-metadata.source.json`;
the context admits only that exact scripts artifact.
Operators must still prove liveness, readiness, authenticated
catalog access, and a real routed response before promotion.

An official image would create a larger release surface requiring maintained base-image digest
updates, vulnerability scanning, SBOM, signing, registry provenance, rollback, and support policy.
Those controls still have no owner, so there is no image-publish workflow or official registry tag.

[Decision Log]
- 목적과 의도: Document a reproducible container topology without silently creating an official image channel.
- 기존 구현 및 제약 조건: The documentation recipe was not executable from the repository root, file-backed Compose secret ownership varies by implementation, and no registry workflow, scanner, SBOM/signing chain, or image rollback policy exists.
- 검토한 주요 대안: Publish an official image; keep only copied documentation snippets; ship a maintained source recipe with a volume-backed stdin bootstrap.
- 선택한 방식: Maintain the root source-build recipe, persist the owner-only token in the state volume, publish only `10100`, and leave registry publication out of scope.
- 다른 대안 대신 이 방식을 선택한 이유: A runnable source recipe can be tested and reviewed without claiming provenance and operational controls the project does not provide.
- 장점, 단점 및 영향: Compose users get a reproducible non-root deployment and safe first-run secret path; operators still own image builds, upgrades, external TLS/tailnet management, and rollout policy.

## Windows service wrapper and incomplete updates

[Decision Log]
- 목적과 의도: Prevent a failed npm replacement from making the Task Scheduler wrapper retry missing package files forever.
- 기존 구현 및 제약 조건: The wrapper deliberately restarts a proxy after runtime crashes, but an absent baked Bun or CLI path cannot recover inside that process. Current updater preflight and stop-first behavior reduce replacement risk but do not provide a transactional restore of npm's package tree and global launchers.
- 검토한 주요 대안: Keep unconditional five-second retries, add a generic crash ceiling, restore npm directories in-place, or classify only proven missing executable paths as terminal.
- 선택한 방식: Check the baked Bun and CLI paths before every spawn; log one actionable incomplete-install message and exit with code 3 when either is absent. Preserve the existing retry loop for a child that actually launched and then failed.
- 다른 대안 대신 이 방식을 선택한 이유: A generic retry ceiling can stop a service after unrelated intermittent crashes, while copying a package directory without matching npm shims, ownership, and lock guarantees is not a safe rollback.
- 장점, 단점 및 영향: File-less package skeletons no longer produce unbounded service logs or restart churn. The wrapper still recovers ordinary proxy crashes, but repairing an incomplete npm install remains an explicit reinstall plus `ocx service repair` operation until a verified staged-update design exists.

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Any `pull_request`; runtime/package `push` to `main`/`preview`/`dev`; manual dispatch | Linux runs four suite shards plus `gates`; macOS runs two shards. Windows runs six shards only on manual dispatch with `lane=all` (or empty), not on push events. Aggregate `ci` accepts an intentional Windows skip, so release evidence must inspect all six actual job results on the exact publish SHA. `npm-global-smoke` remains GitHub-hosted because it mutates the global package prefix. |
| `.github/workflows/dev-version-bump.yml` | Manual dispatch with an intended version and `pre-move` or `repair` mode | Opens the reviewed pull request that moves `dev` past a release target. The default `pre-move` mode runs before promotion and publication; explicit `repair` mode retains the post-publish catch-up path. It is neither called by `release.yml` nor triggered by publication. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow. It requires successful Cross-platform CI for the exact `GITHUB_SHA`, requires `dev` to outrank the target, then checks the target against the freshly fetched global tag set before publish or dry-run. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Astro/Starlight docs site to GitHub Pages. |
| `.github/workflows/service-lifecycle.yml` | `pull_request` to `main`/`dev` and `push`, both filtered on the service path set (`src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`, the workflow), or manual dispatch | Service-lifecycle smoke on three platforms: Linux systemd, macOS launchd, and Windows Scheduled Tasks. Each installs, verifies, stops via `ocx stop`, and uninstalls. The path list is kept in sync with the `release.yml` service-gate regex. |
| `.github/workflows/enforce-pr-target.yml` | `pull_request_target` (opened, reopened, edited, labeled, unlabeled, ready_for_review, synchronize) plus default-branch `status` events filtered to successful `CodeRabbit` statuses | The `enforce-target` gate: rejects pull requests whose head ancestry sits on the `main` tip while far behind `dev`, rejects empty or malformed descriptions, requires a GUI screenshot when the title/body mentions `gui` (immediately waivable with the maintainer-controlled `gui-screenshot-waived` label; legacy maintainer comments remain compatibility evidence on later PR events), keeps contributor PRs in draft until a four-box readiness checklist is complete, verifies the CI / latest-dev / Codex+CodeRabbit-findings claims (review threads plus current-head CodeRabbit review-body findings outside the diff range), and adds a `review-ready` status label at the ready moment. CodeRabbit status SHAs must resolve to exactly one open current-head PR before writes. Stacked child PRs targeting another open PR's head skip the wrong-base gate. |
| `.github/workflows/enforce-issue-quality.yml` | `issues` (opened, edited, reopened), `issue_comment` (created, edited), or manual dispatch with an issue number | Issue-template compliance gate. |
| `.github/workflows/issue-quality-tests.yml` | `pull_request` and `push` filtered on the issue/PR automation scripts, templates, and their workflows | Tests the issue and PR automation scripts themselves, so the gates cannot rot silently. |
| `.github/workflows/issue-triage.yml` | `issues` (opened) | Duplicate detection and triage labeling for new issues. |
| `.github/workflows/pr-labeler.yml` | `pull_request_target` (opened, edited, synchronize, labeled, unlabeled) | Type and path labeling plus title sync; `labeled`/`unlabeled` let a human override enqueue a fresher run in the per-PR concurrency group. |
| `.github/workflows/react-doctor.yml` | `pull_request` (opened, synchronize, reopened, ready_for_review) and `push` to `main`; no path filter | React-focused static review. Findings fail the job; write-scoped outputs stay disabled, a contract pinned by `tests/ci-workflows/ci-workflows.test.ts`. |
| `.github/workflows/stale-needs-info.yml` | `schedule` only (daily 06:15 UTC); deliberately no manual dispatch | Closes issues left in needs-info past the grace period. Manual dispatch is omitted so a branch-selected run cannot execute that branch's body with issue write scope. |

`pull_request_target`, `issues`, and `schedule` workflows always load from the repository default
branch, not from `dev`. Landing a change to one of them on `dev` does not change live behavior until
it is promoted, so those files follow the promotion model rather than ordinary integration.

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

`docs/` contains investigations and diagnostic notes. Do not treat it as the current public user
manual. When an investigation graduates into a maintained invariant, summarize it here under
`structure/` and link public workflows from `docs-site/`.

## Branch and devlog policy

[`AGENTS.md`](../AGENTS.md) and [`MAINTAINERS.md`](../MAINTAINERS.md) are authoritative; this section
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

[Decision Log]
- 목적과 의도: Make project ownership and review authority discoverable without exposing credentials or treating a documentation file as an access-control mechanism.
- 기존 구현 및 제약 조건: Contribution and security docs referred to maintainers generically, while the repository had no maintainer roster or CODEOWNERS policy. GitHub permissions can change independently of the source tree.
- 검토한 주요 대안: Keep the roster only in GitHub settings; introduce a larger standalone governance charter; list raw GitHub permission levels in the repository.
- 선택한 방식: Add a concise maintainer roster and merge policy, use CODEOWNERS for review routing, and keep actual permission state authoritative in GitHub settings.
- 다른 대안 대신 이 방식을 선택한 이유: A two-maintainer project needs clear ownership and sensitive-path review rules but does not yet need a separate governance framework.
- 장점, 단점 및 영향: Contributors can identify reviewers and merge expectations directly from the repository. The roster must be updated when responsibilities change, and CODEOWNERS still requires branch-protection configuration to enforce approvals.

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

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build. `scripts/release.ts` accepts either an explicit version or
`--bump patch|minor|major`; the stable and preview channels use separate resolvers in
`scripts/version-line.ts`. It runs local typecheck, `bun test --isolate tests`, and
`bun run privacy:scan` before the version bump, commit/push, Cross-platform CI wait, and GitHub
Release workflow dispatch. Docs publishing is separate from npm release publishing.

Opening a release starts with the `dev` pre-move. Dispatch
`.github/workflows/dev-version-bump.yml` with the intended version, merge the pull request it opens,
then promote and release. A no-op is valid when `dev` already outranks the target. `release.yml`
independently enforces that readiness condition and refuses publication if the pre-move is missing.
The design and repair history live in `devlog/_plan/260904_release_version_line/`.

Opening a preview for the next core ends the current patch line. After
`vX.Y.0-preview.*` is tagged, a fix ships as part of `X.Y.0`, not as
`X.(Y-1).(Z+1)`. `nextStableRelease` refuses such a patch bump, and the release workflow's global
ordering gate prevents an explicit lower version from bypassing the resolver. This is a deliberate
policy restriction, not preservation of an unused capability: at the design audit, 103 of 143 stable
tags had `patch > 0`, and history includes `v2.6.24-preview.20260705` followed by `v2.6.23` and
`v2.7.39-preview.20260724` followed by `v2.7.37`. Reopening parallel patch lines would require a
separate channel-aware invariant and release-note baseline design.

### Release notes

Release notes are rendered OpenAI-Codex-style by `scripts/release-notes.ts render` inside
`.github/workflows/release.yml`: `## New Features` / `## Bug Fixes` / `## Documentation` /
`## Chores` / `## Other Changes` sections with prefix-free, scope-grouped summary bullets
(`- Providers: Add X; Add Y (#1, #2)`), followed by a `## Changelog` section listing every PR
as `- #N <title> @author`; when a comparison baseline exists, that section also includes a
compare link. Carried preview changelogs and the since-preview delta feed the same renderer,
so stable notes are the aggregate of their preview train. The raw commit dump is
intentionally gone — non-PR commits stay reachable via the Full Changelog compare link when
that link is available.

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
| `package.json` | `version` equals the release workflow `version` input. |
| npm registry | `@bitkyc08/opencodex@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

The release must fail before `npm publish` if npm, the Git tag, or the GitHub Release already has the
requested version. This prevents partial releases where npm is published but GitHub Release creation
fails afterward.

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

If any of these commands reports an existing artifact for the requested version, stop before
publishing. For a non-destructive recovery, choose the next unused version that also outranks the
global tag set and release it through `scripts/release.ts`. A patch is not available once a higher-core
preview has closed that stable patch line.

## Cross-platform CI

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. Linux runs
the suite in four shards with a separate `gates` job, and macOS runs it in two shards. Windows
runs the full suite in six shards only on manual `workflow_dispatch` with `lane=all` (or an
empty lane). Pushes to `dev`, `main` and `preview` do not activate that Windows matrix. A
release that requires Windows proof must dispatch it for the exact publish SHA and inspect
all six successful jobs; an aggregate green `ci` check can include a deliberate Windows skip.
Across the jobs, the workflow runs:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate tests
bun run privacy:scan
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
cd gui && bun install --frozen-lockfile && bun run lint && bun run build
bun run src/cli/index.ts help
```

and the Node-only global-install smoke path:

```bash
npm install
npm run build:gui
npm pack --json > pack.json
npm install -g ./bitkyc08-opencodex-*.tgz
ocx help
```

The CI intentionally does not build docs, run coverage, or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has a successful Cross-platform CI run,
that `dev` already outranks the target, and that the target passes the fresh global tag-ordering gate.
This keeps release runs short and makes release a deployment of a verified commit after the required
`dev` pre-move rather than a second CI pipeline.

## Remote Hub locale and release gate

The Remote Hub guide and affected CLI, server-config, management-API, and dashboard references have eight sources: root English plus `fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, and `tr`. English is canonical; commands, defaults, endpoint auth, and warnings remain exact in translations. A release requires the remote-only focused/full gates, privacy scan, GUI/docs builds, protocol compatibility receipts, and the MAINTAINERS security review for the exact head.
