# 020 — Launcher handoff and command-selection diagnostics (wp2)

Desktop owns the terminal `ocx` command through wp1's PATH installation. This work makes a current package launcher delegate to the recorded Desktop CLI before it repairs its package or searches for Bun, so older terminal sessions can use the bundled CLI too. It preserves package update/removal and inspection behavior, regenerates the pre-dotenv launch proof, and adds read-only PATH observations to status and doctor. Diagnostics distinguish configured Desktop intent, the first executable on the current process PATH, and parent-shell selection that this process cannot observe.

## Authority, execution boundary and dependency

| Item | Contract |
| --- | --- |
| Archetype / trigger | Bounded satisfy-spec integration work, delegated from 000 wp2 after the Desktop/PATH audit. Parent owns FSM, goals, loop, consultation and review. |
| Goal | Implement A7, A8 and the TS portion of A10 as disposed in 002; Dispositions override the architect proposal. |
| Prerequisite | wp1/010 creates the authoritative record and owned shim. The minimal reader contract below must be reconciled with 010 before implementation. |
| Stop | This planning worker returns this one document; no code edits, git branch mutations, commits, child dispatch or goal/FSM operations. |
| Verifiers | Actual planning-time results and target coverage are recorded below. Newly proposed tests run only after creation. |
| Artifact | This 020 document; 001 is investigation evidence, 002 is decision authority, 010 owns the writer, 030 owns delivery. |
| Outcomes | Plan ready for parent's audit; implementation remains unverified. Contract mismatch or security/provenance concern goes to parent. |
| Escalation | A4 schema change; L1 rebase changes a shared contract; A11 review failure; Windows native selection conflict. |
| Resource boundary | Local validation stays minimal. No full test suite in this planning task. No user-machine installation or PATH writes. |

All source line references below describe **68c9d354574ed240c17805493409f8c589682b91**, the audit's origin/dev snapshot. Local HEAD is that commit; the moving origin/dev ref was already `8ad91f4c03` when checked. Resolve implementation by function anchors and rebase, never by these line numbers alone.

| Scope | IN | OUT |
| --- | --- | --- |
| A7 | Fixed-record reader; validated target; async handoff; regenerated proof; command exceptions; probe bypass | Record writes, PATH/rc/registry writes, bundle discovery, resource copying, service/runtime authority |
| A8 | PATH/PATHEXT candidate observation; status `cliCommand`; one human line; doctor section | Executing candidates, aliases/functions, shell cache introspection, changing Codex runtime selection |
| A10 TS | Two CLI test files and both layout registrations; affected owning-doc diffs and public text | Rust/UI tests (010), CI/release changes, approval/merge (030) |
| Shared source | Thin hooks in launcher, status, doctor and managing-cli | `src/cli/index.ts` (1976 lines), other worker's plan files |

## Source evidence and exact file map

| Baseline evidence | Function / anchor | Consequence |
| --- | --- | --- |
| `bin/ocx.mjs:951–963` | `updateHelpRequested`, `codexCliUpdateInspection` | Insert only after both existing classification blocks. |
| `bin/ocx.mjs:964–996` | mise update, `runNpmSelfUpdate`, `bootRestoreProbe`, `resolveBun` | Handoff precedes these operations; exceptions still reach them. |
| `bin/ocx.mjs:1018–1074` | pre-Bun slot snapshot and launch-context generation | Wrap the existing body in one factory, reuse for both launch paths; do not trust inherited context. |
| `bin/ocx.mjs:1075–1120` | async child, `FORWARDED`, `clearHandlers`, error/exit listeners | Reproduce asynchronous signal forwarding and exit mirroring for Desktop. Keep the Bun child path intact. |
| `src/cli/launcher-context.ts:54–123` | `initializeNodeLauncherContext` | Consumer requires exactly one argv proof and matching version-1 JSON, removes the proof and environment context. |
| `src/cli/claude.ts:65–77,630` | `deleteUntrustedAnthropicSlots`, `buildNativeClaudeEnv` | The handoff test must reach the real Claude consumer, not merely assert a JSON key. |
| `src/service/managing-cli.ts:62–85` | `probeVersionOnce` | Probe an actual selected package executable by suppressing handoff in its child environment. |
| `src/cli/status.ts:107,220,682,870–937` | `CliStatusJson`, `CliStatusView`, `collectStatus` | Add separate command diagnostics, never repurpose `paths.runtime` or `codexRuntime`. |
| `src/cli/index.ts:1693–1730` | `handleStatus` | Existing renderer emits `status.healthLabel`; JSON emits only `status.json`. A view-only extra line avoids editing the root dispatcher. |
| `src/cli/doctor.ts:94–112,1309–1325,1388` | `OAuthDoctorCheck`, `recordDoctorFailure`, `runDoctor` | Direct section printing is the current registration pattern. Put a separate section immediately after Paths, away from L1's restart-safety edits. |
| `scripts/file-size-ratchet.ts:3,145,182,207` | `THRESHOLD`, `scanRepo`, `updateBaseline`, CLI | New files must be below 2000 lines; existing recorded caps never rise. |
| `structure/AGENTS.md:27–35` | Layout rules | Structure docs have their independent 600-line cap; new source references need staging before the parent's structure gate. |
| `scripts/test-layout/layout.json:1298–1299`; `tests/fixtures/test-layout-expected.json:779` | `explicit`, independent expected roster | Register both new basenames as `cli`; regex placement alone is insufficient. |

| Exact repository path | Change | Changed functions / content |
| --- | --- | --- |
| `src/lib/desktop-cli-record.mjs` | NEW | `desktopCliRecordPath`, `readDesktopCliRecord` |
| `src/lib/desktop-cli-record.d.mts` | NEW | Reader DTO and options |
| `src/lib/desktop-cli-handoff.mjs` | NEW | `desktopHandoffExcluded`, `planDesktopCliHandoff`, `runDesktopCliHandoff` |
| `src/lib/desktop-cli-handoff.d.mts` | NEW | Plan, exit and dependency declarations |
| `src/cli/cli-path-diagnostics.ts` | NEW | `collectCliPathDiagnostics`, `formatCliCommandLine`, `formatCliStatusHealthLabel`, `cliCommandDoctorChecks` |
| `bin/ocx.mjs` | MODIFY | Imports; `createNodeLaunchContext` extracted from existing top-level snapshot; new pre-update handoff block; Bun argv proof normalization |
| `src/service/managing-cli.ts` | MODIFY | `probeVersionOnce` environment only |
| `src/cli/status.ts` | MODIFY | `CliStatusJson`, `collectStatus` |
| `src/cli/doctor.ts` | MODIFY | `runDoctor` section registration |
| `tests/cli/ocx-launcher-desktop-handoff.test.ts` | NEW | Reader/plan/spawn/proof/probe/launcher behavior tests |
| `tests/cli/cli-path-diagnostics.test.ts` | NEW | Deterministic POSIX/Windows PATH fixtures and view tests |
| `scripts/test-layout/layout.json` | MODIFY | `explicit` two entries |
| `tests/fixtures/test-layout-expected.json` | MODIFY | Two independent entries |
| `structure/runtime.md` | MODIFY | One entrypoint-table row replaced with one row |
| `structure/cli-management.md` | MODIFY | New command-selection contract section |
| `structure/ops/service-and-sidecars.md` | MODIFY | Internal version-probe bypass paragraph |
| `docs-site/src/content/docs/getting-started/installation.md` | MODIFY | Desktop command paragraph |
| `docs-site/src/content/docs/reference/cli.md` | MODIFY | Command-selection diagnostics paragraph |

030 owns the desktop guide en/ko and translation synchronization. The two public-text changes below are supplied here for its coordinated application; do not have two workers independently edit the same paragraphs. New `.mjs` files ship through `package.json:18–20` (`files` includes `src`); no package whitelist change is needed.

## A4 consumer contract: reader only

010 is final writer authority. This reader consumes only `version: 1`, `enabled`, and (when enabled) `bundle.platform` plus `bundle.cliExecutable`. It does not require or expose ownerId, installId, generation, hashes, journal payloads, bundle version or registry/rc details. Additional fields are tolerated. `pending` absent/null means settled; a present non-null pending operation is reported as `record-pending` and cannot select a target. `enabled:false` can be a small tombstone with no bundle. No new persistent fields are introduced by wp2.

The fixed record is `~/.opencodex-desktop/cli.json` on POSIX and `%USERPROFILE%\.opencodex-desktop\cli.json` on Windows. The reader bounds descriptor reads to 64 KiB plus one sentinel byte and validates a regular file, JSON shape, platform and an absolute target. **No `OPENCODEX_DESKTOP_CLI_RECORD` environment override**: an injected `recordPath`/`home` option is sufficient for unit tests; subprocess tests use an isolated HOME and USERPROFILE. This avoids a second public runtime selector and avoids a project dotenv directing Bun-side diagnostics to a different arbitrary record. The record remains same-user configuration, not executable authenticity evidence.

Malformed/unreadable/pending records cause a fixed-code launcher error. Missing record or disabled intent resumes the ordinary package path. After a valid target is selected, only its actual ENOENT resumes the package path. EACCES, ELOOP, ENOTDIR, non-file, relative path, self target, and other spawn failures terminate with an error. No search for another Desktop install occurs.

### NEW `src/lib/desktop-cli-record.mjs` (complete)

```js
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DESKTOP_CLI_RECORD_MAX_BYTES = 64 * 1024;

export function desktopCliRecordPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE || homedir() : homedir());
  return (platform === "win32" ? win32 : posix).join(home, ".opencodex-desktop", "cli.json");
}

export function readDesktopCliRecord(options = {}) {
  const platform = options.platform ?? process.platform;
  const path = options.recordPath ?? desktopCliRecordPath(options);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const info = fstatSync(fd);
    if (!info.isFile()) return { state: "invalid", path, issue: "record-invalid" };
    if (info.size > DESKTOP_CLI_RECORD_MAX_BYTES) {
      return { state: "invalid", path, issue: "record-too-large" };
    }
    const bytes = Buffer.alloc(DESKTOP_CLI_RECORD_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > DESKTOP_CLI_RECORD_MAX_BYTES) {
      return { state: "invalid", path, issue: "record-too-large" };
    }
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))); }
    catch { return { state: "invalid", path, issue: "record-invalid" }; }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.version !== 1 || typeof value.enabled !== "boolean") {
      return { state: "invalid", path, issue: "record-invalid" };
    }
    if (!value.enabled) return { state: "disabled", path };
    if (value.pending != null) return { state: "invalid", path, issue: "record-pending" };
    const bundle = value.bundle;
    const api = platform === "win32" ? win32 : posix;
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)
      || bundle.platform !== platform || typeof bundle.cliExecutable !== "string"
      || bundle.cliExecutable.length > 32 * 1024 || !api.isAbsolute(bundle.cliExecutable)
      || /[\x00\r\n]/.test(bundle.cliExecutable)) {
      return { state: "invalid", path, issue: "record-invalid" };
    }
    return { state: "ready", path, record: {
      version: 1, enabled: true,
      bundle: { platform, cliExecutable: bundle.cliExecutable },
    } };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { state: "missing", path }
      : { state: "unreadable", path, issue: "record-unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
```

### NEW `src/lib/desktop-cli-record.d.mts` (complete)

```ts
export const DESKTOP_CLI_RECORD_MAX_BYTES: number;
export type DesktopCliRecord = Readonly<{
  version: 1;
  enabled: true;
  bundle: Readonly<{ platform: NodeJS.Platform; cliExecutable: string }>;
}>;
export type DesktopCliRecordIssue = "record-invalid" | "record-too-large" | "record-pending" | "record-unreadable";
export type DesktopCliRecordRead =
  | { state: "missing" | "disabled"; path: string }
  | { state: "ready"; path: string; record: DesktopCliRecord }
  | { state: "invalid" | "unreadable"; path: string; issue: DesktopCliRecordIssue };
export type DesktopCliRecordOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  recordPath?: string;
};
export function desktopCliRecordPath(options?: DesktopCliRecordOptions): string;
export function readDesktopCliRecord(options?: DesktopCliRecordOptions): DesktopCliRecordRead;
```

### NEW `src/lib/desktop-cli-handoff.mjs` (complete)

```js
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readDesktopCliRecord } from "./desktop-cli-record.mjs";
import { isCodexCliUpdateInspectionArgv } from "../update/codex-cli-update-launch-policy.mjs";

const PROOF_PREFIX = "--ocx-internal-launch-proof=";

export function desktopHandoffExcluded(argv, env = process.env) {
  const args = argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  return env.OCX_NO_DESKTOP_HANDOFF === "1"
    || ["update", "uninstall", "remove"].includes(args[0])
    || (args[0] ?? "").startsWith("__")
    || isCodexCliUpdateInspectionArgv(["node", "ocx.mjs", ...args]);
}

export function planDesktopCliHandoff(input = {}, deps = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  if (desktopHandoffExcluded(argv, env)) return { kind: "continue", reason: "excluded" };
  const read = input.recordRead ?? readDesktopCliRecord({ env, platform: input.platform });
  if (read.state === "missing" || read.state === "disabled") {
    return { kind: "continue", reason: read.state };
  }
  if (read.state !== "ready") return { kind: "error", issue: read.issue };
  const platform = input.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const target = read.record.bundle.cliExecutable;
  if (!api.isAbsolute(target)) return { kind: "error", issue: "target-invalid" };
  const stat = deps.stat ?? statSync;
  const access = deps.access ?? accessSync;
  const realpath = deps.realpath ?? realpathSync;
  try {
    if (!stat(target).isFile()) return { kind: "error", issue: "target-invalid" };
    access(target, platform === "win32" ? constants.F_OK : constants.X_OK);
    const physical = realpath(target);
    const key = path => platform === "win32" ? path.toLowerCase() : path;
    for (const self of input.selfPaths ?? [process.argv[1], process.execPath]) {
      if (!self) continue;
      let own;
      try { own = realpath(self); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (key(own) === key(physical)) return { kind: "error", issue: "target-self" };
    }
    return { kind: "handoff", target: physical };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "continue", reason: "target-missing" }
      : { kind: "error", issue: "target-unusable" };
  }
}

export function runDesktopCliHandoff(plan, launch, deps = {}) {
  const spawnChild = deps.spawn ?? spawn;
  const parent = deps.parent ?? process;
  const platform = deps.platform ?? process.platform;
  const argv = launch.argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  const env = { ...launch.env, OCX_NO_DESKTOP_HANDOFF: "1", OCX_NODE_LAUNCH_CONTEXT: launch.context };
  delete env.OCX_BUN_RUNTIME_SOURCE;
  delete env.OCX_BUN_RUNTIME_PATH;
  return new Promise(resolveExit => {
    let child;
    try {
      child = spawnChild(plan.target, [`${PROOF_PREFIX}${launch.proof}`, ...argv], {
        stdio: "inherit", shell: false, windowsHide: true, env,
      });
    } catch (error) {
      resolveExit(error?.code === "ENOENT" ? { kind: "continue" } : { kind: "error", issue: "spawn-failed" });
      return;
    }
    const forwarded = platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = forwarded.map(signal => {
      const handler = () => { try { child.kill(signal); } catch { /* child already exited */ } };
      parent.on(signal, handler);
      return [signal, handler];
    });
    const clear = () => { for (const [signal, handler] of handlers) parent.removeListener(signal, handler); };
    let done = false;
    const finish = result => { if (done) return; done = true; clear(); resolveExit(result); };
    child.once("error", error => finish(error?.code === "ENOENT"
      ? { kind: "continue" } : { kind: "error", issue: "spawn-failed" }));
    child.once("exit", (code, signal) => finish({ kind: "exit", code: code ?? 1, signal }));
  });
}
```

### NEW `src/lib/desktop-cli-handoff.d.mts` (complete)

```ts
import type { spawn } from "node:child_process";
import type { accessSync, statSync } from "node:fs";
import type { DesktopCliRecordRead, DesktopCliRecordIssue } from "./desktop-cli-record.mjs";
export type DesktopHandoffIssue = DesktopCliRecordIssue | "target-invalid" | "target-self" | "target-unusable" | "spawn-failed";
export type DesktopCliHandoffPlan =
  | { kind: "continue"; reason: "excluded" | "missing" | "disabled" | "target-missing" }
  | { kind: "error"; issue: DesktopHandoffIssue }
  | { kind: "handoff"; target: string };
export type DesktopCliHandoffExit =
  | { kind: "continue" }
  | { kind: "error"; issue: "spawn-failed" }
  | { kind: "exit"; code: number; signal: NodeJS.Signals | null };
export function desktopHandoffExcluded(argv: string[], env?: NodeJS.ProcessEnv): boolean;
export function planDesktopCliHandoff(input?: {
  argv?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  recordRead?: DesktopCliRecordRead; selfPaths?: (string | undefined)[];
}, deps?: { stat?: typeof statSync; access?: typeof accessSync; realpath?: (path: string) => string }): DesktopCliHandoffPlan;
export function runDesktopCliHandoff(plan: Extract<DesktopCliHandoffPlan, { kind: "handoff" }>, launch: {
  argv: string[]; env: NodeJS.ProcessEnv; proof: string; context: string;
}, deps?: { spawn?: typeof spawn; parent?: Pick<NodeJS.Process, "on" | "removeListener">; platform?: NodeJS.Platform }): Promise<DesktopCliHandoffExit>;
```

`realpathSync`'s overloaded declaration is deliberately narrowed to the string call used here. `selfPaths` includes both the launcher module and executing binary. Selected-target races are still possible between access/realpath and spawn; the spawn result is authoritative. Windows checks existence/regular-file and lets CreateProcess decide executability; POSIX checks X_OK first.

## Observe-only diagnostics

`pathFirst` is the first runnable PATH candidate, never a claim about aliases/functions or shell caches. POSIX empty PATH elements mean cwd; relative elements resolve against cwd. Unset PATH has no observed candidates. Windows checks PATHEXT in declared order, case-insensitively, with an extensionless candidate last; surrounding directory quotes are removed. A separate `currentDirectoryCandidate` observes cmd's possible cwd override and never changes `pathFirst`. This distinction applies even when PowerShell's command-selection rules differ.

Expected executable is the fixed owned POSIX shim `~/.opencodex-desktop/bin/ocx`, or Windows's recorded bundled `ocx.exe`. An npm executable first on PATH remains an issue even if that launcher later hands off successfully. Missing/unusable target, missing shim, incomplete record and scan errors remain visible. No `which`, `where`, subprocess version probe or source of shell startup scripts is used.

### NEW `src/cli/cli-path-diagnostics.ts` (complete)

```ts
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { readDesktopCliRecord, type DesktopCliRecordRead, type DesktopCliRecordIssue } from "../lib/desktop-cli-record.mjs";
import { redactUserPath } from "../lib/redact";

export type CliCommandIssue = DesktopCliRecordIssue
  | "desktop-target-missing" | "desktop-target-unusable"
  | "expected-command-missing" | "expected-command-unusable"
  | "path-missing" | "path-first-not-desktop" | "path-unreadable"
  | "path-scan-truncated" | "windows-current-directory-shadow";
export type CliPathCandidate = {
  path: string; realpath: string; pathIndex: number; extension: string;
};
export type CliPathDiagnostics = {
  configured: boolean;
  recordState: DesktopCliRecordRead["state"];
  expectedExecutable: string | null;
  handoffTarget: string | null;
  candidates: CliPathCandidate[];
  pathFirst: CliPathCandidate | null;
  desktopFirstOnPath: boolean | null;
  currentDirectoryCandidate: CliPathCandidate | null;
  shellResolution: "unobserved";
  issues: CliCommandIssue[];
};
export type CliPathObservation =
  | { kind: "usable"; realpath: string }
  | { kind: "missing" | "unusable" | "unreadable" };
export type CliPathDiagnosticOptions = {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; cwd?: string; home?: string;
  recordRead?: DesktopCliRecordRead;
  observe?: (path: string) => CliPathObservation;
};

export function collectCliPathDiagnostics(options: CliPathDiagnosticOptions = {}): CliPathDiagnostics {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = platform === "win32" ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE || homedir() : homedir());
  const read = options.recordRead ?? readDesktopCliRecord({ platform, env, home });
  const configured = read.state === "ready";
  const target = configured && read.state === "ready" ? read.record.bundle.cliExecutable : null;
  const expected = configured ? (platform === "win32" ? target : api.join(home, ".opencodex-desktop", "bin", "ocx")) : null;
  const issues: CliCommandIssue[] = [];
  const add = (issue: CliCommandIssue): void => { if (!issues.includes(issue)) issues.push(issue); };
  if (read.state === "invalid" || read.state === "unreadable") add(read.issue);
  const observe = options.observe ?? ((path: string): CliPathObservation => {
    try {
      if (!statSync(path).isFile()) return { kind: "unusable" };
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return { kind: "usable", realpath: realpathSync(path) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "EACCES" ? "unusable" : "unreadable" };
    }
  });
  const key = (path: string): string => platform === "win32" ? path.toLowerCase() : path;
  const same = (a: string, b: string): boolean => key(a) === key(b);
  const envValue = (name: string): string | undefined => platform === "win32"
    ? env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name] : env[name];
  const path = envValue("PATH");
  const rawExtensions = platform === "win32"
    ? (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(ext => /^\.[A-Za-z0-9]+$/.test(ext)) : [];
  const uniqueExtensions = [...new Set(rawExtensions.map(ext => ext.toLowerCase()))];
  const extensions = platform === "win32" ? [...uniqueExtensions.slice(0, 32), ""] : [""];
  if (uniqueExtensions.length > 32) add("path-scan-truncated");
  const directories = path === undefined ? [] : path.split(platform === "win32" ? ";" : ":");
  if (directories.length > 256) add("path-scan-truncated");
  const candidates: CliPathCandidate[] = [];
  const scan = (directory: string, pathIndex: number): CliPathCandidate[] => {
    const result: CliPathCandidate[] = [];
    const unquoted = platform === "win32" && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    for (const extension of extensions) {
      const candidate = api.resolve(cwd, unquoted || ".", `ocx${extension}`);
      const found = observe(candidate);
      if (found.kind === "unreadable") add("path-unreadable");
      if (found.kind === "usable") result.push({ path: candidate, realpath: found.realpath, pathIndex, extension });
    }
    return result;
  };
  for (const [index, directory] of directories.slice(0, 256).entries()) candidates.push(...scan(directory, index));
  const pathFirst = candidates[0] ?? null;
  const currentDirectoryCandidate = platform === "win32" ? scan(cwd, -1)[0] ?? null : null;
  let expectedRealpath: string | null = null;
  if (target) {
    const found = observe(target);
    if (found.kind === "missing") add("desktop-target-missing");
    else if (found.kind !== "usable") add("desktop-target-unusable");
  }
  if (expected) {
    const found = observe(expected);
    if (found.kind === "missing") add("expected-command-missing");
    else if (found.kind !== "usable") add("expected-command-unusable");
    else expectedRealpath = found.realpath;
    if (!pathFirst) add("path-missing");
    else if (!same(pathFirst.path, expected) && (!expectedRealpath || !same(pathFirst.realpath, expectedRealpath))) add("path-first-not-desktop");
    if (currentDirectoryCandidate && !same(currentDirectoryCandidate.path, expected)
      && (!expectedRealpath || !same(currentDirectoryCandidate.realpath, expectedRealpath))) add("windows-current-directory-shadow");
  }
  return {
    configured, recordState: read.state, expectedExecutable: expected, handoffTarget: target,
    candidates, pathFirst,
    desktopFirstOnPath: configured && !issues.includes("path-unreadable") && !issues.includes("path-scan-truncated")
      ? Boolean(pathFirst && expected && expectedRealpath
        && (same(pathFirst.path, expected) || same(pathFirst.realpath, expectedRealpath))) : null,
    currentDirectoryCandidate, shellResolution: "unobserved", issues,
  };
}

export function formatCliCommandLine(value: CliPathDiagnostics): string {
  const first = value.pathFirst ? redactUserPath(value.pathFirst.path).replace(/[\x00-\x1f\x7f]/g, "?") : "none observed";
  return `ocx command: PATH first=${first}; Desktop=${!value.configured ? "not configured" : value.desktopFirstOnPath === null ? "unobserved" : value.desktopFirstOnPath ? "first" : "not first"}; shell=unobserved${value.issues.length ? `; issues=${value.issues.join(",")}` : ""}`;
}

export function formatCliStatusHealthLabel(health: string, value: CliPathDiagnostics, local: boolean): string {
  return `${health}${local ? " (local)" : ""}\n   ${formatCliCommandLine(value)}`;
}

export function cliCommandDoctorChecks(value: CliPathDiagnostics): { level: "OK" | "WARN" | "FAIL"; message: string }[] {
  const hard = value.issues.some(issue => issue.startsWith("record-") || issue.startsWith("desktop-target-") || issue.startsWith("expected-command-"));
  return [{ level: hard ? "FAIL" : value.issues.length ? "WARN" : "OK", message: formatCliCommandLine(value) }];
}
```

Scan bounds are explicit: 256 PATH elements and 32 distinct PATHEXT extensions. A truncated scan is WARN even when Desktop appears first; do not present complete candidate inventory. `shellResolution` is always `unobserved`, including an otherwise OK check. Configured false with a missing/disabled record is informational OK, not a promise that Desktop is configured.

## MODIFY diffs

The following exact baseline diffs are generated from the inspected 68c9d35457 files. The factory retains the original inspection snapshot, including `configDir`, relative CODEX_CLI_PATH resolution, manager roots and case-insensitive deletion of duplicated inspection environment variables. It returns one proof/context/env object; Desktop and Bun receive the same freshly captured object. It is **called** after the inspection classification and before handoff, not during module import.

### MODIFY `bin/ocx.mjs`

```diff
--- a/bin/ocx.mjs
+++ b/bin/ocx.mjs
@@ -9,6 +9,7 @@
  * src/cli/index.ts — only the published npm/pnpm `bin` routes through here.)
  */
 import { spawn, spawnSync } from "node:child_process";
+import { planDesktopCliHandoff, runDesktopCliHandoff } from "../src/lib/desktop-cli-handoff.mjs";
 import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";
 import { probeProxyLiveness } from "../src/update/proxy-liveness-probe.mjs";
 import { decidePostStopUpdate } from "../src/update/stop-decision.mjs";
@@ -961,6 +962,32 @@
   process.exit(1);
 }
 
+const { launchProof, launchContext, inheritedEnv } = createNodeLaunchContext();
+const desktopPlan = planDesktopCliHandoff({ selfPaths: [fileURLToPath(import.meta.url), process.execPath] });
+if (desktopPlan.kind === "error") {
+  console.error(`opencodex: Desktop CLI handoff refused (${desktopPlan.issue}). Repair or remove the terminal command in Desktop.`);
+  process.exit(1);
+}
+if (desktopPlan.kind === "handoff") {
+  const result = await runDesktopCliHandoff(desktopPlan, {
+    argv: process.argv.slice(2), env: inheritedEnv, proof: launchProof, context: launchContext,
+  });
+  if (result.kind === "error") {
+    console.error(`opencodex: Desktop CLI handoff failed (${result.issue}). Repair or remove the terminal command in Desktop.`);
+    process.exit(1);
+  }
+  if (result.kind === "exit") {
+    if (result.signal) {
+      process.kill(process.pid, result.signal);
+    } else {
+      process.exit(result.code);
+    }
+    // Signal delivery is asynchronous; never continue into package repair or Bun lookup.
+    await new Promise(() => {});
+  }
+  // Only target ENOENT reaches the ordinary package path below.
+}
+
 if (process.argv[2] === "update" && installMethod === "mise") {
   if (installOwnership.owner) {
     console.error(
@@ -1015,64 +1042,68 @@
 // billing and prevents it from redirecting the subscriber's OAuth bearer.
 // Disabling Bun's dotenv wholesale with --no-env-file is NOT an option: config
 // interpolation and provider settings legitimately read the project environment.
-const preBunAnthropicSlots = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
-  .filter(name => typeof process.env[name] === "string" && process.env[name] !== "");
-// A configured CODEX_CLI_PATH may legitimately be cwd-relative (`./tools/codex`), which the
-// ordinary runtime resolver accepts. Inspection only trusts absolute local paths, so capture
-// the absolute form here, in the launcher, while the original cwd is still authoritative;
-// resolving it later would silently reinterpret it against a different working directory.
-//
-// A bare command with no separator (`codex`) is NOT a relative path: the runtime resolver
-// deliberately hands those to executable lookup along PATH. Rewriting it to `<cwd>/codex`
-// would make the inspector treat it as an explicit path and stop searching PATH entirely.
-const configuredCodexCliPath = typeof process.env.CODEX_CLI_PATH === "string" && process.env.CODEX_CLI_PATH !== ""
-  ? process.env.CODEX_CLI_PATH
-  : null;
-const preBunCodexCliPath = configuredCodexCliPath !== null
-    && (configuredCodexCliPath.includes("/") || configuredCodexCliPath.includes("\\") || /^[A-Za-z]:/.test(configuredCodexCliPath))
-  ? resolve(configuredCodexCliPath)
-  : configuredCodexCliPath;
-const preBunPath = typeof process.env.PATH === "string" ? process.env.PATH : null;
-const preBunPathExt = typeof process.env.PATHEXT === "string" ? process.env.PATHEXT : null;
-const preBunCodexCliManagerRoots = Object.fromEntries(
-  CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS.flatMap(name => {
-    const value = process.env[name];
-    return typeof value === "string" && value !== "" ? [[name, value]] : [];
-  }),
-);
-const launchProof = randomBytes(32).toString("base64url");
-const launchContext = JSON.stringify({
-  version: 1,
-  proof: launchProof,
-  anthropicEnvSlots: preBunAnthropicSlots,
-  codexCliInspectionEnv: codexCliUpdateInspection ? {
-    codexCliPath: preBunCodexCliPath,
-    path: preBunPath,
-    pathExt: preBunPathExt,
-    managerRoots: preBunCodexCliManagerRoots,
-    configDir: configDir(),
-  } : null,
-});
-// The inspection snapshot above already carries PATH, PATHEXT, and the manager-root slots as
-// proof-bound values, and `inspectCodexCliInstall` reads them from that snapshot rather than
-// from the live environment. Inheriting them again would spend the 32,767-character Windows
-// environment block twice, so a large-but-valid shell environment could stop the Bun child
-// from spawning and fail the command before it reports anything. Drop the duplicates for the
-// one-shot inspection launch only; every other launch inherits the environment unchanged.
-// Windows environment names are case-insensitive, but this spread produces an ordinary
-// case-sensitive object, and a real Windows environment commonly spells the variable `Path`.
-// Deleting only the canonical upper-case spelling would silently leave that copy behind and
-// reintroduce the duplication this block exists to prevent, so match on the lowercase form.
-const inheritedEnv = { ...process.env };
-if (codexCliUpdateInspection) {
-  const snapshotted = new Set(
-    ["PATH", "PATHEXT", ...CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS].map(name => name.toLowerCase()),
+function createNodeLaunchContext() {
+  const preBunAnthropicSlots = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
+    .filter(name => typeof process.env[name] === "string" && process.env[name] !== "");
+  // A configured CODEX_CLI_PATH may legitimately be cwd-relative (`./tools/codex`), which the
+  // ordinary runtime resolver accepts. Inspection only trusts absolute local paths, so capture
+  // the absolute form here, in the launcher, while the original cwd is still authoritative;
+  // resolving it later would silently reinterpret it against a different working directory.
+  //
+  // A bare command with no separator (`codex`) is NOT a relative path: the runtime resolver
+  // deliberately hands those to executable lookup along PATH. Rewriting it to `<cwd>/codex`
+  // would make the inspector treat it as an explicit path and stop searching PATH entirely.
+  const configuredCodexCliPath = typeof process.env.CODEX_CLI_PATH === "string" && process.env.CODEX_CLI_PATH !== ""
+    ? process.env.CODEX_CLI_PATH
+    : null;
+  const preBunCodexCliPath = configuredCodexCliPath !== null
+      && (configuredCodexCliPath.includes("/") || configuredCodexCliPath.includes("\\") || /^[A-Za-z]:/.test(configuredCodexCliPath))
+    ? resolve(configuredCodexCliPath)
+    : configuredCodexCliPath;
+  const preBunPath = typeof process.env.PATH === "string" ? process.env.PATH : null;
+  const preBunPathExt = typeof process.env.PATHEXT === "string" ? process.env.PATHEXT : null;
+  const preBunCodexCliManagerRoots = Object.fromEntries(
+    CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS.flatMap(name => {
+      const value = process.env[name];
+      return typeof value === "string" && value !== "" ? [[name, value]] : [];
+    }),
   );
-  for (const name of Object.keys(inheritedEnv)) {
-    if (snapshotted.has(name.toLowerCase())) delete inheritedEnv[name];
-  }
-}
-const child = spawn(bun, [cliPath, `${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`, ...process.argv.slice(2)], {
+  const launchProof = randomBytes(32).toString("base64url");
+  const launchContext = JSON.stringify({
+    version: 1,
+    proof: launchProof,
+    anthropicEnvSlots: preBunAnthropicSlots,
+    codexCliInspectionEnv: codexCliUpdateInspection ? {
+      codexCliPath: preBunCodexCliPath,
+      path: preBunPath,
+      pathExt: preBunPathExt,
+      managerRoots: preBunCodexCliManagerRoots,
+      configDir: configDir(),
+    } : null,
+  });
+  // The inspection snapshot above already carries PATH, PATHEXT, and the manager-root slots as
+  // proof-bound values, and `inspectCodexCliInstall` reads them from that snapshot rather than
+  // from the live environment. Inheriting them again would spend the 32,767-character Windows
+  // environment block twice, so a large-but-valid shell environment could stop the Bun child
+  // from spawning and fail the command before it reports anything. Drop the duplicates for the
+  // one-shot inspection launch only; every other launch inherits the environment unchanged.
+  // Windows environment names are case-insensitive, but this spread produces an ordinary
+  // case-sensitive object, and a real Windows environment commonly spells the variable `Path`.
+  // Deleting only the canonical upper-case spelling would silently leave that copy behind and
+  // reintroduce the duplication this block exists to prevent, so match on the lowercase form.
+  const inheritedEnv = { ...process.env };
+  if (codexCliUpdateInspection) {
+    const snapshotted = new Set(
+      ["PATH", "PATHEXT", ...CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS].map(name => name.toLowerCase()),
+    );
+    for (const name of Object.keys(inheritedEnv)) {
+      if (snapshotted.has(name.toLowerCase())) delete inheritedEnv[name];
+    }
+  }
+  return { launchProof, launchContext, inheritedEnv };
+}
+
+const child = spawn(bun, [cliPath, `${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`, ...process.argv.slice(2).filter(arg => !arg.startsWith(NODE_LAUNCH_PROOF_PREFIX))], {
   stdio: "inherit",
   // A headless Windows parent (Task Scheduler, dashboard restart, shortcut) has no
   // console to inherit. Without this flag Windows allocates a visible console for
```

### MODIFY `src/service/managing-cli.ts`

```diff
--- a/src/service/managing-cli.ts
+++ b/src/service/managing-cli.ts
@@ -81,6 +81,7 @@
       windowsShim ? ["/c", shimCommand] : [...args, "--version"],
       {
         timeout: VERSION_PROBE_TIMEOUT_MS, encoding: "utf8", stdio: "pipe",
+        env: { ...deps.env, OCX_NO_DESKTOP_HANDOFF: "1" },
         windowsHide: true, ...(windowsShim ? { windowsVerbatimArguments: true } : {}),
       },
     ) as SpawnSyncReturns<string>;
```

### MODIFY `src/cli/status.ts`

```diff
--- a/src/cli/status.ts
+++ b/src/cli/status.ts
@@ -1,3 +1,4 @@
+import { collectCliPathDiagnostics, formatCliStatusHealthLabel, type CliPathDiagnostics } from "./cli-path-diagnostics";
 import type { CodexMainAccountPolicyHealth } from "../oauth/health";
 import { durableBunRuntime } from "../lib/bun-runtime";
 import { existsSync, readFileSync } from "node:fs";
@@ -215,6 +216,7 @@
    * ignores the key is unaffected, and `proxyVersion` is null when nothing is live.
    */
   versionSkew: VersionSkew;
+  cliCommand: CliPathDiagnostics;
 };
 
 export type CliStatusView = {
@@ -680,6 +682,7 @@
 
 /** `mainAccountPolicy`: only `--json` asks; the human report reads the same accounts once via OAuth health. */
 export async function collectStatus(options: { mainAccountPolicy?: boolean } = {}): Promise<CliStatusView> {
+  const cliCommand = collectCliPathDiagnostics();
   const configDiagnostics = readConfigDiagnostics();
   const config = configDiagnostics.config;
   const claudeDesktop = {
@@ -869,7 +872,7 @@
 
   return {
     proxyLabel,
-    healthLabel: health.label,
+    healthLabel: formatCliStatusHealthLabel(health.label, cliCommand, remoteHub.connected),
     json: {
       ...(mainAccountHardLock ? { mainAccountHardLock } : {}),
       schemaVersion: 1,
@@ -932,6 +935,7 @@
       // fact about this install, not about the Codex runtime, and filing it there would
       // print it under the wrong heading (#2701).
       versionSkew,
+      cliCommand,
     },
   };
 }
```

### MODIFY `src/cli/doctor.ts`

```diff
--- a/src/cli/doctor.ts
+++ b/src/cli/doctor.ts
@@ -7,6 +7,7 @@
  * it never sets proxy env, relocates state dirs, mutates quota, or changes
  * networking. See devlog/_plan/260630_wsl-account-autoswitch/30_*.
  */
+import { cliCommandDoctorChecks, collectCliPathDiagnostics } from "./cli-path-diagnostics";
 import { accessSync, constants, existsSync, readFileSync } from "node:fs";
 import { homedir } from "node:os";
 import { dirname, join } from "node:path";
@@ -1324,6 +1325,12 @@
     console.log(`  ${row.exists ? "ok " : "-- "} ${row.label}: ${row.path}${flags ? `  (${flags})` : ""}`);
   }
 
+  console.log("\nocx command selection");
+  for (const check of cliCommandDoctorChecks(collectCliPathDiagnostics())) {
+    console.log(`  ${check.level === "OK" ? "ok " : "!! "} ${check.message}`);
+    if (check.level === "FAIL") recordDoctorFailure();
+  }
+
   // Runs without the proxy on purpose: the worst accumulation happens when the proxy will
   // not start, which is exactly when the in-process periodic reclaim never ticks.
   const reclaimTemps = args.includes(RECLAIM_RESPONSE_TEMPS_FLAG);
```

### MODIFY `scripts/test-layout/layout.json`

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ -1295,6 +1295,8 @@
     "oauth-store-multi.test.ts": "oauth",
     "oauth-tos-warning.test.ts": "gui",
     "oauth-upsert-preserves-api-key.test.ts": "oauth",
+    "ocx-launcher-desktop-handoff.test.ts": "cli",
+    "cli-path-diagnostics.test.ts": "cli",
     "ocx-launcher-runtime.test.ts": "cli",
     "ocx-launcher-source.test.ts": "cli",
     "ocx-run.test.ts": "cli",
```

### MODIFY `tests/fixtures/test-layout-expected.json`

```diff
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ -776,6 +776,7 @@
   "oauth-refresh-lock-multiprocess.test.ts": "oauth", "oauth-refresh.test.ts": "oauth",
   "oauth-status-privacy.test.ts": "oauth", "oauth-store-multi.test.ts": "oauth",
   "oauth-tos-warning.test.ts": "gui", "oauth-upsert-preserves-api-key.test.ts": "oauth",
+  "ocx-launcher-desktop-handoff.test.ts": "cli", "cli-path-diagnostics.test.ts": "cli",
   "ocx-launcher-runtime.test.ts": "cli", "ocx-launcher-source.test.ts": "cli",
   "ocx-run.test.ts": "cli", "ollama-native-parser.test.ts": "providers/ollama",
   "ollama-native-reasoning-wire.test.ts": "providers/ollama",
```

### MODIFY `structure/runtime.md`

```diff
--- a/structure/runtime.md
+++ b/structure/runtime.md
@@ -120,7 +120,7 @@
 
 | Path | Responsibility |
 | --- | --- |
-| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. The exact `system codex-cli-update` inspection namespace skips both boot repair and lazy Bun installation; missing runtime support fails closed instead of mutating state. |
+| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. The exact `system codex-cli-update` inspection namespace skips both boot repair and lazy Bun installation; missing runtime support fails closed instead of mutating state. Before package repair or Bun resolution, `src/lib/desktop-cli-record.mjs` reads the bounded settled Desktop command record and `src/lib/desktop-cli-handoff.mjs` delegates eligible commands to its validated target with a regenerated argv proof, inherited IO and mirrored exit/signal. Update, removal, internal inspection and `OCX_NO_DESKTOP_HANDOFF=1` retain the package path; only target ENOENT resumes it after selection. Command selection is separate from runtime/service authority; see [command selection](cli-management.md#ocx-command-selection). |
 | `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, and `durableBunPath()` (path baked into service/shim artifacts). Durable selection accepts only the source/path pair already stamped for the running executable; it never re-reads a project-dotenv `OPENCODEX_BUN_PATH`. |
 | `src/lib/plain-data.ts` | Detached copies for a consumer that must not observe later edits. Descriptor-based reads, including array elements, so an accessor is refused rather than invoked; refuses cycles, functions, class instances and anything else JSON could not have produced, and returns a copy-or-refusal union rather than degrading silently. Symbol-keyed process bookkeeping is skipped. |
 | `src/cli/index.ts` | `ocx` / `opencodex` CLI. Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, service, update. `restart` refuses an in-place restart requested by a CLI whose version differs from the attested `/healthz` version; a newer CLI may use the guarded standalone update path described below, because an in-place replacement respawns from the live installation; placeholder versions (unknown/0.0.0) stay incomparable and keep the restart path. Configuration: provider, account, models, combo/route, access, integrations, v2. Client launchers: Claude, OpenCode, MiniMax Code, and MiniMax CLI text. The MMX launcher owns a child-lifetime loopback path bridge from the client's hard-coded `/anthropic/v1/messages` path to the canonical `/v1/messages` data plane; the server does not expose an extra auth surface. Diagnostics: doctor, debug, observe, health. Windows adds tray. Hidden `__update-badge` prints the read-only package badge JSON without refresh or shim repair for the npm tray. The full top-level reference is rendered by `src/cli/help.ts`; this table names the groups, not every verb. After help/version and unknown-root early exits, recognized commands run the bounded best-effort Codex-shim auto-restore policy before dispatch. `status`, `doctor`, and `codex-shim status` skip shim auto-repair; `system codex-cli-update` and [command-local messaging](local-messaging.md#command-local-cli) suppress it for their whole namespaces, including malformed invocations. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). `src/cli/init.ts` validates an explicit setup port as a decimal integer from 1 through 65535 before publishing the initial configuration. Only an empty answer selects 10100; malformed input is reported and the port question is asked again, while EOF or SIGINT still cancels without saving. |
```

### MODIFY `structure/cli-management.md`

```diff
--- a/structure/cli-management.md
+++ b/structure/cli-management.md
@@ -105,3 +105,7 @@
 `src/cli/account-api.ts` forwards explicit quota/refresh intent to the existing per-key owner; ordinary key listing omits both. Opt-in requests reject redirects. `src/cli/account-key-quota.ts` rebuilds the public ProviderQuota projection, including custom windows and credits, with finite-field validation and no credential or private publication fields. Missing mode evidence is unverified/nonzero. Human rendering separates probe/passive/unsupported, unavailable and unmeasured from actual zero; Codex/OAuth rendering remains separate. This read can invoke upstream quota work but does not change key selection or provider aggregate caches. Account list/current rows additionally project, through `src/cli/account-next-actions.ts`, only an allow-listed server health label, a locally generated recovery command built from shell-safe selectors (never server summary/action text), and the Codex boolean `creditsAfterLimit` as read-only consent readback; empty listings add a fixed next-action note to human output and JSON `notes`.
 
 The operating guide's eight-domain workflow table is navigation rather than parity measurement. Handwritten JSON, recipe, recovery and target docs qualify bounded windows, model-only search, partial/default results and human-only/session actions. Generated chapter counts still derive exclusively from capability declarations.
+
+## ocx command selection
+
+`src/cli/cli-path-diagnostics.ts` reads the settled Desktop record through `src/lib/desktop-cli-record.mjs` and observes regular executable candidates on this process's PATH without executing them. `pathFirst` follows PATH/PATHEXT order, including cwd-relative and empty entries; Windows's possible cmd current-directory candidate is separate. The expected command is the owned POSIX shim or the recorded Windows bundled executable. A stale package candidate first on PATH is reported even if its current launcher would hand off. `src/cli/status.ts` exposes additive `cliCommand` JSON and a human-view line; `src/cli/doctor.ts` prints the separate “ocx command selection” checks. Neither observation supplies runtime ownership or service control authority. Parent-shell aliases, functions and caches remain unobserved. Invalid records and unusable Desktop targets are FAIL; PATH ordering and incomplete scans are WARN.
```

### MODIFY `structure/ops/service-and-sidecars.md`

```diff
--- a/structure/ops/service-and-sidecars.md
+++ b/structure/ops/service-and-sidecars.md
@@ -539,3 +539,5 @@
 Desktop startup diagnostics use `src/service/desktop-startup.ts` to read the ownership record, the login registration (macOS: launchd; Linux: the `~/.config/autostart/OpenCodex.desktop` entry that auto-launch writes, credited only when `XDG_CONFIG_HOME` is unset or `~/.config`; it must launch an unquoted absolute `opencodex-desktop` with exactly `--autostart`, without conditional keys, and not be hidden or disabled) and exact parent/child executable paths (Linux: `/proc/<pid>/exe` and the parent pid from `/proc/<pid>/stat`) without mutating them. A durable desktop claim survives a failed identity or supervision check; only fresh matching identity, enabled login registration, and live supervision grant protection. On macOS, ownership and PID are re-read before crediting the result; on Linux, the complete evidence chain is read twice and both reads must agree. The startup-health subprocess uses `selfLaunchArgv` to support both source and compiled entrypoints.
 
 On Linux, a dashboard update worker started from the systemd user service is launched through an executable regular file at a trusted absolute path — `/usr/bin/systemd-run`, `/bin/systemd-run`, `/usr/local/bin/systemd-run` (local installs), or `/run/current-system/sw/bin/systemd-run` (the NixOS layout) — with `--user --scope --quiet --collect` (`src/update/worker-launch.ts`), so it leaves the service cgroup before the updater stops `opencodex-proxy.service`; the default `KillMode=control-group` otherwise kills it with the proxy (#5750). The inherited `PATH` is never searched, and each candidate's resolved target — plus every ancestor directory able to substitute it — must be root-owned and not group/world-writable: a trusted-path symlink into a user-replaceable directory is skipped, as is a group-writable `/usr/local/bin`, rather than exec'd under the service account. Candidates are tried in order and a path whose no-op scope probe fails falls through to the next trusted path; the probe applies only when `INVOCATION_ID` is set, and every other case keeps the plain detached spawn. The management route resolves the launcher with `resolveSystemdRunAsync` before spawning, so first-request probing overlaps other work instead of blocking the event loop for up to twenty seconds. `--scope` moves `systemd-run` itself into the scope and then execs the worker, so the recorded PID is the worker's (`tests/update/update-worker-launch.test.ts`).
+
+Internal version observations in `src/service/managing-cli.ts` (`probeVersionOnce`) set `OCX_NO_DESKTOP_HANDOFF=1` in the spawned child's environment so the selected package executable reports its own version. This flag suppresses the package launcher's Desktop handoff only; it does not bypass service ownership or update guards. Normal user `ocx --version` remains eligible for handoff.
```

### MODIFY `docs-site/src/content/docs/getting-started/installation.md`

```diff
--- a/docs-site/src/content/docs/getting-started/installation.md
+++ b/docs-site/src/content/docs/getting-started/installation.md
@@ -6,6 +6,12 @@
 opencodex installs two equivalent command names, `ocx` and `opencodex`. Both launch the same small
 local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
 vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.
+
+## Desktop terminal command
+
+A stable OpenCodex Desktop install configures `ocx` for new terminals when the app starts. Open a new terminal and run `ocx status` or `ocx doctor` to inspect the first executable on PATH. POSIX uses the Desktop-owned shim; Windows uses the bundled `ocx.exe`. Existing terminals, aliases, shell caches and later PATH changes can still select another command; a conflicting Windows system PATH entry can also win. Use the app’s Terminal command settings to repair, disable or remove this configuration. AppImage is excluded.
+
+A current npm/pnpm package launcher that still runs delegates eligible commands to the Desktop CLI when its record is enabled. Package update/removal and internal inspection keep their existing path. `OCX_NO_DESKTOP_HANDOFF=1` suppresses that package handoff for one invocation; it does not change a direct Desktop shim or PATH configuration.
 
 ## Prerequisites
 
```

### MODIFY `docs-site/src/content/docs/reference/cli.md`

```diff
--- a/docs-site/src/content/docs/reference/cli.md
+++ b/docs-site/src/content/docs/reference/cli.md
@@ -254,6 +254,8 @@
 version mismatch. `unknown` does not confirm matching builds. Offline help,
 local configuration and local Lab inspection do not require startup.
 
+`ocx status --json` includes `cliCommand`: configured Desktop intent, the expected executable, observed PATH candidates, `pathFirst`, `desktopFirstOnPath`, issue codes, and `shellResolution: "unobserved"`. The human status report prints one command-selection line. `ocx doctor` adds an “ocx command selection” section: invalid records or missing/unusable Desktop targets fail the check, while PATH ordering conflicts and incomplete scans warn. These read-only observations do not execute candidates, resolve parent-shell aliases/functions, or identify the proxy’s runtime owner. On Windows, a possible cmd current-directory candidate is reported separately from PATH order.
+
 Output flags are per command. `doctor` rejects `--json` with exit 2;
 [`v2` (family reference)](/reference/cli/agents/)
 supports `--json` for local and `--live` targets. Even for JSON-capable management commands, API failures
```

The `healthLabel` change is a deliberate **view-only adapter**: the unchanged `handleStatus` already prints this string and prints JSON from `status.json` alone. The line is local to this CLI even when connected to a hub. Do not print inside `collectStatus`; doing so would contaminate JSON callers. This adapter does make the human-view health string multiline. If review requires a dedicated renderer field, report the necessary `index.ts` scope expansion to parent before changing it. The JSON health message remains a single unchanged value.

## Complete new regression files

The runnable code below creates only temp fixtures, uses repository-root helpers, does not source startup files, and never changes the user's home or installed Desktop. Native Windows process signal semantics are not inferred from POSIX integration tests; Windows policy/observation fixtures run on every host and 030 owns native Windows smoke evidence.

### NEW `tests/cli/ocx-launcher-desktop-handoff.test.ts` (complete)

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, type statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDesktopCliRecord, desktopCliRecordPath, DESKTOP_CLI_RECORD_MAX_BYTES, type DesktopCliRecordRead } from "../../src/lib/desktop-cli-record.mjs";
import { desktopHandoffExcluded, planDesktopCliHandoff, runDesktopCliHandoff } from "../../src/lib/desktop-cli-handoff.mjs";
import { initializeNodeLauncherContext } from "../../src/cli/launcher-context";
import { buildNativeClaudeEnv } from "../../src/cli/claude";
import { observeManagingClis } from "../../src/service/managing-cli";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];
const PREFIX = "--ocx-internal-launch-proof=";
const proof = "A".repeat(43);
const context = JSON.stringify({ version: 1, proof, anthropicEnvSlots: ["ANTHROPIC_API_KEY"], codexCliInspectionEnv: null });
afterEach(() => {
  initializeNodeLauncherContext(["bun", "index.ts"], {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function box(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-handoff-")); roots.push(root); return root;
}
function ready(target = "/fixture/desktop/ocx"): DesktopCliRecordRead {
  return { state: "ready", path: "/fixture/cli.json", record: {
    version: 1, enabled: true, bundle: { platform: "linux", cliExecutable: target },
  } };
}
const stat = (() => ({ isFile: () => true })) as unknown as typeof statSync;
const deps = { stat, access: () => {}, realpath: (path: string) => path };
const coded = (code: string): NodeJS.ErrnoException => Object.assign(new Error("fixture"), { code });

function fakeSpawn(error?: string, exitSignal: NodeJS.Signals | null = null) {
  const parent = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
  const killed: string[] = [];
  child.kill = signal => { killed.push(signal); return true; };
  let observed: { target: string; argv: string[]; options: Record<string, unknown> } | undefined;
  const run = ((target: string, argv: string[], options: Record<string, unknown>) => {
    observed = { target, argv, options };
    queueMicrotask(() => {
      parent.emit("SIGTERM");
      if (error) { child.emit("error", coded(error)); child.emit("exit", 99, null); }
      else child.emit("exit", 17, exitSignal);
    });
    return child;
  }) as unknown as typeof spawn;
  return { run, parent, killed, observed: () => observed };
}

describe("Desktop record and handoff policy", () => {
  test("fixed record location and injected reader path", () => {
    expect(desktopCliRecordPath({ platform: "darwin", home: "/Users/example" })).toBe("/Users/example" + "/.opencodex-desktop/cli.json");
    expect(desktopCliRecordPath({ platform: "win32", env: { USERPROFILE: "C:\\Users\\example" } })).toBe("C:\\Users\\example\\.opencodex-desktop\\cli.json");
    const root = box(); const recordPath = join(root, "cli.json");
    expect(readDesktopCliRecord({ recordPath }).state).toBe("missing");
    writeFileSync(recordPath, '{"version":1,"enabled":false}');
    expect(readDesktopCliRecord({ recordPath }).state).toBe("disabled");
    writeFileSync(recordPath, JSON.stringify({ version: 1, enabled: true, bundle: { platform: process.platform, cliExecutable: join(root, "ocx") }, ownerId: "ignored" }));
    expect(readDesktopCliRecord({ recordPath }).state).toBe("ready");
  });
  test("reader refuses oversized, malformed, pending and wrong-platform records", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    const valid = { version: 1, enabled: true, bundle: { platform: process.platform, cliExecutable: join(root, "ocx") } };
    for (const value of ["{", "[]", "null", "42", JSON.stringify({ ...valid, enabled: "yes" }), JSON.stringify({ ...valid, bundle: null }), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, pending: {} }), JSON.stringify({ ...valid, bundle: { platform: "other", cliExecutable: "relative" } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, cliExecutable: "relative" } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, cliExecutable: "/" + "x".repeat(32768) } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, cliExecutable: "/fixture/line\nbreak" } })]) {
      writeFileSync(recordPath, value); expect(readDesktopCliRecord({ recordPath }).state).toBe("invalid");
    }
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-invalid" });
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-too-large" });
    rmSync(recordPath); mkdirSync(recordPath);
    expect(readDesktopCliRecord({ recordPath }).state).toBe("invalid");
  });
  test("descriptor sentinel bounds growth after metadata and strict UTF-8 rejects corrupt bytes", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    writeFileSync(recordPath, Buffer.from([0xff]));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-invalid" });
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1));
    const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.fstatSync; fs.fstatSync = (...args) => { const info = original(...args); info.size = 1; return info; }; syncBuiltinESMExports();
const mod = await import(${JSON.stringify(pathToFileURL(repoPath("src", "lib", "desktop-cli-record.mjs")).href)});
console.log(JSON.stringify(mod.readDesktopCliRecord({recordPath:${JSON.stringify(recordPath)}})));`;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ issue: "record-too-large" });
  });
  (process.platform === "win32" ? test.skip : test)("reader open failure is unreadable and disabled intent wins over pending journal", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    symlinkSync(recordPath, recordPath);
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ state: "unreadable", issue: "record-unreadable" });
    rmSync(recordPath); writeFileSync(recordPath, '{"version":1,"enabled":false,"pending":{}}');
    expect(readDesktopCliRecord({ recordPath }).state).toBe("disabled");
  });
  test("record absence and disabled intent keep the package path; invalid records error", () => {
    for (const state of ["missing", "disabled"] as const) expect(planDesktopCliHandoff({ argv: ["status"], env: {}, recordRead: { state, path: "fixture" } })).toEqual({ kind: "continue", reason: state });
    for (const issue of ["record-invalid", "record-too-large", "record-pending", "record-unreadable"] as const) expect(planDesktopCliHandoff({ argv: ["status"], env: {}, recordRead: { state: issue === "record-unreadable" ? "unreadable" : "invalid", issue, path: "fixture" } })).toEqual({ kind: "error", issue });
  });
  test("update, removal, internal inspection and codex-cli-update are exceptions", () => {
    for (const argv of [["update"], ["update", "--help"], ["uninstall"], ["remove"], ["__update-badge"], ["system", "codex-cli-update", "malformed"], [PREFIX + "invalid", "update"]]) {
      expect(desktopHandoffExcluded(argv, {})).toBe(true);
      expect(planDesktopCliHandoff({ argv, env: {}, recordRead: ready() }, { stat: (() => { throw new Error("must not read target"); }) as typeof stat })).toMatchObject({ reason: "excluded" });
    }
    expect(desktopHandoffExcluded(["--version"], {})).toBe(false);
    expect(desktopHandoffExcluded(["inspect", "config"], {})).toBe(false);
  });
  test("OCX_NO_DESKTOP_HANDOFF is exact and keeps user version handoff eligible", () => {
    expect(desktopHandoffExcluded(["--version"], { OCX_NO_DESKTOP_HANDOFF: "1" })).toBe(true);
    expect(desktopHandoffExcluded(["--version"], { OCX_NO_DESKTOP_HANDOFF: "0" })).toBe(false);
  });
  test("absolute regular executable target selected; self realpath never delegated", () => {
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths: ["/fixture/package/ocx.mjs"] }, deps)).toEqual({ kind: "handoff", target: "/fixture/desktop/ocx" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths: ["/fixture/alias"] }, { ...deps, realpath: () => "/fixture/same" })).toMatchObject({ kind: "error", issue: "target-self" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready("relative") }, deps)).toMatchObject({ issue: "target-invalid" });
    const selfPaths = ["/fixture/missing-self"];
    const missingSelf = { ...deps, realpath: (path: string) => { if (path === selfPaths[0]) throw coded("ENOENT"); return path; } };
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths }, missingSelf).kind).toBe("handoff");
    const badSelf = { ...deps, realpath: (path: string) => { if (path === selfPaths[0]) throw coded("ELOOP"); return path; } };
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths }, badSelf)).toMatchObject({ issue: "target-unusable" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready() }, { ...deps, stat: (() => ({ isFile: () => false })) as unknown as typeof statSync })).toMatchObject({ issue: "target-invalid" });
  });
  test("target ENOENT resumes and EACCES or other errors fail", () => {
    for (const code of ["ENOENT", "EACCES", "ENOTDIR", "ENOEXEC", "ELOOP"]) {
      const plan = planDesktopCliHandoff({ argv: ["status"], env: {}, platform: "linux", recordRead: ready() }, { ...deps, access: () => { throw coded(code); } });
      expect(plan.kind).toBe(code === "ENOENT" ? "continue" : "error");
    }
  });
  test("Windows realpath comparison is case insensitive and defers execute permission to spawn", () => {
    let mode = -1;
    const plan = planDesktopCliHandoff({ argv: [], env: {}, platform: "win32", recordRead: ready("C:\\App\\ocx.exe"), selfPaths: ["c:\\app\\OCX.exe"] }, { ...deps, access: (_path, value) => { mode = value ?? -1; } });
    expect(plan).toMatchObject({ issue: "target-self" }); expect(mode).toBe(0);
  });
});

describe("async handoff transport", () => {
  test("argv, inherited stdin, fresh proof and exit code; signal handlers cleaned", async () => {
    const fake = fakeSpawn();
    const result = await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, {
      argv: [PREFIX + "obsolete", "claude", "a b", "--literal=$x"], proof, context,
      env: { PATH: "fixture", OCX_BUN_RUNTIME_PATH: "stale", OCX_BUN_RUNTIME_SOURCE: "bundled" },
    }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process, platform: "linux" });
    expect(result).toEqual({ kind: "exit", code: 17, signal: null });
    const called = fake.observed()!;
    expect(called.argv).toEqual([PREFIX + proof, "claude", "a b", "--literal=$x"]);
    expect(called.options).toMatchObject({ stdio: "inherit", shell: false, windowsHide: true });
    expect(called.options.env).toEqual({ PATH: "fixture", OCX_NO_DESKTOP_HANDOFF: "1", OCX_NODE_LAUNCH_CONTEXT: context });
    expect(fake.killed).toEqual(["SIGTERM"]); expect(fake.parent.listenerCount("SIGTERM")).toBe(0);
  });
  test("child signal is retained and asynchronous spawn ENOENT alone resumes", async () => {
    for (const error of [undefined, "ENOENT", "EACCES", "ENOEXEC"]) {
      const fake = fakeSpawn(error, "SIGTERM");
      const result = await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process });
      expect(result.kind).toBe(!error ? "exit" : error === "ENOENT" ? "continue" : "error");
      if (result.kind === "exit") expect(result.signal).toBe("SIGTERM");
      expect(fake.parent.eventNames()).toHaveLength(0);
    }
  });
  test("Windows forwards INT/TERM only and a kill race still settles from child exit", async () => {
    const fake = fakeSpawn();
    const pending = runDesktopCliHandoff({ kind: "handoff", target: "C:\\App\\ocx.exe" }, { argv: [], env: {}, proof, context }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process, platform: "win32" });
    expect(fake.parent.listenerCount("SIGHUP")).toBe(0); expect(fake.parent.listenerCount("SIGINT")).toBe(1);
    expect((await pending).kind).toBe("exit");
    const parent = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & { kill: () => never };
    child.kill = () => { throw new Error("already exited"); };
    const run = (() => { queueMicrotask(() => { parent.emit("SIGTERM"); child.emit("exit", null, null); }); return child; }) as unknown as typeof spawn;
    expect(await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: run, parent: parent as unknown as NodeJS.Process })).toEqual({ kind: "exit", code: 1, signal: null });
  });
  test("synchronous spawn errors have the same ENOENT-only policy", async () => {
    for (const code of ["ENOENT", "EACCES"]) {
      const fail = (() => { throw coded(code); }) as unknown as typeof spawn;
      expect((await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: fail })).kind).toBe(code === "ENOENT" ? "continue" : "error");
    }
  });
  test("proof reaches the real Claude native-env consumer and keeps exported slots", () => {
    const env = { OCX_NODE_LAUNCH_CONTEXT: context, ANTHROPIC_API_KEY: "fixture-user-key", ANTHROPIC_BASE_URL: "https://fixture.invalid", OCX_PRE_BUN_ANTHROPIC_ENV: "obsolete" };
    const argv = ["bun", "index.ts", PREFIX + proof, "claude"];
    expect(initializeNodeLauncherContext(argv, env)?.anthropicEnvSlots).toEqual(["ANTHROPIC_API_KEY"]);
    expect(argv).toEqual(["bun", "index.ts", "claude"]);
    const config = { port: 10100, providers: {} } as Parameters<typeof buildNativeClaudeEnv>[0];
    const child = buildNativeClaudeEnv(config, env);
    expect(child.ANTHROPIC_API_KEY).toBe("fixture-user-key");
    expect(child.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(child.OCX_NODE_LAUNCH_CONTEXT).toBeUndefined();
  });
  test("internal managing CLI probes set the bypass in the actual spawn environment", () => {
    let actual: NodeJS.ProcessEnv | undefined;
    const probe = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { actual = options.env; return { status: 0, stdout: "2.82.0", stderr: "" }; }) as unknown as typeof spawnSync;
    const result = observeManagingClis(null, { platform: "linux", env: { PATH: "/fixture", KEEP: "yes" }, execPath: "/fixture/self", exists: path => path === "/fixture/ocx", isFile: () => true, spawn: probe });
    expect(result.path.status).toBe("observed"); expect(actual).toEqual({ PATH: "/fixture", KEEP: "yes", OCX_NO_DESKTOP_HANDOFF: "1" });
  });
});

function packageFixture() {
  const home = box(); const directory = join(home, ".opencodex-desktop"); mkdirSync(directory);
  const target = join(home, "desktop-cli");
  const recordPath = join(directory, "cli.json");
  writeFileSync(recordPath, JSON.stringify({ version: 1, enabled: true, bundle: { platform: process.platform, cliExecutable: target } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OCX_NO_DESKTOP_HANDOFF: "0", OCX_NODE_LAUNCH_CONTEXT: "forged", ANTHROPIC_API_KEY: "fixture-user-key", OPENCODEX_BUN_PATH: join(home, "missing-bun") };
  return { home, target, env };
}
const posixTest = process.platform === "win32" ? test.skip : test;
const launcher = repoPath("bin", "ocx.mjs");
posixTest("real Node launcher regenerates proof, forwards argv/stdin, mirrors exit and bypasses Bun lookup", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), context: JSON.parse(process.env.OCX_NODE_LAUNCH_CONTEXT), stdin: fs.readFileSync(0, 'utf8'), bypass: process.env.OCX_NO_DESKTOP_HANDOFF }));\nprocess.exit(23);\n`);
  chmodSync(fixture.target, 0o755);
  const result = spawnSync("node", [launcher, "claude", "a b", PREFIX + "old"], { env: fixture.env, input: "fixture stdin\n", encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(23);
  const row = JSON.parse(result.stdout.trim());
  expect(row.stdin).toBe("fixture stdin\n"); expect(row.bypass).toBe("1");
  expect(row.argv.slice(1)).toEqual(["claude", "a b"]);
  expect(row.argv[0]).toBe(PREFIX + row.context.proof);
  expect(row.context.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(row.context.anthropicEnvSlots).toContain("ANTHROPIC_API_KEY");
  const argv = ["bun", "index.ts", ...row.argv];
  const captured = initializeNodeLauncherContext(argv, { OCX_NODE_LAUNCH_CONTEXT: JSON.stringify(row.context) });
  expect(captured?.anthropicEnvSlots).toContain("ANTHROPIC_API_KEY");
});
posixTest("real target disappearance resumes Bun; EACCES never resumes Bun", () => {
  const fixture = packageFixture();
  const absent = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(absent.stderr).toContain("OPENCODEX_BUN_PATH");
  writeFileSync(fixture.target, "not executable"); chmodSync(fixture.target, 0o600);
  const denied = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(denied.status).toBe(1); expect(denied.stderr).toContain("target-unusable"); expect(denied.stderr).not.toContain("OPENCODEX_BUN_PATH");
});
posixTest("real update-help is untouched; opt-out and bad record activate distinct paths", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nconsole.log('desktop-picked'); process.exit(0);\n"); chmodSync(fixture.target, 0o755);
  const help = spawnSync("node", [launcher, "update", "--help"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(help.status).toBe(0); expect(help.stdout).toContain("Usage: ocx update"); expect(help.stdout).not.toContain("desktop-picked");
  const skipped = spawnSync("node", [launcher, "--version"], { env: { ...fixture.env, OCX_NO_DESKTOP_HANDOFF: "1" }, encoding: "utf8", timeout: 5000 });
  expect(skipped.stdout).not.toContain("desktop-picked"); expect(skipped.stderr).toContain("OPENCODEX_BUN_PATH");
  writeFileSync(join(fixture.home, ".opencodex-desktop", "cli.json"), "{");
  const invalid = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("record-invalid"); expect(invalid.stderr).not.toContain("OPENCODEX_BUN_PATH");
});
posixTest("real child terminating signal is mirrored by Node parent", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n"); chmodSync(fixture.target, 0o755);
  const result = spawnSync("node", [launcher, "status"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(result.signal).toBe("SIGTERM");
});
posixTest("signal sent only to real launcher reaches its child and waits for child exit", async () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(29));\nconsole.log(process.pid); setInterval(() => {}, 1000);\n"); chmodSync(fixture.target, 0o755);
  const child: ChildProcess = spawn("node", [launcher, "status"], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let targetPid: number | undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture timeout")), 5000);
      child.once("error", reject); child.once("exit", resolve);
      child.stdout!.once("data", bytes => { targetPid = Number(String(bytes).trim()); child.kill("SIGTERM"); });
    });
    expect(code).toBe(29);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (targetPid && Number.isSafeInteger(targetPid)) { try { process.kill(targetPid, "SIGKILL"); } catch { /* exited */ } }
      child.kill("SIGKILL");
    }
  }
});
test("launcher source anchors preserve exceptions before handoff and handoff before repair/resolver", () => {
  const source = readFileSync(launcher, "utf8");
  const hook = source.indexOf("const desktopPlan =");
  expect(hook).toBeGreaterThan(source.indexOf("const codexCliUpdateInspection ="));
  expect(hook).toBeLessThan(source.indexOf('if (process.argv[2] === "update" && installMethod === "mise")'));
  expect(hook).toBeLessThan(source.indexOf("const probe = bootRestoreProbe("));
  expect(hook).toBeLessThan(source.indexOf("const bunRuntime = resolveBun("));
  expect(source).toContain("const { launchProof, launchContext, inheritedEnv } = createNodeLaunchContext();");
  expect(source.match(/randomBytes\(32\)/g)).toHaveLength(1);
});
```

### NEW `tests/cli/cli-path-diagnostics.test.ts` (complete)

```ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCliPathDiagnostics, formatCliCommandLine, formatCliStatusHealthLabel, cliCommandDoctorChecks, type CliPathDiagnosticOptions, type CliPathObservation } from "../../src/cli/cli-path-diagnostics";
import type { DesktopCliRecordRead } from "../../src/lib/desktop-cli-record.mjs";
import { repoPath } from "../helpers/repo-root";

function record(platform: NodeJS.Platform, target: string): DesktopCliRecordRead {
  return { state: "ready", path: "fixture", record: { version: 1, enabled: true, bundle: { platform, cliExecutable: target } } };
}
function fixture(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[], extra: Partial<CliPathDiagnosticOptions> = {}) {
  const windows = platform === "win32";
  const normalize = (path: string) => windows ? path.toLowerCase() : path;
  const present = new Set(files.map(normalize));
  let observations = 0;
  const observe = (path: string): CliPathObservation => { observations++; return present.has(normalize(path)) ? { kind: "usable", realpath: path } : { kind: "missing" }; };
  const result = collectCliPathDiagnostics({ platform, env, cwd: windows ? "C:\\work" : "/work", home: windows ? "C:\\Users\\example" : "/Users/example", recordRead: record(platform, windows ? "C:\\App\\ocx.exe" : "/Applications/OpenCodex.app/Contents/MacOS/ocx"), observe, ...extra });
  return { result, observations };
}
const desktopBin = "/Users/example" + "/.opencodex-desktop/bin";
const shim = desktopBin + "/ocx";
const target = "/Applications/OpenCodex.app/Contents/MacOS/ocx";
describe("observed ocx PATH selection", () => {
  test("POSIX Desktop shim first, npm later; never executes candidates", () => {
    const { result } = fixture("darwin", { PATH: `${desktopBin}:/npm/bin` }, [shim, target, "/npm/bin/ocx"]);
    expect(result.pathFirst?.path).toBe(shim); expect(result.expectedExecutable).toBe(shim);
    expect(result.desktopFirstOnPath).toBe(true); expect(result.shellResolution).toBe("unobserved"); expect(result.issues).toEqual([]);
    const source = readFileSync(repoPath("src", "cli", "cli-path-diagnostics.ts"), "utf8");
    expect(source).not.toMatch(/child_process|Bun\.spawn|execSync|spawnSync/);
  });
  test("npm first is an issue even if that launcher can hand off", () => {
    const { result } = fixture("linux", { PATH: `/npm/bin:${desktopBin}` }, ["/npm/bin/ocx", shim, target]);
    expect(result.pathFirst?.path).toBe("/npm/bin/ocx"); expect(result.desktopFirstOnPath).toBe(false); expect(result.issues).toContain("path-first-not-desktop");
    expect(cliCommandDoctorChecks(result)[0]!.level).toBe("WARN");
  });
  test("POSIX empty and relative PATH elements resolve against cwd; absent PATH differs", () => {
    for (const path of [":/bin", ".:/bin", "tools:/bin"]) {
      const { result } = fixture("linux", { PATH: path }, ["/work/ocx", "/work/tools/ocx", "/bin/ocx", shim, target]);
      expect(result.pathFirst?.path).toBe(path.startsWith("tools") ? "/work/tools/ocx" : "/work/ocx");
    }
    expect(fixture("linux", {}, ["/work/ocx", shim, target]).result.pathFirst).toBeNull();
    expect(fixture("linux", { PATH: "" }, ["/work/ocx", shim, target]).result.pathFirst?.path).toBe("/work/ocx");
  });
  test("Windows PATHEXT order, case-insensitive Path, quotes and bundled expected exe", () => {
    const { result } = fixture("win32", { Path: '"C:\\App";C:\\npm', PathExt: ".CMD;.EXE" }, ["C:\\App\\ocx.exe", "C:\\App\\ocx.cmd", "C:\\npm\\ocx.cmd"]);
    expect(result.pathFirst?.extension).toBe(".cmd"); expect(result.expectedExecutable).toBe("C:\\App\\ocx.exe"); expect(result.issues).toContain("path-first-not-desktop");
    const selected = fixture("win32", { PATH: "c:\\app", PATHEXT: ".EXE;.CMD" }, ["C:\\App\\ocx.exe"]).result;
    expect(selected.desktopFirstOnPath).toBe(true);
  });
  test("Windows empty entry and cmd cwd candidate remain distinct from PATH first", () => {
    const row = fixture("win32", { PATH: "C:\\App", PATHEXT: ".EXE" }, ["C:\\App\\ocx.exe", "C:\\work\\ocx.exe"]).result;
    expect(row.pathFirst?.path).toBe("C:\\App\\ocx.exe"); expect(row.currentDirectoryCandidate?.path).toBe("C:\\work\\ocx.exe"); expect(row.issues).toContain("windows-current-directory-shadow");
    expect(fixture("win32", { PATH: ";C:\\App", PATHEXT: ".EXE" }, ["C:\\work\\ocx.exe", "C:\\App\\ocx.exe"]).result.pathFirst?.path).toBe("C:\\work\\ocx.exe");
  });
  test("invalid PATHEXT entries ignored; extensionless last; missing PATH and bounded scan", () => {
    const row = fixture("win32", { PATH: "C:\\npm", PATHEXT: ".EXE;bad;../evil;.CMD" }, ["C:\\npm\\ocx", "C:\\App\\ocx.exe"]).result;
    expect(row.pathFirst?.extension).toBe("");
    expect(fixture("linux", {}, [shim, target]).result.issues).toContain("path-missing");
    const long = fixture("linux", { PATH: Array(257).fill("/missing").join(":") }, [shim, target]);
    expect(long.result.issues).toContain("path-scan-truncated"); expect(long.observations).toBe(258); expect(long.result.desktopFirstOnPath).toBeNull();
    const extensions = Array.from({ length: 33 }, (_, i) => `.x${i}`).join(";");
    expect(fixture("win32", { PATH: "C:\\App", PATHEXT: extensions }, ["C:\\App\\ocx.exe"]).result.issues).toContain("path-scan-truncated");
  });
  test("missing or disabled Desktop is informational; bad records and missing target fail", () => {
    for (const state of ["missing", "disabled"] as const) {
      const row = fixture("linux", { PATH: "/npm" }, ["/npm/ocx"], { recordRead: { state, path: "fixture" } }).result;
      expect(row.desktopFirstOnPath).toBeNull(); expect(cliCommandDoctorChecks(row)[0]!.level).toBe("OK");
    }
    for (const issue of ["record-invalid", "record-too-large", "record-pending", "record-unreadable"] as const) {
      const row = fixture("linux", {}, [], { recordRead: { state: issue === "record-unreadable" ? "unreadable" : "invalid", path: "fixture", issue } }).result;
      expect(row.issues).toContain(issue); expect(cliCommandDoctorChecks(row)[0]!.level).toBe("FAIL");
    }
    const missing = fixture("linux", { PATH: "/npm" }, ["/npm/ocx"]).result;
    expect(missing.issues).toContain("desktop-target-missing"); expect(missing.issues).toContain("expected-command-missing");
  });
  test("unusable/unreadable observations have named codes and no false OK", () => {
    const row = fixture("linux", { PATH: "/bad" }, [], { observe: path => path === target ? { kind: "unusable" } : path === shim ? { kind: "unusable" } : { kind: "unreadable" } }).result;
    expect(row.issues).toEqual(expect.arrayContaining(["desktop-target-unusable", "expected-command-unusable", "path-unreadable"]));
    expect(row.desktopFirstOnPath).toBeNull();
    expect(cliCommandDoctorChecks(row)[0]!.level).toBe("FAIL");
  });
  test("realpath alias of owned command compares physically and output stays one safe line", () => {
    const row = fixture("linux", { PATH: "/alias" }, [], { observe: path => ({ kind: "usable", realpath: path === target ? target : shim }) }).result;
    expect(row.desktopFirstOnPath).toBe(true);
    const line = formatCliCommandLine(row); expect(line).toContain("shell=unobserved"); expect(line).not.toContain("\n");
    const unsafe = { ...row, pathFirst: { ...row.pathFirst!, path: "/fixture/line\nbreak/ocx" } };
    expect(formatCliCommandLine(unsafe)).not.toContain("\n");
  });
  test("connected status adapter renders one command line and preserves local labels", () => {
    const row = fixture("linux", { PATH: "/npm" }, ["/npm/ocx", shim, target]).result;
    for (const connected of [false, true]) {
      const rendered = `Health: ${formatCliStatusHealthLabel("healthy", row, connected)}${connected ? " (local)" : ""}`;
      const lines = rendered.split("\n"); expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.includes(" (local)")).toBe(connected);
      expect(lines[1]).toContain("ocx command:");
    }
    const json = JSON.parse(JSON.stringify({ proxy: { health: { message: "healthy" } }, cliCommand: row }));
    expect(json.proxy.health.message).toBe("healthy");
  });
  (process.platform === "win32" ? test.skip : test)("default observer rejects directory/non-executable and observes physical symlink without execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-observe-"));
    try {
      const bin = join(root, ".opencodex-desktop", "bin"); mkdirSync(bin, { recursive: true });
      const target = join(root, "ocx-target"); writeFileSync(target, "fixture; never executed"); chmodSync(target, 0o755);
      const shimPath = join(bin, "ocx"); symlinkSync(target, shimPath);
      const platform = process.platform;
      const options = { platform, home: root, cwd: root, recordRead: record(platform, target), env: { PATH: bin } };
      expect(collectCliPathDiagnostics(options).desktopFirstOnPath).toBe(true);
      rmSync(shimPath); mkdirSync(shimPath);
      expect(collectCliPathDiagnostics(options).issues).toContain("expected-command-unusable");
      rmSync(shimPath, { recursive: true }); writeFileSync(shimPath, "fixture"); chmodSync(shimPath, 0o600);
      expect(collectCliPathDiagnostics(options).issues).toContain("expected-command-unusable");
      expect(collectCliPathDiagnostics({ ...options, env: { PATH: target } }).pathFirst).toBeNull();
      rmSync(shimPath); symlinkSync(shimPath, shimPath);
      expect(collectCliPathDiagnostics(options).issues).toContain("path-unreadable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("status JSON field and human line, doctor independent registration, root dispatcher untouched", () => {
    const status = readFileSync(repoPath("src", "cli", "status.ts"), "utf8");
    expect(status).toContain("cliCommand: CliPathDiagnostics;"); expect(status).toContain("      cliCommand,");
    expect(status).toContain("formatCliStatusHealthLabel(health.label, cliCommand, remoteHub.connected)");
    const doctor = readFileSync(repoPath("src", "cli", "doctor.ts"), "utf8");
    expect(doctor).toContain('console.log("\\nocx command selection")'); expect(doctor).toContain('if (check.level === "FAIL") recordDoctorFailure()');
    expect(doctor.indexOf('console.log("\\nocx command selection")')).toBeLessThan(doctor.indexOf('console.log("\\nCodex runtime selection")'));
    const json = JSON.parse(JSON.stringify(fixture("linux", { PATH: "/npm" }, ["/npm/ocx", shim, target]).result));
    expect(json.pathFirst.path).toBe("/npm/ocx"); expect(json.shellResolution).toBe("unobserved");
  });
});
```

## Conditional activation and evidence (C-ACTIVATION-GROUNDING-01)

These are **planned test names**, not passing results. Read this table together with the complete files above; a guard without its activating fixture is incomplete implementation proof. Each test is scoped to an owned temp directory or injected IO. No test installs Desktop, reads a real home record, performs npm update, or executes discovered PATH candidates.

| Conditional path | Reachable scenario / observable result | Test name in the new files |
| --- | --- | --- |
| POSIX/Windows record home; reader injection | Home `/Users/example`, Windows USERPROFILE fixture, explicit temp recordPath; exact fixed file path | `fixed record location and injected reader path` |
| Missing record | File absent; `missing`, package plan continues | `fixed record location and injected reader path`; `record absence and disabled intent keep the package path; invalid records error` |
| Disabled intent, including pending journal | Version-1 false tombstone without bundle; no target read or execution | `reader open failure is unreadable and disabled intent wins over pending journal` |
| Reader rejects directory / metadata over limit | Directory or 65537-byte record; invalid/too-large without full-file allocation | `reader refuses oversized, malformed, pending and wrong-platform records` |
| Read-loop EOF and sentinel | Small valid record ends at EOF; descriptor's mocked metadata says size 1 but actual bytes exceed the cap; sentinel triggers too-large | `fixed record location and injected reader path`; `descriptor sentinel bounds growth after metadata and strict UTF-8 rejects corrupt bytes` |
| JSON/UTF-8 parse failure; invalid shape/version/boolean | `{`, array, null, number, unknown version, string enabled, bad UTF-8 | `reader refuses oversized, malformed, pending and wrong-platform records`; `descriptor sentinel bounds growth after metadata and strict UTF-8 rejects corrupt bytes` |
| Pending enabled record | Non-null `pending`; `record-pending`, no target chosen | `reader refuses oversized, malformed, pending and wrong-platform records` |
| Invalid bundle/platform/path/boundary | Null bundle, wrong platform, relative path, path over 32768 characters, newline path | `reader refuses oversized, malformed, pending and wrong-platform records` |
| Open fails other than ENOENT | Self-loop record symlink gives ELOOP, classified unreadable; descriptor cleanup applies to opened records only | `reader open failure is unreadable and disabled intent wins over pending journal` |
| Update-help short circuit | Valid Desktop fixture but `update --help` emits usage/0, no Desktop target output | `real update-help is untouched; opt-out and bad record activate distinct paths` |
| Update/uninstall/remove/internal namespace exceptions | Effective argv strips old proof before classifying; target IO trap never reached | `update, removal, internal inspection and codex-cli-update are exceptions` |
| Inspection under Bun existing guard | Existing `codexCliUpdateInspection && process.versions.bun` guard remains before hook | `launcher source anchors preserve exceptions before handoff and handoff before repair/resolver`; existing `tests/cli/ocx-launcher-source.test.ts` retained for hosted CI |
| Exact bypass and ordinary version | Bypass equals `1` only; ordinary `--version` eligible | `OCX_NO_DESKTOP_HANDOFF is exact and keeps user version handoff eligible`; real exception test |
| No/disabled record versus invalid/read error | Missing/disabled continues; each record issue is a fixed-code error | `record absence and disabled intent keep the package path; invalid records error` |
| Target relative/non-file rejection | Injected relative path or directory; target-invalid, zero spawn | `absolute regular executable target selected; self realpath never delegated` |
| POSIX X_OK / Windows existence check | EACCES fails; Windows mode is F_OK and process creation supplies final executable verdict | `target ENOENT resumes and EACCES or other errors fail`; `Windows realpath comparison is case insensitive and defers execute permission to spawn` |
| Physical self detection / case folding | Launcher alias and recorded target resolve to same path; Windows case differences also reject | `absolute regular executable target selected; self realpath never delegated`; Windows comparison test |
| Self path missing versus other realpath error | A vanished self module is skipped; ELOOP/EACCES reading a present identity fails closed | `absolute regular executable target selected; self realpath never delegated` |
| Target ENOENT / EACCES / ENOTDIR / ELOOP | Actual target absence continues; other IO failures error | `target ENOENT resumes and EACCES or other errors fail`; `real target disappearance resumes Bun; EACCES never resumes Bun` |
| Valid handoff before resolver/boot repair | Invalid Bun override would emit a warning on package path; successful Desktop target has no such warning and returns 23 | `real Node launcher regenerates proof, forwards argv/stdin, mirrors exit and bypasses Bun lookup`; launcher anchor test |
| Fresh proof, old argv-proof removal | Forged inherited context plus an old argv proof; child receives one new proof matching JSON | Real Node launcher test; `argv, inherited stdin, fresh proof and exit code; signal handlers cleaned` |
| Claude exported slot preservation / pollution deletion | API key is proof-listed; BASE_URL is not; real native-env builder preserves one and removes the other | `proof reaches the real Claude native-env consumer and keeps exported slots` |
| Spawn ENOENT versus all other errors | Sync throw or asynchronous error; ENOENT continues, EACCES/ENOEXEC fail | `child signal is retained and asynchronous spawn ENOENT alone resumes`; `synchronous spawn errors have the same ENOENT-only policy` |
| Error then late exit; settle once | Fake child emits error then exit 99; original error result wins, parent listeners removed | `child signal is retained and asynchronous spawn ENOENT alone resumes` |
| Parent signal forwarding and child termination | SIGTERM reaches child when only parent was signaled; parent waits and exits 29; child signal re-emitted by parent | `signal sent only to real launcher reaches its child and waits for child exit`; `real child terminating signal is mirrored by Node parent` |
| Platform signal set / kill race / null code | Windows has no HUP handler; throwing kill does not change completion; null code maps to 1 | `Windows forwards INT/TERM only and a kill race still settles from child exit` |
| Internal version probe env | Selected executable reports its own version; bypass set after inherited fixture env | `internal managing CLI probes set the bypass in the actual spawn environment` |
| POSIX empty/relative/unset PATH | `:`, `.`, `tools`, empty string, absent PATH; cwd candidates only when represented | `POSIX empty and relative PATH elements resolve against cwd; absent PATH differs` |
| Windows PATH names, quoted directories, PATHEXT, extensionless | Case-insensitive env keys and comparison; declared .CMD before .EXE; invalid extensions ignored | `Windows PATHEXT order, case-insensitive Path, quotes and bundled expected exe`; `invalid PATHEXT entries ignored; extensionless last; missing PATH and bounded scan` |
| cmd cwd versus PATH observation | cwd executable plus Desktop PATH candidate; distinct fields and cwd-shadow issue | `Windows empty entry and cmd cwd candidate remain distinct from PATH first` |
| Record states and target/shim observations | Missing/disabled informational; invalid record, missing or unusable target/shim FAIL | `missing or disabled Desktop is informational; bad records and missing target fail`; `unusable/unreadable observations have named codes and no false OK` |
| npm is PATH first | npm + owned shim present; path-first-not-desktop WARN, even if npm would hand off | `npm first is an issue even if that launcher can hand off` |
| Scan truncation/read failure | 257 PATH entries, 33 valid extensions, unreadable candidate; bounded work and null desktopFirstOnPath | `invalid PATHEXT entries ignored; extensionless last; missing PATH and bounded scan`; unusable/unreadable test |
| Physical alias and output sanitation | Alias realpath matches owned command; control character path renders on one safe line | `realpath alias of owned command compares physically and output stays one safe line` |
| Doctor OK/WARN/FAIL / additive status DTO | Valid Desktop first OK; ordering conflict WARN; invalid record/target FAIL contributes to doctorFailed; serialization preserves issue codes | The fixture tests above; `status JSON field and human line, doctor independent registration, root dispatcher untouched` |
| Connected status local labeling | Existing index appends `(local)` to the multiline view's last line; healthLabel explicitly preserves its first-line local label | `connected status adapter renders one command line and preserves local labels` (both connected values, simulated unchanged root rendering). |

The growth fixture patches `fstatSync` only inside a disposable **Node child**, followed by `syncBuiltinESMExports`, to deterministically simulate growth between metadata and read. It never monkey-patches the shared Bun test process. Windows native execute-format and signal handling remain 030 native evidence, not a claimed result of the injected Windows policy fixture.

## Field and enum lifecycle (PLAN-FIELD-CHAIN-01)

| Field / values | Creation → serialization → deserialization → every in-repository consumer |
| --- | --- |
| Persistent `version`, `enabled`, `bundle.platform`, `bundle.cliExecutable`; optional `pending` gate | wp1 writer (010) → atomic version-1 `cli.json` → bounded `readDesktopCliRecord` → `planDesktopCliHandoff`, `collectCliPathDiagnostics`. Only settled enabled records expose the narrowed bundle DTO. No wp2 write/serializer. |
| Reader `state`: missing/disabled/ready/invalid/unreadable; `path`; `record`; `issue` | Reader IO/schema branches → process-local DTO (not separately persisted) → no extra parser → handoff plan and diagnostics. Tests enumerate the five states. Record issue values are `record-invalid`, `record-too-large`, `record-pending`, `record-unreadable`; plan maps them to stderr errors, diagnostics maps them to status JSON and doctor FAIL. |
| Plan `kind`, `reason`, `issue`, `target` | `planDesktopCliHandoff` creates continue(reason excluded/missing/disabled/target-missing), error(fixed record/target code), handoff(target realpath) → process-local only → `bin/ocx.mjs` branches → continue/update/Bun, fixed-code exit 1, or transport call. Tests consume every discriminant. |
| Transport result kind continue/error/exit, issue spawn-failed, code, signal | Spawn throw/events + cleanup → process-local promise result → launcher awaits → ENOENT continuation, fixed error exit 1, numeric exit or signal re-emission. Test doubles and real Node subprocesses consume it; no IPC record/JSON form added. |
| Existing launch-context `version`, `proof`, `anthropicEnvSlots`, `codexCliInspectionEnv` | Extracted Node factory snapshots parent env and generates random proof → `JSON.stringify` to OCX_NODE_LAUNCH_CONTEXT + exactly one argv proof → `src/cli/index.ts:209 initializeNodeLauncherContext()` consumes/validates/removes both → `trustedNodeLauncherContext()` → `deleteUntrustedAnthropicSlots` / Claude builders; inspection resolver continues consuming its original proof-bound fields. No schema/version change. |
| `OCX_NO_DESKTOP_HANDOFF=1` | `probeVersionOnce` or handoff child env copy (never mutates parent's env) → subprocess env → next package launcher's exact-1 exception → ordinary package path. Compiled CLI does not use it as ownership evidence. Tests verify generated env, exact value and normal --version eligibility. |
| `CliPathObservation.kind`, `realpath` | Default stat/access/realpath IO or fixture observation → process-local only → collector; real filesystem cases are covered by `default observer rejects directory/non-executable and observes physical symlink without execution`. missing skips candidate; unusable flags target/shim failures; unreadable marks incomplete PATH; usable creates candidates and physical comparison. |
| `CliPathCandidate.path`, `realpath`, `pathIndex`, `extension`; `candidates`, `pathFirst`, `currentDirectoryCandidate` | Observe scan, in PATH then PATHEXT order; cwd marker index -1 kept separate → nested `cliCommand` JSON via handleStatus → external JSON clients may inspect without a new in-repo parser → formatter, doctor checks and fixture tests use path/physical order. All DTO fields are plain values, no functions/undefined. |
| `configured`, `recordState`, `expectedExecutable`, `handoffTarget`, `desktopFirstOnPath`, `shellResolution` | Collector derives intention/expected target from reader and observed order; null firstness means no configured Desktop or incomplete scan; shellResolution is always unobserved → status.json.cliCommand / schemaVersion 1 → root JSON.stringify only (`index.ts:1705–1707`) → external callers + tests; human `formatCliCommandLine` and `cliCommandDoctorChecks` consume the same observation. No runtime/service mutation consumes them. |
| `issues` closed union | Collector adds unique record issue codes, desktop-target-missing/unusable, expected-command-missing/unusable, path-missing, path-first-not-desktop, path-unreadable, path-scan-truncated, windows-current-directory-shadow → status JSON → no local deserializer → formatter lists codes, doctor maps record/target/expected errors to FAIL, other issues to WARN. Fixtures cover all values; no freeform record text becomes a code. |
| `CliStatusJson.cliCommand` | `collectStatus` computes the DTO once and includes it in json → unchanged root JSON serializer → consumers tolerant of additive fields; no new local status parser exists (`rg CliStatusJson` finds its declaration/view only). Human view uses `healthLabel` adapter, raw JSON proxy health fields unchanged. |
| Doctor level OK/WARN/FAIL | `cliCommandDoctorChecks` creates an existing severity shape → not persisted → `runDoctor` prints, FAIL calls existing recordDoctorFailure → existing doctorFailed exit semantics. WARN ordering and unknown shell state do not become FAIL. |

`formatCliStatusHealthLabel` creates the view-only multiline label from health text, diagnostics and the connected/local flag; status is its only production consumer, while its fixture tests simulate the unchanged root rendering in both flag states. It does not alter or serialize JSON health.

The issue union is diagnostic, not an executable allowlist. New reader/plan DTOs never enter service ownership, supervision or compatibility claims. In particular `handoffTarget` is not the running proxy binary and `configured` is not “Desktop is currently supervising”.

## Guard strength and named bypasses (PLAN-BYPASS-NAMED-01)

Tier notation here identifies **E8 executable checks** versus **E7 documented/operator-followed boundaries**; it does not assert that a host hook recognizes this application logic. All bypassable checks are described as local guards or early warnings. **Final global enforcement layer: none.**

| Guard / tier | Executing surface | Known bypass path | Residual risk / honest wording |
| --- | --- | --- | --- |
| E8 bounded/schema reader | Reader inside current Node launcher and Bun diagnostics | Same-user process replaces record; older package launchers do not call the reader | Configuration validation and early warning; IDs/hashes are not authenticity or service authority. |
| E8 target validation / self guard | Current package launcher before spawn | Explicit compiled executable, different package launcher, direct source CLI; TOCTOU between validation and process creation | Prevents this invocation's self-delegation and obvious invalid target. Cannot bind binary authenticity or defeat same-user modification. |
| E8 ENOENT-only fallback | Current handoff planner/async child | Bypass flag; old launcher; directly invoke npm package path whose version lacks handoff | Chosen-target errors fail this launch; does not promise every package command is forced to Desktop. |
| E8 exceptions and child recursion opt-out | Current package launcher; managing-cli child env | User sets exact bypass flag or executes update/removal/internal namespace | Explicit escape hatch; does not bypass L1 runtime/service guards. |
| E8 argv proof parser | Existing CLI context parser, fed by extracted plain-Node factory | Same-user caller can directly supply argv/env; calling Node under Bun or bypassing launcher loses the original pre-dotenv capture | Provenance for ordinary Node invocations, not an identity/security barrier against a local attacker. A11 shim review stays mandatory. |
| E8 observe-only tests / repository gates | Named Bun regressions, structure/ratchet/layout gates; parent's hosted CI | Not running tests, untracked files not visible to git-index gates, older-head/skipped CI | Early warning for regressions in the observed tree; no claim of OS shell enforcement or native Windows proof. |
| E7 shell-selection limitation | Public docs, status/doctor wording, native smoke reviewer | Aliases/functions, shell cache, absolute paths, zsh -f, later nvm use, stale parent env, Windows system PATH or cmd cwd | Reports only process PATH observations; shellResolution remains unobserved. |
| E7 staging and review protocol | Parent before structure/privacy/ratchet CI; independent 030 reviewer | Ignoring plan or treating unstaged local gate pass as CI evidence | Requires real current-head evidence; no code-quality/security PASS is granted by this plan. |

## Goalplan acceptance mapping

The read-only parent goalplan `opencodex-make-opencodex-desktop-own-the-ocx-com` was inspected without calling any goal/loop/FSM commands. The IDs below preserve its actual criterion identity. Goalplan c-1 says “Linux deb unchanged”; A9 accepts adding the same user shim/rc on deb while keeping `/usr/bin/ocx`. Parent should reconcile that wording in its own goalplan; this worker does not edit it.

| Criterion | wp2 acceptance / observable evidence | Ownership and completion boundary |
| --- | --- | --- |
| c-1 app-only command after Desktop start | Reader can consume wp1's installed record and diagnostics name the POSIX shim or Windows bundled exe | wp1/030 own actual installation/new-terminal proof. Reader alone does not satisfy c-1. |
| c-2 npm/bun/brew precedence; Windows user PATH | POSIX/Windows fixtures show Desktop-first versus npm-first; cwd/system PATH conflicts do not show false success | wp2 contributes diagnostics only; wp1/030 supply real shell/registry selection evidence. |
| c-3 handoff with recursion guard and escape hatch | Fresh proof and one argv proof, stdin/argv, exit/signal, target self/ENOENT/EACCES, exceptions and exact bypass tests pass | Primary wp2 criterion. Existing package update/Bun/inspection behavior remains available; L1 guards intact. |
| c-4 foreign refusal/idempotence/removal/opt-out | Missing/disabled records continue; invalid/pending refuse, physical self rejects; package removal never hands off | wp2 covers consumers; wp1 owns generated-file ownership, idempotence and cleanup tests. |
| c-5 typecheck/focused tests/structure/privacy/current-head CI | Execute the verifier table after implementation, with dependencies present; no baseline failure reported as passing | wp2 contributes TS/gate evidence. Cargo/native and exact-head required hosted CI belong to 030; current planning typecheck/layout are incomplete. |
| c-6 independent code and security review PASS | Reviewer checks record trust, proof extraction, no supervision marker creation, target failure policy and tested provenance chain | Parent/030 obtain independent reviews. Plan and syntax checks cannot mark c-6 met. |
| c-7 admin squash to dev with docs | These diffs and public text are integrated with 030's en/ko/locale updates and stacked PR retargeting | Parent owns PR/rebase/merge authority; this worker performs none. |

| Additional acceptance | Proving observation |
| --- | --- |
| No user `--version` blanket exemption | Effective argv `--version` handoffs unless exact bypass is present. Internal probe sets bypass independently. |
| No runtime/service authority widening | No code consumes record IDs as authority; no new OCX_DESKTOP_SUPERVISED marker is stamped; #6809 guard logic unchanged. |
| Root dispatcher untouched | No `src/cli/index.ts` diff; current human renderer still receives its view string and JSON remains stdout-clean. |
| New file scope and docs ownership complete | Both test basenames registered in both rosters; runtime row stays one row/600 lines; source references resolve when staged by parent. |
| Platform claims bounded | POSIX subprocess tests and cross-host Windows policy fixtures distinguished from native Windows execution and new-terminal selection. |

## Open-PR integration notes (read-only diff inspection)

`gh pr diff 6807`, `gh pr diff 6809` and `gh pr diff 6802` were actually read. Their states were OPEN at the inspection below; this is a dated planning observation, not future merge evidence.

| PR / inspected head | Actual overlapping change | Rebase instructions and preserved anchor |
| --- | --- | --- |
| [#6807](https://github.com/lidge-jun/opencodex/pull/6807), `b880f9c6b9efaf161336f0b30ec8d5fcc3cea2b4` | Adds `findDesktopCli`/`findPathBun` import, `pinnedBunVersion`, advisory Desktop guidance in `fail`, and validated PATH Bun fallback in `resolveBun` | Keep its resolver body and advisory discovery unchanged. Merge the new handoff import as an independent import. Handoff is before `const bunRuntime = resolveBun(...)`, so successful handoff never probes/install-selects Bun. Do not turn `findDesktopCli` into the executable target selector. Existing source-oracle substring checks for snapshot constants remain present inside the extracted factory. |
| [#6809](https://github.com/lidge-jun/opencodex/pull/6809), `b3b72189078137a00b32571de861d3b963582f44` | Imports live supervision; adds latches/refusals in `runPackageManagerSelfUpdate`, direct recovery, service refresh, pre-stop, replacement and post-install | Preserve every supervision check and latch. Handoff has update/removal exceptions, so it does not move these commands into another owner's updater. In its inspected head the semantic insertion boundary is after the inspection block around line 999, instead of baseline 963. Use `const codexCliUpdateInspection` and the following mise-update `if` as anchors. The public command record grants no stop/replace/restore authority. |
| [#6802](https://github.com/lidge-jun/opencodex/pull/6802), `1718fcad8ba90e6afd12a8c5a03f7fc222f69742` | `selectStatusStartupHealth` returns `{ startup, startupSource }`; status adds `startupSource` and live supervision; doctor changes restart-safety source and advice | Keep those type/signature/caller changes. Add `cliCommand` as a separate additive field near `versionSkew`; compute command diagnostics at `collectStatus` entry, not by changing startupSource or serviceSummary. Doctor's new section is after Paths and before response-state sections, leaving its restart-safety anchor around 1380 alone. Its supervision `unsupported` is not Windows PATH success. |

Parent's manual stack: wp2 consumes the final wp1 contract; PR2 initially targets the open wp1 branch, then retargets/rebases to `dev` after PR1 lands. Do not blindly replay baseline line patches over L1. Regenerate these narrow diffs against the integrated source and rerun only checks affected by the rebase, then inspect required CI for the exact new head. Missing, skipped, cancelled, awaiting approval or older-head results are not passing evidence.

`structure/runtime.md` is also shared with all three L1 PRs. Preserve their text and keep this handoff contract in the existing entrypoint row with **zero line growth**. Public desktop-guide edits belong to 030's coordinated change rather than another competing edit here.

## File-size and structure budgets

Read `scripts/file-size-ratchet.ts`, `tests/fixtures/file-size-baseline.json` and `structure/manifest.json`. `THRESHOLD=2000`; an uncapped file at **2000 or more** fails, so its usable ceiling is **1999**, not 2000. A recorded cap is stricter and only decreases via `Math.min` (`scripts/file-size-ratchet.ts:188`). None of the modified files below has a per-file recorded cap at the baseline. Structure's separate `sizeBudgetLines=600` still applies, including runtime at exactly 600. `.d.mts` does not match SCAN_EXTENSIONS and needs a manual small-file budget; do not claim the ratchet covers it.

Counts below use the ratchet's newline-count convention and the complete proposed code/diffs. They are planning budgets, not post-implementation results. Keep room for reviewer fixes and recalculate against the current integration head.

| Path | Baseline lines | Proposed lines | Applicable ceiling | Budget rule |
| --- | ---: | ---: | ---: | --- |
| `src/lib/desktop-cli-record.mjs` | NEW | 63 | 1999 | New scanned source/test, no recorded cap |
| `src/lib/desktop-cli-record.d.mts` | NEW | 19 | 120 | Manual declaration ceiling; ratchet does not scan .mts |
| `src/lib/desktop-cli-handoff.mjs` | NEW | 84 | 1999 | New scanned source/test, no recorded cap |
| `src/lib/desktop-cli-handoff.d.mts` | NEW | 20 | 120 | Manual declaration ceiling; ratchet does not scan .mts |
| `src/cli/cli-path-diagnostics.ts` | NEW | 124 | 1999 | New scanned source/test, no recorded cap |
| `tests/cli/ocx-launcher-desktop-handoff.test.ts` | NEW | 276 | 1999 | New scanned source/test, no recorded cap |
| `tests/cli/cli-path-diagnostics.test.ts` | NEW | 129 | 1999 | New scanned source/test, no recorded cap |
| `bin/ocx.mjs` | 1120 | 1151 | 1999 | No recorded cap; keep below 2000 |
| `src/service/managing-cli.ts` | 200 | 201 | 1999 | No recorded cap; keep below 2000 |
| `src/cli/status.ts` | 937 | 941 | 1999 | No recorded cap; keep below 2000 |
| `src/cli/doctor.ts` | 1722 | 1729 | 1999 | No recorded cap; keep below 2000 |
| `scripts/test-layout/layout.json` | 1981 | 1983 | 1999 | No recorded cap; keep below 2000 |
| `tests/fixtures/test-layout-expected.json` | 1179 | 1180 | 1999 | No recorded cap; keep below 2000 |
| `structure/runtime.md` | 600 | 600 | 600 | Replace same number of lines; zero headroom |
| `structure/cli-management.md` | 107 | 111 | 600 | No recorded cap; obey structure 600 |
| `structure/ops/service-and-sidecars.md` | 541 | 543 | 600 | No recorded cap; obey structure 600 |
| `docs-site/src/content/docs/getting-started/installation.md` | 125 | 131 | 1999 | No recorded cap; keep below 2000 |
| `docs-site/src/content/docs/reference/cli.md` | 324 | 326 | 1999 | No recorded cap; keep below 2000 |
| `src/cli/index.ts` | 1976 | 1976 | 1999 | OUT; no modifications |

The plan itself is under `devlog/`, excluded by the file-size ratchet (`scripts/file-size-ratchet.ts:21–22`) and outside the structure-doc 600-line budget. Its full code/diffs are intentionally not scattered into unassigned companion files. Do not run `ratchet:update` to mask growth. The layout manifest has only 16 lines of projected room before its uncapped maximum; combine entries on existing JSON lines or split tooling under an explicit parent-approved plan if concurrent registrations exhaust it.

`structure/manifest.json` already maps `bin/`, `src/lib/`, `src/cli/` and `src/service/` to runtime; CLI management maps `src/cli/`; service-and-sidecars documents lib helpers. No new source directory/top-level area or manifest ownership change is required. `structure/desktop-shell.md` and the public desktop guide are reviewed/updated by 010/030 for the installer. Before implementation review, parent also reviews the existing broad map dependents for `src/lib/`/`src/cli/` (overview, config, local-messaging, byte-accounting, responses-wire-shapes, responses-failover, responses-spend, inventory, gui-and-management-api, dashboard-and-usage, clients/integrations, clients/chatgpt-desktop, clients/claude-desktop and ops/docs-and-release). Their unrelated contracts receive no copied handoff prose; update only a changed local consequence. Runtime owns entrypoint ordering, CLI management owns command diagnostics, Desktop-shell owns generated-command installation.

## Verifier grounding and actual planning-time results

All shell invocations in this delegated task used the assigned checkout as workdir. Only this document was written. No code/new test files were created or test suites beyond the two layout guard files were run. Baseline checks **do not prove the future changes**. Dependencies were not installed: changing lockfiles or setting up the checkout exceeds this one-document worker scope.

| Command (run once for the verification observation unless noted) | Observed exit / outcome | Does it read this change target? |
| --- | --- | --- |
| `bun run typecheck` | **1**, TS2688: missing `bun-types`; no implementation typecheck proof | `tsconfig.json` has `include: ["src"]`; after creation it reads the new diagnostics TS/declarations and modified status/doctor/probe. It does not typecheck `.mjs` JS, tests, bin, or prose. Baseline dependency failure means not ready. |
| `bun run structure:check` | **0**, structure/ SSOT checks passed at baseline | `scripts/structure-ssot.ts:301,354,373` reads manifest/docs; after parent's staging it checks new source-path references. It does not read this devlog plan or prove runtime behavior. |
| `bun run privacy:scan` | **0**, Privacy scan passed at baseline | `scripts/privacy-scan.ts:411–414` scans tracked files with gitLsFiles; future tracked source/tests/docs and this plan are included, but this currently untracked plan was not read by that run. No post-plan privacy PASS is claimed. |
| `bun scripts/file-size-ratchet.ts` | **0**, file-size ratchet passed at baseline | `scanRepo → gitLsFiles` (`scripts/file-size-ratchet.ts:133–149`) observes tracked scanned extensions and excludes devlog; after staging it reads source/tests/docs. It does not observe `.d.mts` or this plan. |
| `node --check bin/ocx.mjs` | **0**, baseline syntax accepted | Direct argument reads the existing launcher. It does not follow imports, execute handoff, or parse the proposed diff. Rerun after implementation. |
| `bun scripts/test-with-pinned-bun.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | **1**, Bun 1.4.0, 0 pass / 2 fail; preload cannot find `zod/v4`. The command was repeated once only to retain the explicit exit receipt; same import failure | Direct arguments read both layout guards, whose resolver/oracle read layout.json and expected fixture. They observe the new names only after creation/registration; this baseline could not start assertions. No layout PASS. |
| Node stdin syntax checks for the two proposed `.mjs` code fences | **0** for reader and **0** for handoff | The extraction command below reads this exact document's NEW JS bodies and passes them to `node --check --input-type=module`. It parses the proposed code only; no function/test/import is executed. |
| `bun scripts/test-with-pinned-bun.ts tests/cli/ocx-launcher-desktop-handoff.test.ts tests/cli/cli-path-diagnostics.test.ts` | **NEW 파일 생성 후 실행**; no exit result yet | Direct arguments target both new files and their imports. Requires checkout dependencies. POSIX real-launcher cases skip on Windows, so a green Windows policy fixture is not native signal/terminal proof. |

Copy-paste syntax-extraction verifier (already run against the two JS bodies, both exit 0; no output files):

```sh
python3 - <<'PY'
from pathlib import Path
import re, subprocess
text = Path('devlog/_plan/261009_desktop_owned_path_cli/020_launcher_handoff_and_diagnostics.md').read_text()
for match in re.finditer(r'### NEW `([^`]+\.mjs)`[^\n]*\n\n```js\n(.*?)\n```', text, re.S):
    result = subprocess.run(['node', '--check', '--input-type=module'], input=match[2], text=True, capture_output=True)
    print(match[1], 'exit', result.returncode)
    if result.returncode:
        raise SystemExit(result.returncode)
PY
```

After implementation, execute only the two focused new files, the two layout guards, typecheck and the relevant read-only gates above as the local wp2 minimum. Existing launcher, managing-cli, Claude provenance and Codex inspection suites remain required hosted-CI coverage. The command-local import graph cannot discover source-as-data tests, so retain the explicit source-oracle/layout checks. This plan does not claim that import-connected testing supersedes them.

030 owns docs-site dependency/build validation, independent code/security review, exact-head required hosted CI and supported native terminal smoke. Those commands and native scenarios belong to its verifier ledger rather than an unrun PASS here. Parent must stage new source/test paths before its structure/ratchet/privacy validation, because index-based coverage deliberately excludes untracked leftovers. No required verification may be replaced with a green baseline or older-head run.

## Parent handoff: remaining decisions and risks

1. Reconcile **64 KiB record limit**, settled `pending` semantics and platform/path normalization with 010's final A4 writer. If 010 needs a larger bounded journal, align both writer and reader in the parent plan before implementation. Disabled tombstones remain valid without bundle fields.
2. Preserve the newly extracted Node proof factory as plain-Node pre-dotenv work. A11's POSIX shim proof generator belongs to 010 and independent security review; Windows direct bundled execution keeps its existing stripping behavior. This wp2 package handoff must not silently substitute a Desktop marker for proof.
3. The multiline status health **view** is the narrow adapter needed by the no-index-edit constraint. Its connected/local labels have an explicit fixture; if reviewers require a dedicated root-renderer field, report that scope expansion before touching index.ts. Raw JSON health remains unchanged.
4. Rebase semantically over #6807/#6809/#6802 and the current dev head. Tests intentionally make missing target enter the resolver by observing the invalid override warning; they do not depend on absence of #6807's PATH Bun fallback.
5. Current typecheck/layout verifier failures are dependency-preflight gaps (`bun-types`, `zod/v4`). Parent's dependency-equipped implementation checkout or exact-head CI must supply real passing evidence; this worker neither repaired dependencies nor claimed implementation success.
6. Reconcile goalplan c-1's Linux wording with accepted A9; preserve `/usr/bin/ocx` while adding the supported user shim/rc. This worker made no goalplan edits.
7. Windows machine PATH, cmd cwd, stale parent environments and shell aliases remain named bypasses. Native Windows selection/process smoke belongs to 030. Record intent or fixture success alone cannot close c-1/c-2.

### Direct plan privacy observation

The direct `scanText` verifier initially returned exit 1 for four **synthetic `/Users/example` home-path literals**: the scanner allows that placeholder under tests/docs-site but not under devlog. The complete test snippets now build the fixture path from `/Users/example` plus its suffix; their runtime example paths are unchanged. No real user path was introduced and the scanner itself was not modified. The subsequent direct plan result is recorded below; the earlier repository-wide PASS did not inspect this untracked file.

```sh
bun -e 'import { readFileSync } from "node:fs"; import { scanText } from "./scripts/privacy-scan.ts"; const path = "devlog/_plan/261009_desktop_owned_path_cli/020_launcher_handoff_and_diagnostics.md"; const findings = scanText(path, readFileSync(path, "utf8")); console.log(`plan findings: ${findings.length}`); process.exit(findings.length ? 1 : 0);'
```

Direct plan verifier: **exit 0, 0 findings** after the placeholder construction edit; it explicitly reads this document through `readFileSync(path)` and `scanText(path, text)`. This is privacy-pattern proof for the plan, not runtime/type/test proof.
