---
title: Contributing
description: Develop opencodex — setup, layout, conventions, and how to add a provider or adapter.
---

## Setup

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # proxy API in dev mode
bun run dev:gui      # dashboard dev server (another terminal)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` remains an alias for `bun run dev:proxy`. The dashboard dev server is `bun run dev:gui`;
the packaged dashboard at `GET /` is produced by `bun run build:gui` (`gui/dist`).

## Build and test commands

The root package is Bun-native TypeScript; there is no separate server compile step. Use the checked-in
scripts so local commands match CI:

```bash
bun run typecheck                 # strict TypeScript check
bun run test                      # complete tests/ suite
bun test tests/router.test.ts     # focused test file
bun run build:gui                 # Vite GUI build + package preparation
bun run privacy:scan              # credential/privacy scan used by CI
bun run prepare:package           # refresh package launchers/assets
```

Most tests are flat `tests/*.test.ts` Bun tests. `tests/helpers/` contains shared fixtures and
`tests/e2e-style/` contains broader native-parity scenarios. Keep a focused regression near the
existing tests for the subsystem you change; run the full suite for shared routing, adapters, config,
or server behavior.

The docs site you're reading lives in `docs-site/` (Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## Docs publishing

The public docs publish to GitHub Pages at <https://lidge-jun.github.io/opencodex/>. The
`.github/workflows/deploy-docs.yml` workflow runs on `main` pushes that touch `docs-site/**` or the
workflow itself, builds `docs-site`, and deploys the generated site. Before pushing docs changes,
run:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI and releases

GitHub Actions intentionally stay small:

- **Cross-platform CI** (`.github/workflows/ci.yml`) runs on pull requests and `main` pushes that
  touch runtime, tests, package, script, TypeScript, or workflow files. Its Bun matrix covers Linux,
  Windows, and macOS with install, typecheck, tests, privacy scan, a release-helper build smoke, GUI
  build, and `ocx help`. A second three-OS lane proves npm global install works without a separately
  installed Bun by using the package's bundled runtime.
- **Release** (`.github/workflows/release.yml`) is manual. It does not act as a second full CI
  pipeline; before dry-run or publish it requires the exact release commit (`GITHUB_SHA`) to already
  have a successful Cross-platform CI run.

Use the helper for releases:

```bash
bun run release <version>           # commits/pushes the bump; publish workflow is dry-run by default
bun run release <version> --publish # publish after the CI-gated dry run is understood
bun run release:watch               # watch the newest Release workflow run
```

## Project maintainers

The current maintainers, their responsibilities, and the review and merge policy are documented in
[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md). GitHub review
ownership for the repository and security-sensitive paths is declared in `.github/CODEOWNERS`.

## Conventions

- **ES Modules only** (`import`/`export`), TypeScript, `strict` mode. Keep `bun x tsc --noEmit` clean.
- **~500 lines per file max** — split by responsibility (the `web-search/` and `vision/` sidecars are
  good examples of small, focused modules behind a single `index.ts`).
- **Handle async errors at boundaries** — sidecars never throw into the request path; they degrade to
  a graceful marker.
- **Structure SOT** — current maintainer invariants live in `structure/`. Keep public user workflows
  in `docs-site/` and historical investigation notes in `docs/`.
- **Preserve exports** — other modules may depend on them.

## Adding a provider to the catalog

All provider pickers and seeds derive from the canonical registry (`src/providers/registry.ts`):

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` feeds that entry into `ocx init`, `ocx provider`, dashboard presets,
API-key login, and OAuth config seeds. `enrichProviderFromCatalog()` copies model metadata and
capability classifications onto the saved provider config. OAuth protocol implementations still
live in `src/oauth/`; registry metadata alone is not an OAuth flow.

## Adding an adapter

Implement `ProviderAdapter` (see [Adapters](/opencodex/reference/adapters/)) in `src/adapters/`,
register its name in `src/server/adapter-resolve.ts`, and bridge its output to internal
`AdapterEvent`s. Reuse `image.ts` for image handling and follow `openai-chat.ts` for ordinary
streaming/tool calls; use `fetchResponse` only when the adapter owns transport retries, or `runTurn`
for a genuinely bidirectional transport such as Cursor. Add focused tests under `tests/` and export
the factory from `src/index.ts` when it belongs to the public package API.

## Verify before you claim done

Run the narrowest command that proves your change — `bun run typecheck` for types, a focused
`bun test tests/<name>.test.ts` or runtime probe for behavior, then the broader gates appropriate to
the affected surface. opencodex favors small, verifiable commits over large batches.
