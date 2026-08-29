---
title: Contributing
description: Develop opencodex — setup, layout, conventions, and how to add a provider or adapter.
---

## Setup

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for users, but this checkout's scripts run through your local Bun installation.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # proxy API in dev mode
bun run dev:gui      # dashboard dev server (another terminal)
bun run typecheck    # bun x tsc --noEmit
bun run test:changed              # routine import-graph test selection
bun test tests/router.test.ts     # routine focused test
bun run test                      # complete suite (PR-ready / explicit ask)
```

`bun run dev` remains an alias for `bun run dev:proxy`. The dashboard dev server is `bun run dev:gui`;
the packaged dashboard at `GET /` is produced by `bun run build:gui` (`gui/dist`).

## Build and test commands

The root package is Bun-native TypeScript; there is no separate server compile step. Use the checked-in
scripts so local commands match CI:

```bash
bun run typecheck                 # strict TypeScript check
bun run test:changed              # import-graph tests against the resolved dev merge base
bun run test                      # complete tests/ suite (PR-ready / explicit ask)
bun test tests/router.test.ts     # focused test file
bun run build:gui                 # Vite GUI build + package preparation
bun run privacy:scan              # credential/privacy scan used by CI
bun run prepare:package           # refresh package launchers/assets
```

`test:changed` selects the first comparison ref that exists, in order: `upstream/dev`,
`origin/dev`, then local `dev`. It reports that ref and the exact `git merge-base HEAD <ref>`
commit, then passes the merge-base SHA to Bun.

Most tests are flat `tests/*.test.ts` Bun tests. `tests/helpers/` contains shared fixtures and
`tests/e2e-style/` contains broader native-parity scenarios. Keep a focused regression near the
existing tests for the subsystem you change; run the full suite for shared routing, adapters, config,
or server behavior.

The docs site you're reading lives in `docs-site/` (Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## Docs publishing

The public docs publish to GitHub Pages at <https://opencodex.me/>. The
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
- **Stale needs-info** (`.github/workflows/stale-needs-info.yml`) runs daily on the default branch.
  Open issues labeled `needs-info` with no activity for 14 days get a warning; after 7 more idle
  days they close as not planned. Any update clears the stale warning. To keep long-lived work open,
  remove `needs-info` (for example when promoting an issue to `roadmap`).
- **Issue quality** (`.github/workflows/enforce-issue-quality.yml`) validates template structure on
  new and edited issues, applies kind labels (`bug`, `enhancement`, `provider-compatibility`,
  `documentation`), and adds orthogonal **area** labels from the form Area field plus light
  title/Summary heuristics: `provider`, `account-pool`, `catalog`, `gui`, `cli`, `proxy`,
  `platform`, `streaming`, `tools`, `install`, and `service`. Kind/process labels stay separate so
  you can filter `bug` + `account-pool` without collapsing those axes. Prefer the Area dropdown
  over inventing per-provider labels. Area: Documentation does not add a second area tag (the docs
  form already seeds `documentation`). Maintainers can re-apply area labels to all open issues with
  workflow_dispatch `backfill_open_areas` after the workflow is on the default branch.

Use the helper for releases:

```bash
bun run release <version>           # commits/pushes the bump; publish workflow is dry-run by default
bun run release <version> --publish # publish after the CI-gated dry run is understood
bun run release:watch               # watch the newest Release workflow run
```

## Branches

- `dev` — the only integration target. Open your pull request here.
- `main` — releases only. It moves by maintainer-controlled promotion from
  `dev`; do not open feature pull requests against it.
- `preview` — the prerelease train.

The `dev2-go` line that carried the Go native port has been retired, and the
dual-track carry policy with it. Its history is published read-only at
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive).
Bun-native TypeScript on `dev` is the single runtime line.

Rebase pull requests are welcome. Bringing a stale branch onto the current head
is normal contribution rather than noise — note the source commits in the
description.

## Pull requests

- Target **`dev`**. Do not open feature or fix pull requests against **`main`**.
- Branch from the current **`dev`** tip, not from **`main`**. The required **`enforce-target`** check rejects heads whose merge base sits on the **`main`** tip while the branch is far behind the pull request base (the failure mode seen in #644).
- Write a real description: a **Summary** of what changed and why, plus a **Test plan** (or equivalent substance). Empty bodies, placeholder-only text, and descriptions that use escaped `\n` instead of real line breaks fail the check.
- If the title or description mentions `gui`, include a screenshot of the UI change in the description; the `enforce-target` check re-runs on description edits until the screenshot is present.
- Workflow changes in this repository use **`pull_request_target`**. Updated enforcement logic applies only after the workflow is promoted to the repository default branch — the same operational caveat documented in #631.

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

### Evidence required for a canonical preset

A registry entry is a maintained promise: opencodex ships the destination that a user's API key is
sent to. A preset therefore needs primary-source evidence, not a working code path. Pull requests
that add or promote a provider must supply all of the following in the description:

- **The documented OpenAI-compatible endpoints.** Link the vendor's own API reference for the chat
  endpoint and, when the entry sets `liveModels: true`, for its authenticated model-discovery
  endpoint (typically `GET /v1/models`). A
  passing fixture test is not a substitute: it proves our code shape, not the upstream contract.
- **Terms of service and the operating legal entity.** An empty or placeholder legal page does not
  establish who runs the endpoint or under what terms user traffic is handled.
- **Resale or routing authorization for aggregators.** A gateway that sells access to Claude, GPT,
  Gemini, or other third-party models should show its authorization to route to them. Users read a
  built-in preset as a maintained route, not as an unverified reseller.
- **A named maintenance owner.** State who updates the preset when the base URL, authentication, or
  catalog contract changes, and how a break will be reported.
- **A citable verification date.** Record the primary source and the date it was checked, the same
  way `lastVerified` works in `src/providers/free-directory.ts`. A date on an unverified row asserts
  provenance nobody produced.

Contributors adding their own service are welcome, and several current presets arrived that way.
Disclose the affiliation in the pull-request description so reviewers can weigh it; affiliation is
not a reason for rejection, and it does not lower the evidence bar either.

When the evidence is incomplete, the honest home is a reference row in
`src/providers/free-directory.ts` rather than the canonical registry. Directory rows carry an
explicit `verification` grade (`official`, `primary`, `unverified`) and are inert: users can still
reach the service through the custom OpenAI-compatible flow, while opencodex avoids advertising a
preset it cannot stand behind. Promote the row to the registry once the evidence above exists.

## Adding an adapter

Implement `ProviderAdapter` (see [Adapters](/reference/adapters/)) in `src/adapters/`,
register its factory in `src/adapters/registry.ts`, and bridge its output to internal
`AdapterEvent`s. `src/server/adapter-resolve.ts` selects the effective protocol before delegating
to the registry. Reuse `image.ts` for image handling and follow `openai-chat.ts` for ordinary
streaming/tool calls; use `fetchResponse` only when the adapter owns transport retries, or `runTurn`
for a genuinely bidirectional transport such as Cursor. Add focused tests under `tests/` and export
the factory from `src/index.ts` when it belongs to the public package API.

### Adding a compatibility claim

Compatibility claims live under `src/compatibility/`. A claim is narrower than an adapter: it names
the exact provider, normalized upstream base URL, authentication mode, inbound protocol, upstream
protocol, and model ids whose behavior was proved. Do not copy a claim to every provider using the
same adapter or to another destination using the same wire format.

Use one of the versioned dispositions: `passthrough`, `translated`, `degraded`, or `unsupported`.
Every non-passthrough claim must state its limitation, and every fixture-backed claim must name the
exact assertion ids that prove it. Add the secret-free request vector under
`tests/fixtures/compatibility/` and execute it against the production adapter in a focused test.
Compatibility manifests are passive data: the ordinary router, Responses handler, and server
startup path must not import the manifest catalog or activate Compatibility Lab.

## Verify before you claim done

Run the narrowest command that proves your change — `bun run typecheck` for types, a focused
`bun test tests/<name>.test.ts` or runtime probe for behavior, then the broader gates appropriate to
the affected surface. opencodex favors small, verifiable commits over large batches.
