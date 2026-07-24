# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, Korean under `/ko`, and Simplified Chinese under `/zh-cn`.

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

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `pull_request`, `push` to `main`/`dev`/`preview`, or manual dispatch when runtime/package paths change | Cross-platform runtime/package quality gate on Linux, Windows, and macOS. The `test` job (Bun) runs typecheck, `bun test --isolate tests`, the privacy scan, release-helper syntax check, GUI lint/build, and `ocx help`; `npm-global-smoke` (Node only, **no setup-bun**) builds package assets, packs the tarball, installs it globally, and runs `ocx help` to prove the bundled-Bun launcher works without a separate Bun install. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow. It requires the exact `GITHUB_SHA` to have a successful Cross-platform CI run before publish or dry-run. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Astro/Starlight docs site to GitHub Pages. |
| `.github/workflows/service-lifecycle.yml` | `push` touching `src/service.ts`, `src/cli/index.ts`, or the workflow, or manual dispatch | Linux systemd smoke test: install, verify, `ocx stop` stops the service, uninstall. |

Docs-only changes intentionally route through the docs workflow instead of the runtime CI gate. If a
docs change also edits runtime/package/release files, run the relevant local runtime checks before
push and let `ci.yml` provide the Linux/Windows confirmation. Service-related changes
(`src/service.ts`, `src/cli/index.ts`) additionally trigger the `service-lifecycle.yml` smoke test on Linux.

## Root README

The root READMEs are the concise product entrypoint. They should explain what opencodex does, how to
install/start it, where Codex state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Historical docs

`docs/` contains investigations and diagnostic notes. Do not treat it as the current public user
manual. When an investigation graduates into a maintained invariant, summarize it here under
`structure/` and link public workflows from `docs-site/`.

## Maintenance governance

`MAINTAINERS.md` is the source of truth for current project roles and the review and merge policy.
`.github/CODEOWNERS` declares default reviewers and repeats ownership for authentication, repository
automation, release, and governance paths where an explicit security review is required. GitHub
repository settings remain the source of truth for actual account permissions and protected-branch
enforcement.

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
- `src/service.ts` and `src/codex/shim.ts` bake `durableBunPath()` (the bundled binary, stable under
  the npm global prefix) into launchd/systemd/Task Scheduler and the Codex autostart shim, so those
  durable artifacts keep resolving across `ocx update`.
- Public docs (root READMEs + `docs-site` installation pages, all locales) state Node 18+ as the only
  prerequisite. Do not reintroduce "install Bun first" / "bun must be on PATH" guidance for npm users.

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build, and `scripts/release.ts` now runs local typecheck, `bun test --isolate tests`, and
`bun run privacy:scan` before the version bump, commit/push, Cross-platform CI wait, and GitHub
Release workflow dispatch. Docs publishing is separate from npm release publishing.

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
publishing. For a non-destructive recovery, choose the next unused patch version and release that
version through `scripts/release.ts`.

## Cross-platform CI

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. It runs on
Linux, Windows, and macOS with two job families:

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
checks that the exact release commit (`GITHUB_SHA`) already has a successful Cross-platform CI run.
This keeps release runs short and makes release a deployment of a verified commit rather than a
second CI pipeline.
