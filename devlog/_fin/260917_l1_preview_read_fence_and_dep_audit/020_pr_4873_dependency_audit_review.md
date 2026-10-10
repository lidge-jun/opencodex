# Unit B — PR #4873: dependency audit overrides

Contributor PR from `agentHits`, head `7c9479b5722e3f0af56a73410ca6a74fd18905b8`,
base `dev`, fork `agentHits/opencodex`, branch `fix/security-audit-overrides-hono-astro`.
Four files: `package.json`, `bun.lock`, `docs-site/package.json`, `docs-site/bun.lock`.
No application source changes.

This unit reviews and clears the existing pull request. It does not open a
replacement, and it does not merge.

## The follow-up commit landed

The review asked for an exact pin instead of a caret. Head `7c9479b57` has
`"hono": "4.13.8"` in root `overrides`, the caret removed, matching the
neighbouring exact pin on `@hono/node-server`. Root `bun.lock` carries the same
`4.13.8` in its overrides block and resolves `hono@4.13.8`. Manifest and lock agree.

## Actual impact, not advisory severity

The PR description groups the `hono` advisories under "Root proxy runtime". That is
accurate about which manifest changed and misleading about what is exposed.

`hono` is not a direct dependency. It arrives only through
`@modelcontextprotocol/sdk@1.30.0`, which declares `hono: ^4.11.4`. This repository
imports that SDK in exactly one file, `src/adapters/cursor/mcp-manager.ts`, and only
its **client** entrypoints: `client/index.js`, `client/stdio.js`, and
`client/streamableHttp.js`. Nothing under `src/`, `gui/src/`, or `scripts/` imports
`@modelcontextprotocol/sdk/server/*` or `@hono/node-server`.

All three `hono` advisories need the application to be running hono as a server:
`toSSG()` is the static-site generation helper, `parseBody()` parses an inbound
request body, and the query-parser differential is about inbound request URLs. The
proxy serves its own HTTP through `Bun.serve`. So no proxy request path reaches the
vulnerable code, and this half of the PR is dependency-graph hygiene that gets
`bun audit` to zero rather than a fix for a reachable proxy vulnerability.

The Critical is in the other half. `GHSA-26w7-cxv4-gfx2` is remote code execution
through Astro's AVIF image optimization, which runs during `astro build` and
`astro dev`. The exposed parties are contributor machines and the docs deploy
runner, and the input is images in the repository, so an attack needs a malicious
image committed first. Bounded, real, and worth fixing.

## Lockfile review

Reviewed statically; no install runs in this lane.

Every added `docs-site/bun.lock` entry is a registry package with a `sha512`
integrity hash. No `git+`, `http(s):`, `file:`, `workspace:`, or `link:` source
appears in any added line. The additions are exactly what an Astro 7.2.2 to 7.3.3
minor bump plus the `sharp`, `svgo`, `smol-toml` and `js-yaml` overrides produce:
refreshed `@astrojs/compiler-binding-*` and `@img/sharp-*` platform binaries, and
the transitive dependencies those versions declare.

Two things that look like new supply chain but are not. `@astrojs/markdown-satteri`
and the `@bruits/satteri-*` binaries are already in `dev`'s lockfile and only change
version. `find-proc` replaces `find-process`, dropping `ansi-styles`, `chalk`,
`color-convert`, `color-name`, and `loglevel`; that substitution is declared by
`astro@7.3.3` itself, not introduced by this pull request.

## The docs build is not covered by CI

This is the part worth separating out, and it does not resolve in this PR's favour.

`.github/workflows/ci.yml` contains no `docs-site` reference and builds no docs.
`deploy-docs.yml` triggers only on `push` to `main` under `docs-site/**`. So the
Astro minor bump has no pull-request build gate anywhere: a fully green exact-head
run on this PR is not evidence that the docs site still builds. The author's local
"449 pages" result is the only build evidence and is an unverifiable attestation.

The residual exposure is a broken docs build discovered at promotion to `main`
rather than at review. That fails the deploy instead of shipping a broken site, so
it is a delay rather than an outage, but it should be a conscious acceptance.
Adding a docs-build job is out of this lane's scope.

What CI *does* cover: `package.json` and `bun.lock` are both in the `changes` job's
`ci` allowlist, so the cross-platform suite is in scope for this head once it runs.

## What blocks exact-head evidence

Two independent gates, both maintainer actions, neither of which the contributor can
clear:

1. **`unsponsored_surface`.** `hygiene` and `enforce-target` both fail on it, and
   the PR carries `intake: hygiene-blocked`. `MAINTAINERS.md` requires explicit
   security review for dependency-installation surfaces; the gate wants a
   `maintainer-sponsored` label recording that the review happened.
2. **Fork workflow approval.** `Cross-platform CI`, `React Doctor`, and
   `Service lifecycle` are all sitting at `action_required` for this head. The
   repository uses `all_external_contributors` approval, and `ci.yml` documents that
   this approval — not the workflow's own routing — is the real boundary keeping
   untrusted code off runners. For a `pull_request` event `select-windows-runner`
   marks the run untrusted and pins GitHub-hosted runners, so approving does not
   expose a self-hosted runner. It does run the resolved packages' install hooks,
   which is why the lockfile review above had to come first.

The merge decision, and the decision to spend either of those gates, belongs to the
host session. This unit's output is the review and the evidence, not the merge.
