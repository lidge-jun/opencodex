# Windows Compatibility GPT Pro Review Plan

## Goal

Submit the current `dev` branch state and Windows/cross-platform compatibility evidence to GPT Pro
for an external review.

## Repository State

- Local branch: `dev`
- Local/remote commit: `d3303bf2fcf795a7af3236b38719ad0c538e7ef5`
- GitHub dev URL: `https://github.com/lidge-jun/opencodex/tree/dev`

## Review Package

Create a zip containing:

- Relevant Windows/cross-platform devlogs:
  - `devlog/80_windows-codex-path-hardening/`
  - `devlog/150_cross-platform-ci-release-gate/`
  - `devlog/320_bun-bundled-npm-install/`
  - `devlog/90_service-tier-fast/`
  - `devlog/200_release-gate/`
- Relevant release/workflow files:
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
  - `.github/workflows/service-lifecycle.yml`
  - `package.json`
  - `bun.lock`
  - `bin/ocx.mjs`
  - `scripts/release.ts`
- Relevant Windows/service/runtime source and tests:
  - `src/bun-runtime.ts`
  - `src/codex-shim.ts`
  - `src/service.ts`
  - `src/cli.ts`
  - `src/update.ts`
  - `src/ports.ts`
  - `tests/bun-runtime.test.ts`
  - `tests/codex-shim.test.ts`
  - `tests/service.test.ts`
  - `tests/uninstall.test.ts`
  - `tests/ports.test.ts`

## GPT Pro Prompt

Ask GPT Pro to review Windows compatibility risks specifically:

- npm global install behavior on Windows without a separately-installed Bun.
- `bin/ocx.mjs`, package `bin`, and the local tracked `dist/bin/*` symlinks
  (not shipped in package `files`) as a Windows risk surface.
- Task Scheduler service install/uninstall behavior.
- Windows path, quoting, shell interpolation, symlink, and executable detection risks.
- CI coverage gaps versus real Windows user installs.
- Any release-blocking or post-release high-risk fixes.

## Execution

- Use `agbrowse --help` first to confirm web-ai usage.
- Send to ChatGPT/GPT Pro with the dev GitHub URL and zip attachment.
- If the GPT Pro session is long-running, register it as a durable `cli-jaw bgtask`.
- Do not change source code in this work-phase.
