# 260725 — macOS menu bar companion app (`app/`)

**Unit:** `devlog/_plan/260725_macos_menubar_app/`
**Branch:** `feat/macos-app` (dedicated worktree `<worktree>/opencodex-macos-app`, based on `origin/dev` @ `dbed8c15`)
**Work class:** C4 (new shippable surface + release/CI wiring)
**Mode:** HOTL multi-cycle PABCD under `cxc-loop`. This document is the Phase-0 roadmap lock.

## Objective

Ship one maintainer-owned macOS menu bar companion for OpenCodex, replacing the two
competing community PRs (#387 Swift/SwiftUI, #421 Tauri/React) with a single
implementation that lives in `app/`, builds a real distributable `.app` bundle, and
attaches release assets through the existing release workflow.

## Why this unit exists

Two contributors independently built a menu bar companion within 24 hours of each
other. They cannot both merge: they occupy different directories (`apps/macos-menu-bar/`
vs `menubar/`), use different runtimes (Swift Package Manager vs Tauri v2 + Rust +
React), and use different transports to reach the proxy (`ocx` CLI subprocess vs HTTP
management API). Merging either as-is would (a) leave the other contributor's work
stranded, and (b) commit the repository to a runtime choice that was never audited
against the release pipeline the project already has.

The user's decision (2026-07-25) is to build the maintainer version, take the strongest
ideas from both, and close both PRs with credit.

## Constraints

| Constraint | Source | Consequence |
| --- | --- | --- |
| No `src/` proxy runtime changes | User scope | The app consumes only endpoints that already exist |
| No new management API endpoints | User scope | Any missing data must be derived from existing responses |
| Bun-native repo, no compile step for the proxy | `AGENTS.md` | The app cannot introduce a build step into the proxy's path |
| `bun run typecheck` / `test` / `privacy:scan` must stay green | `AGENTS.md` CI | `app/` must be excluded from the root `tsconfig` or be type-clean under it |
| Release flow is `scripts/release.ts` + `.github/workflows/release.yml` | `AGENTS.md` | macOS packaging attaches to the existing job graph, it does not fork it |
| Security-sensitive workflow edits require review | `AGENTS.md` | Workflow changes stay minimal, pinned, and least-privilege |
| Branch targets `dev` | `.github/workflows/enforce-pr-target.yml` | `feat/macos-app` is pushed, not PR'd, in this unit |

## Evidence gathered at P (live, 2026-07-25)

Local toolchain:

```text
xcode-select -p        -> /Library/Developer/CommandLineTools
swift --version        -> Apple Swift 6.4, target arm64-apple-macosx27.0.0
cargo                  -> present at ~/.cargo/bin/cargo
sw_vers                -> macOS 27.0 (26A5378n)
```

Universal-build probe (decisive — see `001_pr_survey.md` §4):

```text
swift build --arch arm64 --arch x86_64 -c release
  -> ld: symbol(s) not found for architecture x86_64
  -> warning: The x86_64 architecture is deprecated for your deployment target (macOS 27.0)
swift build --arch arm64 -c release
  -> Build complete! (10.39 sec)
```

Live proxy surface (`127.0.0.1:10100`, verified by `curl`): `/api/settings`,
`/api/startup-health`, `/api/usage`, `/api/provider-quotas`, `/api/providers`,
`/api/stop`. Full payload shapes in `002_api_surface.md`.

Audit-corrected surface facts (see `002` for evidence):

- `defaultProvider` is served by `/api/config`, **not** `/api/settings`.
- `/api/usage` supports only `7d` / `30d` / `all`; `24h` silently degrades to `30d`.
- `/api/stop` calls `stopServiceIfInstalled()` before responding, so nothing restarts the
  proxy and no start endpoint exists.
- `/api/logs` exists and would serve per-request activity; it is deliberately excluded
  from v1.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

Ordering is build-order, not effort: the transport contract must exist before the UI
can render truth, the UI must exist before actions can report their result, and the
bundle must exist before packaging can wrap it.

| Phase | Doc | Delivers | Independently verifiable by |
| --- | --- | --- | --- |
| 0 | `000`-`003` | Research, API inventory, design lock, this roadmap | Docs exist, audit passes |
| 1 | `010` | `app/` skeleton, proxy discovery, typed API client | `swift test` + `swift build` green |
| 2 | `020` | Menu bar item + popover UI, all states | Screenshot via `swift run` |
| 3 | `030` | Write actions on existing endpoints | Live action against running proxy |
| 4 | `040` | Universal build, packaging, CI/release wiring | `lipo -archs`, workflow syntax |
| 5 | `050` | Docs, PR closure, push | `gh pr view`, `git ls-remote` |

Phases 1-3 close on `swift test` / `swift build` / `swift run` — never on a bundle.
`scripts/build-macos-app.sh` and the first `.app` belong entirely to Phase 4, so no phase
is verified by a later phase's output.

## Scope boundary

**IN:** `app/**`, `scripts/build-macos-app.sh`, `scripts/package-macos-release.sh`,
`.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json` script
entries, `docs-site/` companion pages, this devlog unit.

**OUT:** `src/**` (proxy runtime), new API endpoints, Windows/Linux companions, merging
to `dev`/`main`, the six Haydern provider PRs, `gui/**` beyond required asset reuse.

## Accept criteria (mirrored into the goalplan)

1. `app/` produces a launchable `.app` bundle from a repo script (Phase 4).
2. Proxy discovery honours `~/.opencodex/runtime-port.json` and falls back to 10100.
3. The popover renders health, usage trend, quotas, and providers from live data.
   ("Activity" is the day-granular usage trend; per-request logs are out of scope for v1.)
4. Every state renders a meaningful surface; error, unauthorized, unreachable, and empty
   states each name a next action. `loading` is exempt — there is nothing to act on yet.
5. Write actions call only pre-existing endpoints, and the app never spawns a process.
6. Release build is universal (arm64 + x86_64) **in CI**; local arm64-only is accepted
   and documented (see `001` §4).
7. `bun run typecheck`, `bun run test`, `bun run privacy:scan` green.
8. No build artifacts committed, and no developer-absolute home path in **any file this
   unit adds or modifies** (including its `devlog/` docs, which `privacy:scan` excludes).
   Pre-existing paths in unrelated historical devlogs are out of scope.
9. PRs #387 and #421 closed with English maintainer comments crediting both authors, each
   written against the PR's head commit at the time of posting.
10. `feat/macos-app` pushed to origin.

## Terminal outcomes

`DONE` on all ten. `BLOCKED` only if no `.app` bundle can be produced after documented
attempts. `NEEDS_HUMAN` if a scope decision beyond the user's delegation appears.
