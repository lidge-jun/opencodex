# Cycle 7 - CLI runtime identity diagnostics

## Scope
- Surface the durable Bun runtime path in `ocx status` so Windows users can confirm whether opencodex is using bundled Bun or a fallback runtime.
- This is diagnostic-only and must not change runtime resolution semantics.

## Planned diff
- `src/cli.ts`: import or dynamically read `durableBunPath()` and print `Runtime: <path>` in `handleStatus()` near service/config diagnostics.
- `tests/cli-help.test.ts`: assert status output includes `Runtime:`.

## Acceptance
- `ocx status` still does not start the proxy.
- Runtime line is present and generated from the shared Bun runtime resolver.
- Tests/typecheck pass.

## Verification
- `bun test tests/cli-help.test.ts`
- `bun x tsc --noEmit`

## Commit
- Atomic commit: `fix(cli): show runtime path in status`
