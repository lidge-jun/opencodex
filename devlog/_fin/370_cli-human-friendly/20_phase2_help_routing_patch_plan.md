# Phase 2 - Help Routing And Version Patch Plan

Status: patch plan only, no implementation in this cycle.

## Objective

Turn the Phase 1 help-surface findings into the first low-risk CLI UX implementation slice:

- add script-friendly version output;
- make help routing predictable;
- avoid accidental success for unsupported commands with `--help`;
- keep all lifecycle behavior unchanged.

This phase intentionally does not add `status --json`, `doctor`, `logs`, or lifecycle restart behavior. Those are larger public-contract decisions planned separately.

## Source Findings From Phase 1

Authoritative matrix:

```path
/Users/jun/Developer/new/700_projects/opencodex/devlog/370_cli-human-friendly/11_help_surface_matrix.md
```

Relevant findings:

- `ocx --version`, `ocx -v`, `ocx version`, and `node bin/ocx.mjs --version` currently exit 1 as unknown commands.
- `ocx <command> --help` and `ocx <command> -h` currently work for top-level commands.
- `ocx help <command>` prints top-level help instead of command-specific help.
- `ocx restart --help` and other unknown commands with help flags exit 0 and print top-level help, which makes unsupported commands look successful.
- `service remove` and `codex-shim remove` are implemented aliases but are omitted from current help strings.
- Top-level human help is compact and not grouped by workflow.

## Implementation Slice Boundary

### Included

- `--version`, `-v`, and `version` output.
- `ocx help <command>` routing.
- unknown-command help behavior.
- richer but still plain-text top-level help grouping.
- subcommand metadata table or equivalent local helper inside `src/cli.ts`.
- tests for command routing and no-mutation help behavior.
- docs-site updates for help/version semantics.

### Excluded

- No `status --json`.
- No `doctor`.
- No `logs`.
- No `restart`.
- No service/shim lifecycle behavior changes.
- No provider/auth/runtime implementation changes.

## Planned Files

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts`

Planned changes:

1. Add version printing before normal command dispatch.

   Desired behavior:

   ```text
   ocx --version
   ocx -v
   ocx version
   ```

   Output should be one line and stable, for example:

   ```text
   opencodex <package-version>
   ```

   Constraints:

   - no config load;
   - no network;
   - no proxy/service/shim mutation;
   - same behavior through `node bin/ocx.mjs --version`.

2. Introduce a command help registry.

   Candidate shape:

   ```ts
   type HelpEntry = {
     usage: string;
     summary: string;
     details?: string[];
   };
   ```

   Keep it local to `src/cli.ts` unless it grows beyond a small table.

3. Make help routing explicit.

   Desired behavior:

   ```text
   ocx <command> --help      -> command help, exit 0
   ocx <command> -h          -> command help, exit 0
   ocx help <command>        -> command help, exit 0
   ocx help                  -> top-level help, exit 0
   ocx <unknown> --help      -> "Unknown command: <unknown>" + top-level help, exit 1
   ```

4. Keep help flags side-effect free.

   Help routing must happen before calling mutating handlers:

   - `handleStart`
   - `handleStop`
   - `handleUninstall`
   - `handleEnsure`
   - `syncModelsToCodex`
   - `serviceCommand`
   - `installCodexShim`
   - `uninstallCodexShim`

5. Update help strings for implemented aliases.

   Include:

   - `ocx remove` as alias for `uninstall`;
   - `ocx service remove` as alias for `service uninstall`;
   - `ocx codex-shim remove` as alias for `codex-shim uninstall`.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/cli-help.test.ts`

Planned tests:

- `ocx --version`, `ocx -v`, and `ocx version` exit 0 and produce one line.
- `node bin/ocx.mjs --version` matches source CLI behavior.
- `ocx help start` matches or includes `Usage: ocx start`.
- `ocx help service` includes service usage.
- `ocx restart --help` exits 1 and says unknown command.
- Help flags on representative mutating commands do not mutate temp homes:
  - `ocx stop --help`
  - `ocx uninstall --help`
  - `ocx service uninstall --help`
  - `ocx codex-shim uninstall --help`

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/reference/cli.md`

Planned documentation:

- Document `ocx --help`, `ocx -h`, and `ocx help <command>`.
- Document `ocx --version`, `ocx -v`, and `ocx version`.
- State that help/version are side-effect free.
- Update service/shim alias tables to include `remove` if retained in implementation.

### OPTIONAL MODIFY `/Users/jun/Developer/new/700_projects/opencodex/README.md`

Only if top-level README command list becomes inconsistent after implementation. Keep README concise; detailed behavior belongs in docs-site.

## Acceptance Criteria

- Version commands exit 0 and print one line.
- `ocx help <known-command>` exits 0 and shows command-specific usage.
- `ocx <unknown> --help` does not exit 0.
- Help flags on mutating commands do not create, delete, start, or stop local state in test homes.
- Existing lifecycle behavior remains unchanged when commands are run without help flags.
- Docs match implemented behavior.

## Verification

```bash
bun test tests/cli-help.test.ts
bun run typecheck
node bin/ocx.mjs --version
node bin/ocx.mjs --help
```

## Risk Notes

- Reading package version must not introduce fragile JSON import behavior across Bun/Node launch paths.
- Unknown-command help behavior is a behavior change; tests must pin exit code and output.
- Richer help should remain plain text so scripts, terminals, and agent logs can all read it.

## Suggested Commit

```text
fix(cli): make help routing and version output predictable
```
