# 80.13 — Bun Runtime Diagnostics / Mitigation Plan

## Problem

Windows reports are consistent with native runtime instability as well as timeout disconnects. GPT Pro found external evidence of a Bun 1.3.14 Windows/opencodex crash class, and this repo already contains a Windows streaming crash workaround comment in `src/server.ts`.

macOS stability does not disprove this; Bun's Windows stream/process behavior can diverge from macOS.

## Patch intent

Make Windows runtime identity visible and allow controlled mitigation without silently switching every user to a canary runtime.

## Proposed implementation

### 1. Runtime diagnostics

Record these in Windows service logs and status output:

- resolved Bun executable path;
- Bun version;
- whether bundled Bun or override Bun is used;
- CLI entrypoint path;
- opencodex version;
- platform/arch;
- config dir and `CODEX_HOME`.

### 2. Supported Bun override

Add a documented config/env override for the Bun executable used by service mode.

Candidate names to evaluate:

- `OPENCODEX_BUN_PATH`
- config field under service/runtime settings

Rules:

- only use override when path exists and appears executable;
- log override use clearly;
- fail closed or warn loudly if invalid;
- do not mutate installed package files.

### 3. Runtime bump decision

Do not silently bump Windows users to Bun canary without real Windows smoke.

Short-term release posture:

- expose diagnostics;
- expose override;
- document known Windows runtime crash suspicion;
- validate a fixed Bun version separately, then bump the dependency when stable.

## Tests

- Unit test runtime path resolver:
  - default bundled Bun path;
  - valid override;
  - invalid override behavior.
- Service script test:
  - logs Bun path/version command;
  - includes selected Bun path.
- Status test:
  - `ocx service status` or `ocx status` exposes enough runtime identity without leaking secrets.

## Manual Windows smoke

- Run service with bundled Bun.
- Run service with override Bun.
- Confirm logs show the selected runtime.
- If crash reproduction exists, compare bundled vs override runtime behavior.
