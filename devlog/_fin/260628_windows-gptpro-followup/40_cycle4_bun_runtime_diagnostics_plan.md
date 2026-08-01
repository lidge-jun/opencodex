# Cycle 4: Bun Runtime Override And Version Diagnostics

## Goal

Make Windows service/runtime investigations easier by exposing the exact Bun runtime opencodex will use, and by allowing a deliberate Bun binary override for emergency reproduction or mitigation.

## Scope

- MODIFY `src/bun-runtime.ts`:
  - Add an `OPENCODEX_BUN_PATH` override reader.
  - Accept the override only when it points to a real Bun binary by the existing size gate.
  - Keep fallback order: valid override -> bundled Bun -> `process.execPath`.
  - Add a small diagnostic helper that returns runtime path/source and version command metadata without spawning during import.
- MODIFY `src/cli.ts`:
  - Include Bun path/source in `ocx status` Runtime diagnostics.
  - Preserve existing status behavior and exit code.
- MODIFY `src/service.ts`:
  - Ensure the Windows wrapper logs the selected Bun path, and include override source when present if exposed by the helper.
- MODIFY tests:
  - Extend `tests/bun-runtime.test.ts` for valid/invalid override selection.
  - Extend `tests/cli-help.test.ts` status diagnostics expectations.
  - Extend `tests/service.test.ts` only if service log text changes.

## Non-goals

- Do not change install scripts or package manager dependency versions.
- Do not execute arbitrary Bun override paths during tests.
- Do not alter Codex shim semantics beyond reading the same durable Bun source.

## Verification

- `bun test tests/bun-runtime.test.ts tests/cli-help.test.ts tests/service.test.ts`
- `bun x tsc --noEmit`
