# Stable Codex Runtime Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or implement task-by-task with TDD.

**Goal:** One canonical Codex runtime resolver shared by sync, clamp, startup probes, and CLI diagnostics so OpenCodex never silently clamps against an older binary than the one users run.

**Architecture:** New `src/codex/runtime.ts` owns resolve/persist/diagnose. `bundled.ts` / `effort.ts` / `v2.ts` / sync logging / status / doctor / dashboard consume it. Persist selection in `getConfigDir()/codex-runtime.json`.

**Tech Stack:** TypeScript, existing `codexExecInvocation`, Bun tests.

## Global Constraints

- Selection order: environment → configured → shim → path → fallback
- Validate with `--version` (and reject missing/stale)
- Do not silently downgrade from a persisted valid runtime
- Keep global effort clamp; no routed-model exemption
- PR base: `dev`

---

### Task 1: Resolver + persistence (TDD)
- Create `src/codex/runtime.ts` + `tests/codex-runtime.test.ts`
- Types `CodexRuntimeSource`, `ResolvedCodexRuntime`, clamp diagnostic
- Persist/load configured runtime; reject invalid; warn on older fallback

### Task 2: Wire catalog + clamp + v2
- `loadBundledCodexCatalog` / `codexSupportedReasoningEfforts` / `codexFeaturesInvocation` use resolved runtime command
- Sync logs one clamp summary with `EffortClampDiagnostic`

### Task 3: status / doctor / dashboard
- `ocx status` runtime + clamp fields
- `ocx doctor` multi-install / stale / mismatch checks + optional `--fix-codex-runtime`
- Dashboard warning when clamp removed efforts (management API field)

### Task 4: Verify + PR to dev
- targeted tests, typecheck, open PR
