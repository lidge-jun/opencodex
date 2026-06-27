# Phase 1 - Help and Version Foundation

## Objective

Make the top-level `ocx` entrypoint friendlier and script-safe by adding version flags and restructuring top-level help without changing runtime command behavior.

## Classification

C2 product slice:

- touches the public CLI contract;
- should be easy to verify with focused CLI tests and typecheck;
- does not touch auth, service lifecycle, config mutation, or server runtime.

## Planned Files

### MODIFY `src/cli.ts`

Planned changes:

- Add package version loading from the repository/package runtime metadata.
  - Do not use a JSON import unless `tsconfig.json` already supports it.
  - Preferred implementation: read and parse `package.json` through `node:fs` / `node:path` from the CLI module, with a narrow fallback string if the file is unavailable in an unusual packaged environment.
- Support these version forms:
  - `ocx --version`
  - `ocx -v`
  - `ocx version`
- Keep version output one line:

```text
opencodex 2.5.6
```

- Replace the current `printUsage()` body with grouped help text:
  - title
  - usage
  - quick start
  - daily commands
  - diagnostics and recovery
  - auth and providers
  - service/autostart
  - global options
  - examples
- Keep output plain text and ASCII-compatible except existing product name punctuation.

### MODIFY `tests/cli-help.test.ts`

Planned changes:

- Add tests for `--version`, `-v`, and `version`.
- Assert version commands:
  - exit 0;
  - print package version;
  - do not create or modify Codex config files.
- Update top-level help assertions to check the new sections.

### MODIFY `README.md`, `README.ko.md`, `README.zh-CN.md`

Planned changes:

- Update CLI command list to mention `ocx --version` / `ocx -v`.
- Keep README concise; deep CLI UX documentation belongs in docs-site.

### MODIFY `docs-site/src/content/docs/reference/cli.md`

Planned changes:

- Document top-level help and version behavior.
- Add a short "first commands" block that mirrors top-level help.

## Acceptance Criteria

- `ocx -v`, `ocx --version`, and `ocx version` exit 0.
- Version commands are read-only.
- `ocx help`, `ocx --help`, and `ocx -h` include quick start and troubleshooting sections.
- Existing command behavior remains unchanged.
- Focused tests and typecheck pass.

## Verification

```bash
bun test tests/cli-help.test.ts
bun run typecheck
```

## Suggested Commit

```text
feat(cli): add friendly help and version output
```
