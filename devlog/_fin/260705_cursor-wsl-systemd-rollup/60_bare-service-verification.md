# Bare `ocx service` Verification

## Commands

- `bun test tests/service.test.ts tests/cli-help.test.ts`
  - Result: 35 pass, 0 fail.
- `bun run typecheck`
  - Result: pass.
- `cd docs-site && bun run build`
  - Result: pass, 46 pages built.
- `bun test`
  - Result: 1385 pass, 0 fail.
- `git diff --check`
  - Result: pass.

## Outcome

DONE: bare `ocx service` now defaults to the existing install/update/start service path, while explicit invalid service subcommands still fail with usage and `ocx service start` remains installed-service-only.
