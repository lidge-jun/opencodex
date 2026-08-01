# Phase 5 - Read-only Status Config Diagnostics

Status: implementation plan for the second GPT Pro hardening PABCD cycle.

## Source

Parent plan: /Users/jun/Developer/new/700_projects/opencodex/devlog/370_cli-human-friendly/40_gptpro_hardening_followup_plan.md

GPT Pro finding: `ocx status --json` is documented as diagnostics, but the status collection path currently calls `loadConfig()`. That helper is intentionally mutating for normal runtime use: it hardens file modes, repairs partially invalid configs, and backs up malformed configs.

## Objective

Make `ocx status` and `ocx status --json` use a diagnostics-only config reader so status remains read-only even when the config file is malformed. Keep normal `loadConfig()` behavior unchanged for runtime commands.

## Current Problem

Current flow:

```text
src/cli.ts handleStatus()
  -> src/cli-status.ts collectStatus()
    -> src/config.ts loadConfig()
      -> chmod config dir/config/auth
      -> may warn to stderr
      -> may create config.json.invalid-*
      -> may repair invalid partial config
```

That means a user or agent can run `ocx status --json` expecting inspection-only output, but malformed config can produce stderr and filesystem changes before JSON is printed.

## Files

Modify:

```path
/Users/jun/Developer/new/700_projects/opencodex/src/config.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/config.test.ts
```

## Planned Changes

### 1. Add a non-mutating diagnostics config reader

In `/Users/jun/Developer/new/700_projects/opencodex/src/config.ts` add exported types/functions similar to:

```ts
export type ConfigDiagnostics = {
  config: OcxConfig;
  source: "default" | "file" | "fallback";
  error: string | null;
};

export function readConfigDiagnostics(): ConfigDiagnostics;
```

Behavior:

- never calls `hardenConfigDir()`;
- never calls `hardenExistingSecret()`;
- never calls `warnConfigRepaired()`;
- never calls `warnAndBackupInvalidConfig()`;
- never calls `saveConfig()` or `backupInvalidConfig()`;
- if config file is missing, returns default config with `source: "default"` and `error: null`;
- if config file parses and validates, returns parsed config with `source: "file"`;
- if config file is invalid JSON or schema-invalid after the same safe default merge attempt used by `loadConfig()`, returns default config with `source: "fallback"` and a bounded, non-secret summary in `error`.
- `error` must never reuse raw `Error.message`, raw config text, or zod messages that might include user-provided values. It must use fixed categories and safe field paths only, for example:

```text
invalid_json
schema_invalid: defaultProvider, providers.cursor
```

### 2. Route status through diagnostics reader

In `/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts`:

- replace `loadConfig()` import/use with `readConfigDiagnostics()`;
- use `diagnostics.config` for port, hostname, autostart, and defaultProvider;
- add JSON fields under a narrow config diagnostics object, for example:

```ts
config: {
  source: "default" | "file" | "fallback";
  error: string | null;
}
```

Human status may print a short warning line only when the diagnostics reader returned `error`, but `status --json` must remain parseable JSON with no stderr.

### 3. Regression tests

In `/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts` add coverage:

- malformed `config.json` + `ocx status --json` exits 0;
- stdout is parseable JSON;
- stderr is empty;
- no `config.json.invalid-*` backup is created;
- directory file list is unchanged;
- JSON contains `config.source === "fallback"` and a string `config.error`.
- JSON error summary does not include raw malformed config content or secret-looking values.

In `/Users/jun/Developer/new/700_projects/opencodex/tests/config.test.ts` add direct unit coverage:

- `readConfigDiagnostics()` returns parsed config for valid file;
- missing file returns default without creating config dir/files;
- malformed file returns fallback/default without creating invalid backups.

## Acceptance Criteria

- `ocx status --json` on malformed config still prints parseable JSON and exits 0.
- `ocx status --json` writes no stderr on malformed config.
- `ocx status --json` creates no `config.json.invalid-*` file.
- `status` diagnostics do not chmod/harden as part of config reading; tests prove no backup/files are created, and implementation proves no harden helper calls in diagnostics reader.
- `config.error` uses only fixed categories plus safe field paths; raw parser messages, raw config content, and secret-looking values are not exposed.
- Existing `loadConfig()` mutating repair/backup behavior remains unchanged and covered by existing config tests.

## Verification

Run:

```bash
bun test tests/cli-status-json.test.ts tests/config.test.ts
bun test tests/cli-status-json.test.ts tests/cli-help.test.ts
bun run typecheck
node bin/ocx.mjs status --json
```

Use Backend read-only verification before B->C.

## Commit

Expected commit:

```text
fix(cli): keep status diagnostics read-only
```
