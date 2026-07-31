# Phase 4+ - GPT Pro CLI Hardening Follow-up

Status: implementation plan for post-audit hardening.

## Source

After pushing `dev`, GPT Pro audited the recent CLI UX changes through agbrowse:

- GitHub branch: `https://github.com/lidge-jun/opencodex/tree/dev`
- ChatGPT conversation: `https://chatgpt.com/c/6a3ff217-2d1c-83ee-8f59-b56d028f8259`

GPT Pro verdict: no blocking release-stopper, but several hardening gaps should be fixed.

## Objective

Harden the CLI UX changes without expanding scope into new product features. Keep lifecycle behavior stable, add focused regression coverage, and continue using one PABCD cycle per work-phase.

## Findings To Address

### Medium A - `status --json` read-only edge cases

Current `collectStatus()` calls `loadConfig()`. `loadConfig()` can:

- chmod config/auth paths;
- warn to stderr;
- back up malformed config to `config.json.invalid-*`;
- merge defaults into partially invalid config.

That conflicts with `status --json` being documented as read-only diagnostics. This needs either a diagnostics-only config reader or explicit rewording/tests. The desired behavior is a diagnostics-only reader.

### Medium B - fallback runtime port visibility

`ocx start` can choose a free fallback port if the configured/preferred port is busy, but `status` and `gui` derive URLs from config. When fallback is not persisted, status can check the wrong port.

This needs a runtime-selected-port source of truth. It must not blindly make random fallback ports permanent config defaults unless that UX is intentional.

### Low - parser and usage gaps

- `ocx status --json --yaml` should fail instead of ignoring extra args.
- `ocx start --port 123abc` should fail instead of accepting `123`.
- unknown `start` args should fail.
- `service` / `codex-shim` invalid usage strings should include `remove`.

### Low - service diagnostics can block

`serviceStatusSummary()` can call platform service managers without explicit timeouts. This is real but broader and platform-sensitive. Plan after the smaller parser/config/port fixes.

## Work-Phase Map

### Phase 4 - Small parser and usage hardening

Scope:

- strict `status` args: only `status` and `status --json`;
- strict `start` args: only no args or `--port <digits>`;
- reject partial numeric ports;
- include `remove` in invalid `service` and `codex-shim` usage strings;
- focused tests.

Files:

```path
/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts
/Users/jun/Developer/new/700_projects/opencodex/src/service.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-help.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts
```

Acceptance:

- `ocx status --json --yaml` exits 1 with usage.
- `ocx start --port 123abc --help` still prints help, but `ocx start --port 123abc` exits 1.
- `ocx start --bad` exits 1.
- invalid service/shim subcommands mention `remove`.
- existing help/status tests pass.

### Phase 5 - Read-only status config reader

Scope:

- add a diagnostics-only config reader that does not chmod, repair, or back up invalid config;
- `status --json` uses it;
- human `status` can use the same reader if it preserves human output;
- tests for malformed config and file list/permission preservation.

Files:

```path
/Users/jun/Developer/new/700_projects/opencodex/src/config.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/config.test.ts
```

Acceptance:

- `ocx status --json` on malformed config still prints parseable JSON.
- no `config.json.invalid-*` is created by status diagnostics.
- no chmod/harden behavior is triggered by status diagnostics.
- output includes a safe warning/error field if config could not be parsed.

### Phase 6 - Runtime selected-port status accuracy

Scope:

- record the actual selected runtime port when start chooses a fallback;
- make status/JSON prefer that running-port source when PID is current;
- avoid permanently changing config default to random fallback ports;
- tests for stale/missing runtime port metadata.

Files:

```path
/Users/jun/Developer/new/700_projects/opencodex/src/config.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts
```

Acceptance:

- status JSON health URL uses the runtime selected port when current PID metadata says the proxy is running there.
- stale metadata is ignored.
- config default port remains stable unless existing config persistence rules intentionally update it.

### Phase 7 - Service diagnostics timeout planning

Scope:

- research timeout behavior of launchctl/systemctl/schtasks probes in current service helpers;
- decide whether to add timeouts or keep as a documented residual risk;
- if implemented, add narrow tests around command construction or helper timeout behavior.

This is separated because it is platform-sensitive and can touch service behavior beyond CLI parser/status UX.

## Verification Baseline

Every implementation phase must run:

```bash
bun test tests/cli-status-json.test.ts tests/cli-help.test.ts
bun run typecheck
node bin/ocx.mjs --version
node bin/ocx.mjs status --json
```

Use employee verification before each B->C transition.

## Commit Plan

- `fix(cli): tighten status and start argument parsing`
- `fix(cli): keep status diagnostics read-only`
- `fix(cli): report runtime fallback port in status`

Each commit must be independently reversible.
