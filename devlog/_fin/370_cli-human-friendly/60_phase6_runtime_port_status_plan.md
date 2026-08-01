# Phase 6 - Runtime Selected Port Status Accuracy

Status: implementation plan for the third GPT Pro hardening PABCD cycle.

## Source

Parent plan: /Users/jun/Developer/new/700_projects/opencodex/devlog/370_cli-human-friendly/40_gptpro_hardening_followup_plan.md

GPT Pro finding: `ocx start` can choose a transient fallback port when the configured/preferred port is busy. Existing persistence rules intentionally avoid writing that random fallback to config, but `ocx status` and `ocx gui` still read config port, so they can point at the wrong URL while the proxy is actually running.

## Objective

Record the actual runtime listen port separately from config and teach status/gui to use it only when the PID file still points at the current running opencodex start process. Do not make transient fallback ports permanent config defaults.

## Current Flow

```text
ocx start
  -> chooseListenPort()
  -> startServer(selectedPort)
  -> writePid(process.pid)

ocx status
  -> read config.port
  -> readPid()
  -> health check config.port

ocx gui
  -> read config.port
  -> open http://localhost:<config.port>
```

If preferred port `10100` is busy and opencodex starts on `58195`, status/gui still use `10100` unless config persistence rules changed the config. Those rules intentionally do not persist random fallback ports.

## Files

Modify:

```path
/Users/jun/Developer/new/700_projects/opencodex/src/config.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts
/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/config.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts
```

## Planned Changes

### 1. Add runtime port metadata helpers

In `/Users/jun/Developer/new/700_projects/opencodex/src/config.ts` add:

```ts
export type RuntimePortState = { pid: number; port: number; hostname?: string };
export function getRuntimePortPath(): string;
export function writeRuntimePort(state: RuntimePortState): void;
export function readRuntimePort(expectedPid?: number): RuntimePortState | null;
export function removeRuntimePort(expectedPid?: number): void;
```

Behavior:

- file path: `join(getConfigDir(), "runtime-port.json")`;
- `writeRuntimePort()` creates config dir if missing and writes atomically with `0600` via existing `atomicWriteFile()`;
- `readRuntimePort(expectedPid)` returns null for missing, invalid JSON, unsafe pid/port, or pid mismatch;
- if `expectedPid` is omitted, it still validates shape but does not prove liveness;
- `removeRuntimePort(expectedPid)` mirrors `removePid(expectedPid)` semantics and should avoid deleting newer metadata from a different PID.

### 2. Write and clear metadata from lifecycle paths

In `/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts`:

- after `startServer(port)` and `writePid(process.pid)`, call `writeRuntimePort({ pid: process.pid, port, hostname: config.hostname })` using the selected runtime port;
- in the start cleanup handler, remove runtime metadata for the current pid;
- in `handleStop()`, remove metadata when the pid is stopped or when service stop succeeds;
- in uninstall cleanup, remove metadata with the stopped pid when available;
- keep existing config persistence behavior unchanged.

### 3. Use runtime metadata in status

In `/Users/jun/Developer/new/700_projects/opencodex/src/cli-status.ts`:

- after `readPid()`, call `readRuntimePort(pid ?? undefined)`;
- use `runtimePort.port`/`runtimePort.hostname` for health URL and dashboard URL when metadata exists;
- otherwise fall back to diagnostics config port/hostname;
- add JSON metadata under a narrow additive object, for example:

```ts
listen: {
  port: number;
  hostname: string | null;
  source: "runtime" | "config";
}
```

Acceptance consequence: `proxy.health.url`, `dashboard.url`, and human labels reflect runtime metadata when it is current.

### 4. Use runtime metadata in gui

In `/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts` `gui` case:

- read PID and runtime metadata;
- if PID/runtime metadata exists, open `http://localhost:<runtime port>`;
- otherwise keep current behavior: start if not running;
- after `gui` self-starts the proxy, re-read PID/runtime metadata before choosing the URL;
- if current metadata appears during the wait, open `http://localhost:<runtime port>`;
- only fall back to config port when no current metadata is available after the wait.

This keeps `gui` aligned with status without changing service or start behavior.

### 5. Regression tests

In `/Users/jun/Developer/new/700_projects/opencodex/tests/config.test.ts`:

- runtime metadata round trip validates pid/port;
- expected pid mismatch returns null;
- remove with wrong pid preserves file, remove with matching pid deletes it;
- invalid metadata returns null.

In `/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts`:

- add a pure helper seam in `cli-status.ts`, for example `selectListenTarget(config, pid, runtimePortState)`, so status port selection can be tested without faking an `ocx start` process command line;
- unit-test the helper with config `port: 10100`, pid `123`, runtime-port metadata `{ pid: 123, port: 58195 }`;
- the helper should choose `http://127.0.0.1:58195/healthz`, `dashboard.url` should be `http://localhost:58195/`, and `listen.source` should be `runtime`;
- stale runtime metadata for a different pid should be ignored and `listen.source` should be `config`;
- keep CLI smoke for normal `status --json`, but do not require `bun test` to fake `readPid()` with the current test process PID because `readPid()` correctly rejects non-`ocx start` processes.

## Acceptance Criteria

- `ocx start` records the selected listen port separately from config.
- Cleanup paths remove only metadata for the expected PID.
- `ocx status --json` prefers runtime metadata only when tied to the current PID.
- stale/mismatched runtime metadata is ignored.
- `ocx gui` opens the runtime port when metadata is current.
- config default port remains unchanged when fallback port is transient.

## Verification

Run:

```bash
bun test tests/cli-status-json.test.ts tests/config.test.ts tests/ports.test.ts
bun test tests/cli-status-json.test.ts tests/cli-help.test.ts
bun run typecheck
node bin/ocx.mjs status --json
```

Use Backend read-only verification before B->C.

## Commit

Expected commit:

```text
fix(cli): report runtime fallback port in status
```
