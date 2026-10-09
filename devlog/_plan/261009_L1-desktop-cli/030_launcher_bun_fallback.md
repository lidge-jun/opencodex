# 030 — wp3: validated PATH Bun fallback and lifecycle version notice

Planning snapshot: 2026-10-09, lane `.tmp/lanes/L1-desktop-cli`. PR C targets `dev`, depends only on wp1, and is independent of wp2. This is an implementation specification, not evidence that code or tests have run. Accepted policy is `000_plan.md` and Pascal D1–D5 as amended in `002_consultation.md`; the explicit wp3 packet clarifies D2 to allow any stable minor at or above the pinned minor within the same major. No import of `src/service/desktop-supervision.mjs` is permitted, directly or transitively from the new helpers.

When the bundled runtime cannot be recovered, the Node launcher will accept the first validated Bun on absolute PATH entries. With `dependencies.bun = "1.4.2"`, the accepted interval is **>=1.4.0 and <2.0.0**. This is an accepted compatibility policy, not proof that every release in that interval behaves identically. Override, bundle and permitted installer recovery retain priority. A lifecycle command entering the Bun CLI will warn once when an identity-checked live listener reports a different version, within a 200 ms diagnostic budget.

## Scope and disposition

IN: Node-safe PATH runtime discovery; explicit missing-bundle fallthrough; PATH provenance `process`; a version-only stderr fallback notice; a macOS Desktop CLI pointer in terminal failure; Bun CLI lifecycle skew notice; focused tests; current architecture and installation documentation.

OUT: Desktop process-supervision evidence or command competition guards (wp2/wp5), silent Desktop delegation, PATH/shim installation, OS service policy changes, user-home writes, runtime restart/stop, package version changes, dependency installation changes, source/test implementation during this planning task, full local suite, merge/release. No wp2 dependency may be introduced to solve a wp3 issue.

**Node-launcher update exception:** `bin/ocx.mjs:951–955` exits for update help; `:964–975` handles mise; `:977–980` dispatches npm/pnpm self-update before `resolveBun` at `:996` or `src/cli/root.ts`. This PR explicitly excludes a skew notice for these Node-managed update branches. Bun-global/source/standalone update dispatch reaches `runCli` and is covered. Do not pretend a `root.ts` hook covers npm/pnpm update. A future Node notice would need a separate Node-safe identity/formatting implementation or shared ESM factoring and is not added here. wp5's updater supervision veto is a separate commitment.

## Verified anchors and file-size budget

All paths and line numbers below were read in the lane checkout. Numbers are pre-change anchors; implementation must relocate by function name after earlier commits. No source edit was made to collect them.

Ratchet authority: `scripts/file-size-ratchet.ts:4` threshold 2000; `:105–107` counts newline-delimited lines; `:115–125` rejects an uncapped file at **>=2000** and rejects any capped file above its stored cap. `tests/fixtures/file-size-baseline.json` contains none of the following paths. Thus their legal maximum is 1999, not 2000. No exemption or baseline increase is planned. `.d.mts` ends in `.mts`, which is not in `SCAN_EXTENSIONS` at `:7–19`, so declarations have no ratchet cap. `devlog/` is excluded at `:22–28`.

| Planned file | Action | Current lines | Ratchet maximum | Current headroom |
|---|---|---:|---:|---:|
| `bin/ocx.mjs` | MODIFY | 1120 | 1999 | 879 |
| `src/lib/bun-path-runtime.mjs` | NEW | 0 | 1999 | 1999 |
| `src/lib/bun-path-runtime.d.mts` | NEW | 0 | not scanned | not capped |
| `src/cli/version-skew-notice.ts` | NEW | 0 | 1999 | 1999 |
| `src/cli/root.ts` | MODIFY | 147 | 1999 | 1852 |
| `tests/cli/ocx-launcher-runtime.test.ts` | MODIFY | 385 | 1999 | 1614 |
| `tests/cli/ocx-launcher-source.test.ts` | MODIFY | 163 | 1999 | 1836 |
| `tests/cli/cli-version-skew.test.ts` | MODIFY | 131 | 1999 | 1868 |
| `structure/runtime.md` | MODIFY | 600 | 1999 | 1399 ratchet; **0 structure** |
| `structure/ops/docs-and-release.md` | MODIFY | 600 | 1999 | 1399 ratchet; **0 structure** |
| `structure/ops/service-and-sidecars.md` | MODIFY | 538 | 1999 | 1461 ratchet; **62 structure** |
| `docs-site/src/content/docs/getting-started/installation.md` | MODIFY | 125 | 1999 | 1874 |
| `docs-site/src/content/docs/ko/getting-started/installation.md` | MODIFY | 111 | 1999 | 1888 |

`structure/manifest.json:3` separately caps each structure document at 600 lines. Replace the existing runtime row and release invariant at equal line count. No manifest/INDEX ownership change: new sources are inside the already-owned `src/lib/` and `src/cli/` areas (`structure/INDEX.md:128,145`). Review all mapped docs for these areas; only the three listed structure documents describe a changed contract. Other mapped documents cover unrelated transports, integration validation or management behavior and require no copied prose. New source files require no test-layout registration; no NEW test file is planned, so neither `scripts/test-layout/layout.json` nor `tests/fixtures/test-layout-expected.json` changes.

## NEW `src/lib/bun-path-runtime.mjs`

Anchor: absent at planning snapshot. Entire proposed content below. Node-compatible ESM is necessary because `bin/ocx.mjs` cannot import TypeScript. The `io` seam permits deterministic clocks, Windows paths and filesystem failures in existing Bun tests. Real filesystem default still calls the existing size validator (`src/lib/bun-binary-validator.mjs:12–18`, minimum 1,000,000 bytes at `:6`); size alone is not sufficient for PATH acceptance.

`deadlineMs` is a total scan budget, not an independent budget multiplied by PATH length. Production passes 750 ms; every spawn receives only the remaining time. Absolute directories are required before filesystem access; win32 must be a drive-rooted or UNC absolute path, not `C:relative` or `\root-relative`. Windows looks up PATH case-insensitively and never uses PATHEXT. Realpath deduplicates candidates. Stable SemVer may carry build metadata; prerelease/canary, malformed versions, wrong major and lower minor fail. No rejected path or error is printed. SIGKILL bounds a version child which would ignore SIGTERM; no shell or `.cmd`/`.bat` resolution is allowed.

```js
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { isRealBunBinary } from "./bun-binary-validator.mjs";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_BYTES = 4096;

function stableVersion(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = STABLE.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

/** Discover, validate and version-check the first usable absolute PATH Bun. */
export function findPathBun({
  env = process.env, platform = process.platform, pinnedVersion,
  deadlineMs = 750, io = {},
}) {
  const pin = stableVersion(pinnedVersion);
  if (!pin || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  const paths = platform === "win32" ? win32 : posix;
  const absolute = value => paths.isAbsolute(value)
    && (platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value));
  const now = io.now ?? (() => performance.now());
  const end = now() + deadlineMs;
  const realpath = io.realpath ?? realpathSync.native;
  const stat = io.stat ?? statSync;
  const access = io.access ?? accessSync;
  const validate = io.isRealBunBinary ?? isRealBunBinary;
  const spawn = io.spawnSync ?? spawnSync;
  const key = platform === "win32"
    ? Object.keys(env).find(name => name.toLowerCase() === "path") : "PATH";
  const directories = (env[key ?? "PATH"] ?? "").split(platform === "win32" ? ";" : ":");
  const seen = new Set();
  for (const directory of directories) {
    if (now() >= end) break;
    if (!directory || !absolute(directory)) continue;
    try {
      const path = realpath(paths.join(directory, platform === "win32" ? "bun.exe" : "bun"));
      if (!absolute(path)) continue;
      const identity = platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!stat(path).isFile()) continue;
      access(path, constants.X_OK);
      if (!validate(path)) continue;
      const remaining = Math.floor(end - now());
      if (remaining <= 0) break;
      const result = spawn(path, ["--version"], {
        env, encoding: "utf8", timeout: remaining, maxBuffer: MAX_VERSION_BYTES,
        killSignal: "SIGKILL", shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (now() >= end) break;
      if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") continue;
      const version = result.stdout.trim();
      const candidate = stableVersion(version);
      if (!candidate || candidate[0] !== pin[0] || candidate[1] < pin[1]) continue;
      return { path, version };
    } catch {
      // Unreadable, unexecutable, vanished or invalid: try the next absolute candidate.
    }
  }
  return null;
}

/** Failure-text pointer only. Never execute or delegate to this binary. */
export function findDesktopCli({ platform = process.platform, home = homedir(), io = {} } = {}) {
  if (platform !== "darwin") return null;
  const stat = io.stat ?? statSync;
  const access = io.access ?? accessSync;
  for (const path of [
    "/Applications/OpenCodex.app/Contents/MacOS/ocx",
    posix.join(home, "Applications/OpenCodex.app/Contents/MacOS/ocx"),
  ]) {
    try {
      if (!stat(path).isFile()) continue;
      access(path, constants.X_OK);
      return path;
    } catch { /* Missing or not executable: no pointer for this candidate. */ }
  }
  return null;
}
```

## NEW `src/lib/bun-path-runtime.d.mts`

Anchor: absent. Entire proposed declaration; use narrow structural seams rather than incompatible platform-specific overloads.

```ts
export interface PathBunIo {
  now?: () => number;
  realpath?: (path: string) => string;
  stat?: (path: string) => { isFile(): boolean };
  access?: (path: string, mode: number) => void;
  isRealBunBinary?: (path: string) => boolean;
  spawnSync?: (path: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    killSignal: "SIGKILL";
    shell: false;
    windowsHide: true;
    stdio: ["ignore", "pipe", "pipe"];
  }) => { status: number | null; stdout?: string; signal?: string | null; error?: unknown };
}
export declare function findPathBun(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pinnedVersion: string;
  deadlineMs?: number;
  io?: PathBunIo;
}): { path: string; version: string } | null;
export declare function findDesktopCli(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  io?: Pick<PathBunIo, "stat" | "access">;
}): string | null;
```

## MODIFY `bin/ocx.mjs`

### Imports (`isRealBunBinary` anchor, line 36)

Before:
```js
import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";
```
After:
```js
import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";
import { findDesktopCli, findPathBun } from "../src/lib/bun-path-runtime.mjs";
```

### Package dependency pin (`currentPackageVersion`, lines 90–96)

Keep `currentPackageVersion` unchanged. Insert directly after it; the same `here/../package.json` read works even when `require.resolve("bun/package.json")` fails. Do not read the candidate Bun package or hardcode `1.4.2`. `package.json:86` is the verified pin, and `package.json:18–21` already publishes `bin` and `src`, so no packaging manifest change is needed.

```js
function pinnedBunVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.dependencies?.bun === "string" ? pkg.dependencies.bun : "";
  } catch {
    return "";
  }
}
```

### Terminal failure (`fail`, lines 898–912)

Before line 902:
```js
  console.error(
```
After at the same anchor:
```js
  const desktopCli = findDesktopCli();
  console.error(
```

Before lines 908–910:
```js
      "(use sudo if the original install used sudo; without --ignore-scripts\n" +
      "and without --omit=optional / optional=false)"
  );
```
After:
```js
      "(use sudo if the original install used sudo; without --ignore-scripts\n" +
      "and without --omit=optional / optional=false)" +
      (desktopCli ? `\nAn installed Desktop CLI is available: "${desktopCli}"` : "")
  );
```

The pointer is only computed at the final no-usable-Bun exit; existence (`stat`) plus executable access is required. It is an explicit path hint, not a command launch or a claim that PATH points there. `/Applications` takes precedence over the user's `Applications`. No Windows/Linux app lookup. Existing reinstall guidance stays intact and no rejected PATH candidate is shown.

### Resolve order (`resolveBun`, lines 914–945)

Leave the override block at `:917–924` byte-for-byte unchanged, including its safe warning. Replace the tail beginning at `let bunDir` (`:926`) through function close (`:945`).

Before:
```js
  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return { path: bin, source: "bundled" };

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (allowInstall && existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return { path: bin, source: "bundled" };
}
```
After:
```js
  let bunDir = null;
  try {
    bunDir = bunBinDir();
  } catch { /* Missing dependency can still fall back to a validated PATH Bun. */ }

  let bin = bunDir ? findBunBinary(bunDir) : null;
  if (bin) return { path: bin, source: "bundled" };

  const installJs = bunDir ? join(bunDir, "install.js") : null;
  if (allowInstall && installJs && existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (bin) return { path: bin, source: "bundled" };

  const pathBun = findPathBun({ pinnedVersion: pinnedBunVersion(), deadlineMs: 750 });
  if (pathBun) {
    console.error(`opencodex: using PATH Bun ${pathBun.version}.`);
    return { path: pathBun.path, source: "process" };
  }
  fail(bunDir ? "Bun binary missing after install attempt." : "the `bun` dependency is not installed.");
}
```

`allowInstall:false` suppresses only installer recovery, not read-only PATH validation. The existing system updater-inspection namespace remains zero-install. Missing dependency wording stays findable (`the `bun` dependency is not installed`, with backticks in actual stderr); its occurrence is now the final exit after PATH fails. Existing child stamping at `:1084–1085` already sends selected source/path; **no edit** to that block or `src/lib/bun-runtime.ts` is required. `durableBunRuntime` at `src/lib/bun-runtime.ts:168–177` reads the matching pre-dotenv record, so a PATH selection reports `process`, not `bundled` or `override`. Keep the systemd launcher-mode exception documented at `structure/ops/service-and-sidecars.md:139–145`: launcher-mode service artifacts must not bake an inherited package-local bundled/process marker.

## NEW `src/cli/version-skew-notice.ts`

Anchor: absent. Complete proposed implementation:

```ts
import { readConfigDiagnostics } from "../config/diagnostics";
import { readRuntimePort } from "../config/process-state";
import { packageVersion } from "./help";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { computeVersionSkew } from "./version-skew";

const LIFECYCLE = new Set(["start", "stop", "restart", "update", "service"]);
const NOTICE_DEADLINE_MS = 200;
let printed = false;

export function shouldNoticeVersionSkew(command: string | undefined, args: string[]): boolean {
  const boundary = args.indexOf("--");
  const prefix = boundary < 0 ? args : args.slice(0, boundary);
  return LIFECYCLE.has(command ?? "")
    && !prefix.some(arg => arg === "--json" || arg === "--help" || arg === "-h")
    && prefix[1] !== "help";
}

export interface VersionSkewNoticeIo {
  readRuntime?: typeof readRuntimePort;
  readConfig?: typeof readConfigDiagnostics;
  probe?: typeof proxyIdentityAt;
  cliVersion?: () => string;
  now?: () => number;
  warn?: (message: string) => void;
}

export async function maybeNoticeVersionSkew(
  command: string | undefined, args: string[], io: VersionSkewNoticeIo = {},
): Promise<void> {
  if (printed || !shouldNoticeVersionSkew(command, args)) return;
  const now = io.now ?? Date.now;
  const deadlineAt = now() + NOTICE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const runtime = (io.readRuntime ?? readRuntimePort)();
    let port: number;
    let hostname: string | undefined;
    let expectedPid: number | undefined;
    if (runtime) {
      ({ port, hostname } = runtime);
      expectedPid = runtime.pid;
    } else {
      const diagnostics = (io.readConfig ?? readConfigDiagnostics)();
      if (diagnostics.error) return;
      port = diagnostics.config.port ?? 10100;
      hostname = diagnostics.config.hostname;
    }
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) return;
    const cliVersion = (io.cliVersion ?? packageVersion)();
    if (now() >= deadlineAt) return;
    const identity = await Promise.race([
      (io.probe ?? proxyIdentityAt)(port, { hostname, expectedPid }, {
        timeoutMs: Math.max(1, Math.floor(deadlineAt - now())),
        attempts: 1, deadlineAt, nowFn: now,
      }),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(1, deadlineAt - now()));
      }),
    ]);
    if (!identity || now() >= deadlineAt) return;
    const skew = computeVersionSkew(cliVersion, identity.version);
    if (!skew.warning) return;
    printed = true;
    (io.warn ?? console.error)(`opencodex: ${skew.warning}`);
  } catch {
    // Best-effort diagnostics must not fail a lifecycle command or change its exit code.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

Cheapest existing trusted helper: `proxyIdentityAt` (`src/server/proxy-liveness.ts:391–453`), the very probe `findLiveProxy` uses (`:497,:522,:542`). It validates `/healthz` as opencodex, rejects a mismatched reported pid when a runtime record supplies `expectedPid`, and only carries the bounded, terminal-safe version accepted by `isHealthzVersion` (`:316–320,:434–436`). It uses direct local HTTP (signal covers body receipt), not a management call. Call it **once**, selecting the validated runtime-port record (`src/config/process-state.ts:89–98`) first; only when no record exists read diagnostics to select the configured endpoint. A stale/unresponsive record produces a quiet miss, not a second discovery pass. This diagnostic intentionally has less coverage than `findLiveProxy`'s exhaustive runtime/config fallback.

Do not call the full default `findLiveProxy`: its config fallback uses `loadConfig` (`:467`), and its returned pid may trigger synchronous `verifyPidIdentity` (`:477–487`), especially expensive on Windows. No such OS process scan is needed for an advisory version comparison. `readConfigDiagnostics` (`src/config/diagnostics.ts:792–794`) avoids config repair/writes. No default ownership 1500 ms retries, no 750 ms environment floor, no readiness or management fetch, no attested-fence extra request. Identity-check here has the existing liveness meaning (including legacy accepted opencodex health bodies); it is not a new authenticated ownership or Desktop-supervision claim.

The single deadline includes endpoint selection and version lookup before network launch. A timer also bounds an injected/non-cooperating asynchronous probe; normal `proxyIdentityAt` aborts its request at the deadline. No asynchronous warning can print after the deadline. Like any in-process deadline, it cannot preempt synchronous filesystem calls or a blocked JS event loop; do not claim a hard real-time wall bound. `printed` is set only for an actual warning, so a quiet call does not suppress a later legitimate warning in the same process. Tests must isolate module state or run only one emitting scenario per fresh module instance.

## MODIFY `src/cli/root.ts`

Import anchor `noteCredentialArgv` at line 18. Before:
```ts
import { noteCredentialArgv, redactSecretArgs } from "./secret-args";
```
After:
```ts
import { noteCredentialArgv, redactSecretArgs } from "./secret-args";
import { maybeNoticeVersionSkew } from "./version-skew-notice";
```

`runCli` command-case anchor, lines 139–145. Before:
```ts
      const uninstallError = uninstallArgsError(head.command, head.args);
      if (uninstallError) {
        console.error(uninstallError);
        process.exit(2);
      }
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
```
After:
```ts
      const uninstallError = uninstallArgsError(head.command, head.args);
      if (uninstallError) {
        console.error(uninstallError);
        process.exit(2);
      }
      await maybeNoticeVersionSkew(head.command, head.args);
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
```

`parseCliHead` remains pure and unchanged. Version/help return/exit before the new hook (`:90–102`); ready/resolve's fail-closed parse validation remains before preflight (`:103–129`); unknown roots, malformed stop approval and invalid uninstall exit before it (`:131–143`). For non-lifecycle and `internal`, the helper returns before any reads/probe. JSON means an option before the `--` operand boundary, following root's help convention at `:42–46`; a forwarded operand `--json` after `--` is not a global JSON mode. The hook does not return an exit status or call `process.exit`.

## Focused regression implementation and activation grounding

MODIFY only the three existing files. Anchors: runtime imports `:1–9`, `isolatedLauncherEnv :296–312`, relative-override describe `:314–359`, Windows-only effective-runtime describe `:361–385`; source describe `:17–163`; version-skew describe `:9–131`. Append new sibling `describe` blocks at EOF; keep existing assertions and Windows lifecycle cleanup untouched. No real port-10100 proxy, service install, user config or Desktop process is needed.

### `tests/cli/ocx-launcher-runtime.test.ts` — helper and actual Node boundary

Add imports alongside current fs/path imports: `cpSync`, `readFileSync` from `node:fs`; `findPathBun`, `findDesktopCli`, `type PathBunIo` from `../../src/lib/bun-path-runtime.mjs`; `REAL_BUN_MIN_BYTES` from `../../src/lib/bun-binary-validator.mjs`. Existing test harness copies `process.execPath` and uses isolated homes (`:318–328,:296–312`), while the effective-runtime cases are Windows-only (`:16,:361`). New pure helper cases run everywhere, and Node-boundary cases are separately `skipIf(!nodeAvailable)`, not hidden by `!runnable`.

Append this deterministic helper harness; all filesystem and spawn behavior is owned by the test, and rejected paths never execute:

```ts
function pathProbeFixture(platform: NodeJS.Platform = "linux", stdout = "1.4.0\n") {
  const calls: Array<{ path: string; args: string[]; timeout: number; shell: boolean; maxBuffer: number }> = [];
  let clock = 0;
  const io: PathBunIo = {
    now: () => clock,
    realpath: path => path,
    stat: () => ({ isFile: () => true }),
    access: () => {},
    isRealBunBinary: () => true,
    spawnSync: (path, args, options) => {
      calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      return { status: 0, stdout };
    },
  };
  return { calls, io, advance: (ms: number) => { clock += ms; },
    find: (env: NodeJS.ProcessEnv, pinnedVersion = "1.4.2", deadlineMs = 750) =>
      findPathBun({ env, platform, pinnedVersion, deadlineMs, io }) };
}

describe("validated PATH Bun policy", () => {
  test.each(["1.4.0", "1.4.2", "1.5.0", "1.99.999", "1.4.0+build.1"])("accepts stable %s on the pinned major", version => {
    const fixture = pathProbeFixture("linux", version + "\n");
    expect(fixture.find({ PATH: "/trusted/bin" })).toEqual({ path: "/trusted/bin/bun", version });
    expect(fixture.calls).toEqual([{ path: "/trusted/bin/bun", args: ["--version"], timeout: 750, shell: false, maxBuffer: 4096 }]);
  });
  test.each(["1.3.99", "2.0.0", "0.99.0", "1.4.0-canary", "v1.4.0", "1.4", "01.4.0", "1.4.0\nnoise", "1.4.0\u001b[31m"])("rejects %s", version => {
    expect(pathProbeFixture("linux", version).find({ PATH: "/trusted/bin" })).toBeNull();
  });
  test("skips empty relative and tilde PATH entries before filesystem access", () => {
    const fixture = pathProbeFixture();
    expect(fixture.find({ PATH: ":.:relative:~/bin:/trusted/bin" })?.path).toBe("/trusted/bin/bun");
    expect(fixture.calls.map(call => call.path)).toEqual(["/trusted/bin/bun"]);
  });
  test("Windows uses case-insensitive Path and only a rooted bun.exe", () => {
    const fixture = pathProbeFixture("win32");
    expect(fixture.find({ Path: ";C:relative;\\relative;C:\\trusted\\bin", PATHEXT: ".CMD;.BAT;.EXE" })?.path).toBe("C:\\trusted\\bin\\bun.exe");
    expect(fixture.calls.map(call => call.path)).toEqual(["C:\\trusted\\bin\\bun.exe"]);
  });
  test.each(["directory", "unexecutable", "stub", "realpath-error", "stat-error"])("does not spawn a %s candidate", kind => {
    const fixture = pathProbeFixture();
    if (kind === "directory") fixture.io.stat = () => ({ isFile: () => false });
    if (kind === "unexecutable") fixture.io.access = () => { throw new Error("EACCES"); };
    if (kind === "stub") fixture.io.isRealBunBinary = () => false;
    if (kind === "realpath-error") fixture.io.realpath = () => { throw new Error("ENOENT"); };
    if (kind === "stat-error") fixture.io.stat = () => { throw new Error("EIO"); };
    expect(fixture.find({ PATH: "/bad" })).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
  test.each(["exit", "signal", "error", "overflow"])("rejects a %s version probe", kind => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = () => kind === "exit" ? { status: 1, stdout: "1.4.0" }
      : kind === "signal" ? { status: null, signal: "SIGKILL", stdout: "1.4.0" }
      : { status: null, error: new Error(kind) };
    expect(fixture.find({ PATH: "/bad" })).toBeNull();
  });
  test("shares one deadline across candidates and stops after timeout", () => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(750);
      return { status: null, error: new Error("ETIMEDOUT") };
    };
    expect(fixture.find({ PATH: "/first:/second" })).toBeNull();
    expect(fixture.calls).toHaveLength(1);
  });
  test("canonical aliases are probed only once before the next candidate", () => {
    const fixture = pathProbeFixture();
    fixture.io.realpath = path => path.includes("alias") ? "/first/bun" : path;
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(100);
      return { status: 0, stdout: path === "/last/bun" ? "1.4.0" : "1.3.0" };
    };
    expect(fixture.find({ PATH: "/first:/alias:/last" })?.path).toBe("/last/bun");
    expect(fixture.calls.map(call => call.timeout)).toEqual([750, 650]);
  });
  test.each(["", "^1.4.2", "1.4.2-canary", "unknown"])("invalid package pin %s does not probe PATH", pin => {
    const fixture = pathProbeFixture();
    expect(fixture.find({ PATH: "/trusted/bin" }, pin)).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
  test("threshold changes derive from the package pin", () => {
    expect(pathProbeFixture("linux", "1.4.0").find({ PATH: "/bin" }, "1.5.2")).toBeNull();
    expect(pathProbeFixture("linux", "2.0.0").find({ PATH: "/bin" }, "2.0.9")?.version).toBe("2.0.0");
  });
});

describe("failure-only Desktop CLI pointer", () => {
  test.each(["linux", "win32"] as const)("%s performs no app filesystem lookup", platform => {
    expect(findDesktopCli({ platform, io: { stat: () => { throw new Error("must not read"); } } })).toBeNull();
  });
  test("macOS checks executable system app before executable user app", () => {
    const visited: string[] = [];
    const result = findDesktopCli({ platform: "darwin", home: "/user", io: {
      stat: path => { visited.push(path); return { isFile: () => true }; },
      access: path => { if (path.startsWith("/Applications/")) throw new Error("EACCES"); },
    } });
    expect(result).toBe("/user/Applications/OpenCodex.app/Contents/MacOS/ocx");
    expect(visited).toEqual(["/Applications/OpenCodex.app/Contents/MacOS/ocx", result!]);
  });
  test("macOS omits a missing or directory app CLI", () => {
    expect(findDesktopCli({ platform: "darwin", io: { stat: () => { throw new Error("ENOENT"); } } })).toBeNull();
    expect(findDesktopCli({ platform: "darwin", io: { stat: () => ({ isFile: () => false }) } })).toBeNull();
  });
});
```

Add a real filesystem case under the same helper describe (before close), to ensure the production `isRealBunBinary` is exercised rather than only a stubbed seam. POSIX padded scripts are valid test stand-ins, **not proof of binary authenticity**; the current validator is a size gate. Windows uses a copied real executable because a shell script named `.exe` cannot run there.

```ts
  test("real PATH validation rejects the small stub and accepts the complete executable", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-bun-"));
    try {
      const first = join(root, "first"), last = join(root, "last");
      mkdirSync(first); mkdirSync(last);
      const name = process.platform === "win32" ? "bun.exe" : "bun";
      writeFileSync(join(first, name), "not bun");
      if (process.platform === "win32") copyFileSync(process.execPath, join(last, name));
      else writeFileSync(join(last, name), '#!/bin/sh\nprintf "1.4.0\\n"\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(join(first, name), 0o755); chmodSync(join(last, name), 0o755);
      const selected = findPathBun({ env: { ...process.env, PATH: [first, last].join(process.platform === "win32" ? ";" : ":") }, pinnedVersion: "1.4.2", deadlineMs: 2000 });
      expect(selected?.path).toBe(realpathSync.native(join(last, name)));
      expect(selected?.version).toMatch(/^1\.(?:[4-9]|[1-9]\d+)\./);
    } finally { removeTree(root); }
  });
```

Add this actual Node launcher fixture and matrix at EOF. It copies the package sources into a temporary **test-owned** tree so missing/placeholder bundles can be modeled without touching the lane's dependency directory. The tiny `src/cli/index.ts` replacement exists only in the fixture and prints the actual Node-to-Bun provenance pair. It never starts a proxy. A copied real Bun may be 1.4.0 (test-runner pin) or 1.4.2; capture its actual version before replacing PATH. Node is invoked by its previously resolved absolute executable. Any real-path Bun version outside the policy must fail the test setup visibly instead of skipping acceptance assertions.

```ts
function launcherFallbackFixture(mode: "missing" | "bundled" | "repair" | "broken" | "override" | "none" | "inspection") {
  const root = mkdtempSync(join(tmpdir(), "ocx-path-launcher-"));
  try {
    const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    const version = spawnSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    expect(version).toMatch(/^1\.(?:[4-9]|[1-9]\d+)\./);
    cpSync(repoPath("src"), join(root, "src"), { recursive: true });
    mkdirSync(join(root, "bin"));
    copyFileSync(BIN_OCX, join(root, "bin", "ocx.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.81.0", dependencies: { bun: "1.4.2" } }));
    writeFileSync(join(root, "src", "cli", "index.ts"), 'console.log(JSON.stringify({source:process.env.OCX_BUN_RUNTIME_SOURCE,path:process.env.OCX_BUN_RUNTIME_PATH}));');
    const pathDir = join(root, "path"); mkdirSync(pathDir);
    const pathBun = join(pathDir, process.platform === "win32" ? "bun.exe" : "bun");
    if (mode !== "none") { copyFileSync(process.execPath, pathBun); chmodSync(pathBun, 0o755); }
    const bundleDir = join(root, "node_modules", "bun");
    if (["bundled", "repair", "broken", "inspection"].includes(mode)) {
      mkdirSync(join(bundleDir, "bin"), { recursive: true });
      writeFileSync(join(bundleDir, "package.json"), '{"name":"bun","version":"1.4.2"}');
      const bundle = join(bundleDir, "bin", "bun.exe");
      if (mode === "bundled") copyFileSync(process.execPath, bundle);
      else writeFileSync(bundle, "stub");
      const installer = mode === "repair"
        ? `const fs=require("node:fs");fs.copyFileSync(${JSON.stringify(process.execPath)},${JSON.stringify(bundle)});fs.chmodSync(${JSON.stringify(bundle)},0o755);`
        : 'process.exit(1);';
      writeFileSync(join(bundleDir, "install.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "installer-ran"))},"yes");` + installer);
    }
    const env = isolatedLauncherEnv(root, mode === "override" ? pathBun : "");
    env.PATH = pathDir;
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path" && key !== "PATH") delete env[key];
    const args = mode === "inspection" ? ["system", "codex-cli-update", "inspect", "--json"] : ["--version"];
    const result = spawnSync(node, [join(root, "bin", "ocx.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      installerRan: (() => { try { return readFileSync(join(root, "installer-ran"), "utf8") === "yes"; } catch { return false; } })(),
      version, pathBun, canonicalPathBun: mode === "none" ? null : realpathSync.native(pathBun),
      bundle: join(bundleDir, "bin", "bun.exe") };
  } finally { removeTree(root); }
}

describe.skipIf(!nodeAvailable)("Node launcher PATH fallback activation", () => {
  test.each(["missing", "broken", "inspection"] as const)("%s bundle reaches validated PATH Bun", mode => {
    const result = launcherFallbackFixture(mode);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: "process", path: result.canonicalPathBun });
    expect(result.stderr).toBe(`opencodex: using PATH Bun ${result.version}.\n`);
    expect(result.installerRan).toBe(mode === "broken");
  });
  test.each(["bundled", "repair", "override"] as const)("%s runtime wins over PATH", mode => {
    const result = launcherFallbackFixture(mode);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: mode === "override" ? "override" : "bundled", path: mode === "override" ? result.pathBun : result.bundle });
    expect(result.stderr).not.toContain("using PATH Bun");
    expect(result.installerRan).toBe(mode === "repair");
  });
  test("terminal missing-bundle error is reached only when PATH has no usable Bun", () => {
    const result = launcherFallbackFixture("none");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the `bun` dependency is not installed");
    expect(result.stderr).not.toContain("using PATH Bun");
  });
});
```

Canonicalization happens inside the fixture before cleanup; output assertions use the captured value. Lexical bundle and override paths are deliberately retained to match existing launcher selection.

For rejected PATH diagnostics, extend the fixture mode union with `"rejected"`; change its PATH binary creation block to this exact code:

```ts
    if (mode === "rejected") {
      writeFileSync(pathBun, '#!/bin/sh\nprintf "2.0.0\\n"\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(pathBun, 0o755);
    } else if (mode !== "none") {
      copyFileSync(process.execPath, pathBun); chmodSync(pathBun, 0o755);
    }
```

Append inside the Node-boundary describe; POSIX-only because a script named `.exe` is not a native Windows executable:

```ts
  test.skipIf(process.platform === "win32")("rejected PATH versions never expose candidate paths", () => {
    const result = launcherFallbackFixture("rejected");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the `bun` dependency is not installed");
    expect(result.stderr).not.toContain(result.pathBun);
    expect(result.stderr).not.toContain("using PATH Bun");
  });
  test.skipIf(process.platform === "win32")("real version probe timeout returns without a lingering child", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-timeout-"));
    try {
      const path = join(root, "bun");
      writeFileSync(path, '#!/bin/sh\nexec /bin/sleep 5\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(path, 0o755);
      const started = performance.now();
      expect(findPathBun({ env: { PATH: root }, pinnedVersion: "1.4.2", deadlineMs: 50 })).toBeNull();
      expect(performance.now() - started).toBeLessThan(1500);
    } finally { removeTree(root); }
  });
```

The version child is test-owned and killed by spawnSync; no proxy is started. Native Windows version-policy rejection and timeout behavior are exercised by injected results, while actual copied Bun proves its executable launch path.

### `tests/cli/ocx-launcher-source.test.ts` — source-only seams

Append inside the describe before `:163` (existing source is obtained by `repoPath`, `:10–15`). New exact cases:

```ts
  test("PATH fallback follows bundled installer recovery and returns process provenance", () => {
    const start = source.indexOf("function resolveBun(");
    const end = source.indexOf("// `ocx update --help`", start);
    const resolver = source.slice(start, end);
    expect(resolver.indexOf("bunDir = bunBinDir()")).toBeGreaterThan(resolver.indexOf('source: "override"'));
    expect(resolver.indexOf("findPathBun(")).toBeGreaterThan(resolver.indexOf("spawnSync(process.execPath, [installJs]"));
    expect(resolver.indexOf("fail(bunDir ?")).toBeGreaterThan(resolver.indexOf("findPathBun("));
    expect(resolver).toContain('source: "process"');
    expect(resolver).not.toContain('catch {\n    fail("the `bun` dependency is not installed.");');
  });
  test("fallback derives its compatibility floor from the package dependency", () => {
    expect(source).toContain('typeof pkg.dependencies?.bun === "string" ? pkg.dependencies.bun : ""');
    expect(source).toContain("pinnedVersion: pinnedBunVersion(), deadlineMs: 750");
    expect(source).not.toContain('pinnedVersion: "1.4.2"');
  });
  test("terminal failure names Desktop only as a pointer and has no supervision import", () => {
    const fail = source.slice(source.indexOf("function fail("), source.indexOf("function resolveBun("));
    expect(fail).toContain("const desktopCli = findDesktopCli();");
    expect(fail).toContain("An installed Desktop CLI is available:");
    expect(fail).not.toMatch(/spawn(?:Sync)?\(/);
    expect(source).not.toContain("desktop-supervision.mjs");
  });
  test("lifecycle notice is awaited only after command validation", () => {
    const root = readFileSync(repoPath("src", "cli", "root.ts"), "utf8");
    const hook = root.indexOf("await maybeNoticeVersionSkew(head.command, head.args)");
    expect(hook).toBeGreaterThan(root.indexOf("const uninstallError = uninstallArgsError"));
    expect(hook).toBeLessThan(root.indexOf("maybeAutoRestoreCodexShim(head.command, head.args)", hook));
    const update = source.indexOf('if (process.argv[2] === "update" && isNodeModulesInstall()');
    expect(update).toBeLessThan(source.indexOf("const bunRuntime = resolveBun("));
  });
```

Retain the existing `allowInstall` and provenance source pins at `:32–38`, safe override checks at `:135–161`, and Windows child `windowsHide` assertion at `:50–58`. These source checks are supplemental; the Node boundary fixture is the activation proof.

### `tests/cli/cli-version-skew.test.ts` — lifecycle activation and quiet paths

Keep existing `computeVersionSkew` tests byte-for-byte. Add imports `maybeNoticeVersionSkew`, `shouldNoticeVersionSkew`, `type VersionSkewNoticeIo`; `proxyIdentityAt` and `type LivenessIo`; `spawnSync` from `node:child_process`; fs/temp helpers and `repoPath` when adding subprocess root assertions. A test factory injects all I/O; no default home is read.

The module-level once flag must not leak between cases. Run each emitting case in a fresh Bun subprocess with isolated homes, following `tests/cli/cli-help-recovery.test.ts:189–209`'s `mock.module` **in a subprocess** pattern. Do not globally mock root imports in the shared suite. Pure gate and non-emitting tests can use the imported module. Exact gate cases to append:

```ts
  test.each(["start", "stop", "restart", "update", "service"])("activates skew diagnostics for %s", command => {
    expect(shouldNoticeVersionSkew(command, [command])).toBe(true);
  });
  test.each(["status", "doctor", "resolve", "ready", "internal", "ensure", "version", "setup"])("does not activate diagnostics for %s", command => {
    expect(shouldNoticeVersionSkew(command, [command])).toBe(false);
  });
  test.each(["--json", "--help", "-h", "help"])("suppresses lifecycle diagnostic option %s", option => {
    expect(shouldNoticeVersionSkew("service", ["service", option])).toBe(false);
  });
  test("operand options after double dash do not change global diagnostic mode", () => {
    expect(shouldNoticeVersionSkew("start", ["start", "--", "--json"])).toBe(true);
  });
```

Use the following exact injected execution pattern for all rows in the activation table. The endpoint probe is the real `proxyIdentityAt` with an injected fetch, so foreign identity and unsafe version failures test the production trust gate. The `probe` seam counts calls while forwarding the single timeout/attempt/deadline settings.

```ts
const calls: string[] = [];
const warnings: string[] = [];
let clock = 0;
const io: VersionSkewNoticeIo = {
  now: () => clock,
  cliVersion: () => "2.80.0",
  readRuntime: () => ({ pid: 123, port: 23456, hostname: "127.0.0.1" }),
  readConfig: () => { throw new Error("runtime record must avoid config read"); },
  probe: (port, opts, budget) => {
    calls.push("probe");
    expect(port).toBe(23456);
    expect(opts.expectedPid).toBe(123);
    expect(budget.attempts).toBe(1);
    expect(budget.deadlineAt).toBe(200);
    expect(budget.timeoutMs).toBeLessThanOrEqual(200);
    return proxyIdentityAt(port, opts, { ...budget, fetchFn: async () =>
      Response.json({ service: "opencodex", status: "ok", pid: 123, version: "2.81.0" }) });
  },
  warn: line => warnings.push(line),
};
await maybeNoticeVersionSkew("start", ["start"], io);
expect(calls).toEqual(["probe"]);
expect(warnings).toEqual([`opencodex: ${computeVersionSkew("2.80.0", "2.81.0").warning}`]);
await maybeNoticeVersionSkew("restart", ["restart"], io);
expect(calls).toEqual(["probe"]);
expect(warnings).toHaveLength(1);
```

C-ACTIVATION-GROUNDING-01: each row defines a triggering invocation/state and a visible assertion; run the first two emitting rows independently in fresh subprocesses. All later rows must run before the emitting row or in fresh subprocesses so `printed` cannot mask a broken condition.

| Exact added test name | Activation scenario | Observable assertion |
|---|---|---|
| `lifecycle hook reports an older CLI once before dispatch` | `runCli(["start"])`; subprocess mocks shim preflight as a call recorder; notice module uses injected live version 2.81.0 vs 2.80.0 | stderr exactly one computed warning; probe calls 1; notice occurs before shim recorder/returned head; status 0 |
| `lifecycle hook reports a newer CLI without changing dispatch exit` | same harness with CLI 2.82.0; simulate dispatch exit 7 **after** `runCli` returns | exactly computed newer-CLI warning on stderr; final process exit 7 |
| `lifecycle JSON and help perform no notice reads` | all five lifecycle verbs with `--json`; help/-h/help-topic; injected readRuntime/readConfig/probe throw if called | zero calls, zero warning; root help exits 0 before hook, JSON returns head |
| `non-lifecycle and internal commands perform no notice reads` | status/doctor/resolve/ready/internal/ensure/version/setup; all injected dependencies record | zero reads/probes/warnings (valid root help/version exits stay intact) |
| `runtime target wins over configured port for the notice` | runtime record port 23456, different configured port; real identity probe | only 23456 queried, expectedPid 123, readConfig never called |
| `missing runtime record selects valid configured endpoint once` | readRuntime null; diagnostics `{config:{port:34567,hostname:"127.0.0.1"},source:"file",error:null}` | only 34567 queried, no expectedPid, exactly one warning on mismatch |
| `missing config uses default port and malformed config stays quiet` | no runtime; default diagnostics first, error diagnostics in separate case | default 10100 once; malformed config zero probes, no warning, no write/repair |
| `stale runtime record does not probe a second endpoint` | record exists, fetch refuses connection | probe once, config never read, no warning |
| `foreign or mismatched health identity never emits skew` | real helper injected response foreign marker/status or pid 124 vs expected 123 | no warning, one identity probe, command returns normally |
| `unsafe absent placeholder and matching versions stay quiet` | real identity body variants: ESC text, missing version, 0.0.0, current CLI version | no warning; unsafe version stripped by identity helper; no second query |
| `expired endpoint reads never start a probe` | injected readRuntime advances clock from 0 to 201 | zero network calls, zero warnings |
| `notice timeout and rejection preserve the command` | injected probe rejects, then separate probe never settles | returns void; no warning; timeout completes around 200 ms with scheduler allowance, no exit status change |
| `late identity never prints after the diagnostic deadline` | injected probe advances clock to 201 before returning valid mismatch | no warning |
| `bad stop approval and unknown command exit before notice hook` | subprocess root invocation `stop --expect-pid broken`, unknown root | exit 64/1, no notice calls; existing usage/recovery output remains |
| `root help and ready resolve parse failures retain their early exits` | subprocess root help, invalid ready timeout, invalid resolve args | root exits 0/64/64, no probe or shim preflight |

The table is implemented by this fresh-process harness and the exact cases below. Add imports `mkdirSync`, `mkdtempSync`, `rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `spawnSync` from `node:child_process`, and `repoPath` from `../helpers/repo-root`. No shared-suite module mock is installed.

```ts
type NoticeScenario = {
  command?: string; args?: string[]; cliVersion?: string; proxyVersion?: string | null;
  runtime?: boolean; configError?: boolean; configDefault?: boolean;
  foreign?: boolean; wrongPid?: boolean;
  outcome?: "reject" | "hang" | "late" | "expired-read" | "network-abort";
  repeat?: boolean; root?: boolean; exitCode?: number;
};
function freshNotice(scenario: NoticeScenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-notice-test-"));
  try {
    const ocxHome = join(root, "ocx"), codexHome = join(root, "codex");
    mkdirSync(ocxHome); mkdirSync(codexHome);
    const script = `
      const scenario = ${JSON.stringify(scenario)};
      const notice = await import(${JSON.stringify(repoPath("src", "cli", "version-skew-notice.ts"))});
      const { proxyIdentityAt } = await import(${JSON.stringify(repoPath("src", "server", "proxy-liveness.ts"))});
      const warnings = [], calls = [], probes = [], events = [];
      let clock = 0, aborted = false;
      const io = {
        now: () => scenario.outcome === "hang" || scenario.outcome === "network-abort" ? Date.now() : clock,
        cliVersion: () => scenario.cliVersion ?? "2.80.0",
        warn: line => { warnings.push(line); events.push("warn"); console.error(line); },
        readRuntime: () => {
          calls.push("runtime");
          if (scenario.outcome === "expired-read") clock = 201;
          return scenario.runtime === false ? null : { pid:123, port:23456, hostname:"127.0.0.1" };
        },
        readConfig: () => {
          calls.push("config");
          return { config: scenario.configDefault ? {} : {port:34567,hostname:"127.0.0.1"},
            source: scenario.configDefault ? "default" : "file", error:scenario.configError ? "invalid" : null };
        },
        probe: async (port, opts, budget) => {
          probes.push({port,opts,budget:{attempts:budget.attempts,timeoutMs:budget.timeoutMs}});
          if (scenario.outcome === "reject") throw new Error("transport");
          if (scenario.outcome === "hang") return new Promise(() => {});
          if (scenario.outcome === "late") clock = 201;
          return proxyIdentityAt(port, opts, { ...budget, fetchFn: async (_url, init) => {
            if (scenario.outcome === "network-abort") return new Promise((_resolve,reject) => {
              const abort = () => { aborted = true; reject(new Error("aborted")); };
              init.signal.addEventListener("abort",abort,{once:true});
              if (init.signal.aborted) abort();
            });
            return Response.json({service:scenario.foreign ? "foreign" : "opencodex",status:"ok",
              pid:scenario.wrongPid ? 124 : 123,
              ...(scenario.proxyVersion === null ? {} : {version:scenario.proxyVersion ?? "2.81.0"})});
          } });
        },
      };
      const command = scenario.command ?? "start", args = scenario.args ?? [command];
      if (scenario.root) {
        const { mock } = await import("bun:test");
        const actual = notice.maybeNoticeVersionSkew;
        mock.module(${JSON.stringify(repoPath("src", "cli", "version-skew-notice.ts"))}, () => ({
          shouldNoticeVersionSkew: notice.shouldNoticeVersionSkew,
          maybeNoticeVersionSkew: (cmd,argv) => { events.push("hook"); return actual(cmd,argv,io); },
        }));
        mock.module(${JSON.stringify(repoPath("src", "cli", "codex-shim-autorestore.ts"))}, () => ({
          maybeAutoRestoreCodexShim: () => events.push("shim"),
        }));
        const { runCli } = await import(${JSON.stringify(repoPath("src", "cli", "root.ts"))});
        await runCli(args); events.push("dispatch");
      } else {
        await notice.maybeNoticeVersionSkew(command,args,io);
        if (scenario.repeat) await notice.maybeNoticeVersionSkew("restart",["restart"],io);
      }
      // A late observer must not warn; give the network abort event one turn to settle.
      if (scenario.outcome === "network-abort") await new Promise(resolve => setTimeout(resolve,20));
      console.log(JSON.stringify({warnings,calls,probes,events,aborted}));
      process.exitCode = scenario.exitCode ?? 0;
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocxHome,
        CODEX_HOME: codexHome, GROK_HOME: join(root,"grok"), OCX_OWNER_REGISTRY_DIR: join(root,"owners") },
    });
    const report = result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) as {
      warnings: string[]; calls: string[];
      probes: Array<{port:number;opts:{expectedPid?:number};budget:{attempts:number;timeoutMs:number}}>;
      events: string[]; aborted: boolean;
    } : null;
    return { status:result.status, stdout:result.stdout, stderr:result.stderr, report };
  } finally { rmSync(root,{recursive:true,force:true}); }
}

describe("lifecycle version notice activation", () => {
  test("lifecycle hook reports an older CLI once before dispatch", () => {
    const result = freshNotice({root:true});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`opencodex: ${computeVersionSkew("2.80.0","2.81.0").warning}\n`);
    expect(result.report?.events).toEqual(["hook","warn","shim","dispatch"]);
    expect(result.report?.probes).toHaveLength(1);
    const repeat = freshNotice({repeat:true});
    expect(repeat.report?.warnings).toHaveLength(1);
    expect(repeat.report?.probes).toHaveLength(1);
  });
  test("lifecycle hook reports a newer CLI without changing dispatch exit", () => {
    const result = freshNotice({root:true,cliVersion:"2.82.0",exitCode:7});
    expect(result.status).toBe(7);
    expect(result.stderr).toBe(`opencodex: ${computeVersionSkew("2.82.0","2.81.0").warning}\n`);
    expect(result.report?.events.at(-1)).toBe("dispatch");
  });
  test.each(["start","stop","restart","update","service"])("lifecycle %s JSON and help perform no notice reads", command => {
    for (const option of ["--json","--help","-h","help"]) {
      const result = freshNotice({command,args:[command,option]});
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(result.report?.calls).toEqual([]); expect(result.report?.probes).toEqual([]);
    }
  });
  test.each(["status","doctor","resolve","ready","internal","ensure","version","setup"])("non-lifecycle %s performs no notice reads", command => {
    const result = freshNotice({command});
    expect(result.report?.calls).toEqual([]); expect(result.report?.probes).toEqual([]);
    expect(result.stderr).toBe("");
  });
  test("runtime target wins over configured port for the notice", () => {
    const result = freshNotice();
    expect(result.report?.calls).toEqual(["runtime"]);
    expect(result.report?.probes[0]?.port).toBe(23456);
    expect(result.report?.probes[0]?.opts.expectedPid).toBe(123);
    expect(result.report?.probes[0]?.budget).toEqual({attempts:1,timeoutMs:200});
  });
  test("missing runtime record selects valid configured endpoint once", () => {
    const result = freshNotice({runtime:false});
    expect(result.report?.calls).toEqual(["runtime","config"]);
    expect(result.report?.probes).toHaveLength(1);
    expect(result.report?.probes[0]?.port).toBe(34567);
    expect(result.report?.probes[0]?.opts.expectedPid).toBeUndefined();
    expect(result.report?.warnings).toHaveLength(1);
  });
  test("missing config uses default port and malformed config stays quiet", () => {
    expect(freshNotice({runtime:false,configDefault:true}).report?.probes[0]?.port).toBe(10100);
    const invalid = freshNotice({runtime:false,configError:true});
    expect(invalid.report?.probes).toEqual([]); expect(invalid.stderr).toBe("");
  });
  test("stale runtime record does not probe a second endpoint", () => {
    const result = freshNotice({outcome:"reject"});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.calls).toEqual(["runtime"]); expect(result.report?.probes).toHaveLength(1);
  });
  test.each([{foreign:true},{wrongPid:true}])("foreign or mismatched health identity never emits skew %j", scenario => {
    const result = freshNotice(scenario);
    expect(result.stderr).toBe(""); expect(result.report?.probes).toHaveLength(1);
  });
  test.each(["2.81.0\u001b[31m",null,"0.0.0","2.80.0"])("unsafe absent placeholder or matching version %s stays quiet", proxyVersion => {
    const result = freshNotice({proxyVersion}); expect(result.stderr).toBe("");
    expect(result.report?.warnings).toEqual([]); expect(result.report?.probes).toHaveLength(1);
  });
  test("expired endpoint reads never start a probe", () => {
    const result = freshNotice({outcome:"expired-read"});
    expect(result.report?.probes).toEqual([]); expect(result.stderr).toBe("");
  });
  test.each(["reject","hang"] as const)("notice %s preserves the command", outcome => {
    const result = freshNotice({outcome});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.probes).toHaveLength(1);
  });
  test("late identity never prints after the diagnostic deadline", () => {
    expect(freshNotice({outcome:"late"}).stderr).toBe("");
  });
  test("production identity request receives cancellation at the notice deadline", () => {
    const result = freshNotice({outcome:"network-abort"});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.aborted).toBe(true); expect(result.report?.probes).toHaveLength(1);
  });
  test.each([
    [["stop","--expect-pid","broken"],64], [["unknown-root"],1],
    [["--help"],0], [["ready","--timeout","bad"],64], [["resolve","--invalid"],64],
  ] as const)("root early-exit %j retains exit %s before notice", (args,status) => {
    const result = freshNotice({root:true,args:[...args]});
    expect(result.status).toBe(status); expect(result.report).toBeNull();
    expect(result.stderr).not.toContain("does not match the running proxy");
  });
});
```

For production network cancellation, use `proxyIdentityAt` with injected fetch that listens to `init.signal` and rejects on abort; assert signal is aborted at the <=200 ms timeout and calls stay at one. Keep a reasonable outer test timeout (e.g. 2 s) for a loaded runner, not a new product probe budget. A timer tolerance is scheduler evidence, not an exact real-time promise.

## MODIFY architecture documentation (exact prose replacements)

### `structure/runtime.md`, entrypoint table `bin/ocx.mjs` row at line 123

Before:
```md
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. The exact `system codex-cli-update` inspection namespace skips both boot repair and lazy Bun installation; missing runtime support fails closed instead of mutating state. |
```
After (one line; document remains 600):
```md
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Before project dotenv: explicit Bun override, bundle, permitted installer recovery, then `src/lib/bun-path-runtime.mjs` validates absolute PATH Bun candidates with regular/executable and size checks plus a bounded stable-version probe (same major, minor at least the dependency pin's minor); PATH selection stamps `process` with its canonical path and prints a version-only stderr notice. Failure names an executable macOS Desktop CLI when present without delegating. The proof-bound Anthropic snapshot, signal/exit propagation and zero-install updater inspection stay intact. `src/cli/version-skew-notice.ts`, called from `src/cli/root.ts`, makes one identity-checked 200 ms advisory probe for start/stop/restart/update/service, excluding JSON/help/internal; Node-managed update bypasses this notice. |
```

The existing Bun-runtime row at line 124 stays accurate: it describes durable pair consumption, not launcher fallback priority. Runtime/test pins at lines 7–15 stay unchanged; PATH policy is a recovery selection, not a change to the shipped/test pins.

### `structure/ops/docs-and-release.md`, Package runtime invariant at lines 346–350

Before:
```md
- `bin/ocx.mjs` resolves the bundled binary via `require.resolve("bun/package.json")` and a size gate
  (`>= 1 MB`) that rejects the ~450-byte placeholder stub left by `--ignore-scripts`/pnpm; it then
  lazy-runs `install.js` and execs `src/cli/index.ts` under Bun, propagating exit code and signal.
  The Windows service wrapper applies the same gate before each launch and waits on a placeholder
  instead of executing it ([Windows service wrapper](#windows-service-wrapper-and-incomplete-updates)).
```
After (five lines; document remains 600):
```md
- `bin/ocx.mjs` selects explicit override, bundled Bun, allowed installer recovery, then validated PATH Bun.
  `src/lib/bun-path-runtime.mjs` requires absolute entries, canonical regular/executable files, the >=1 MB
  gate and a bounded stable version on the pinned major with minor >= pinned minor (1.4.0 <= version < 2).
  PATH selection stamps `process`; failure may name an installed Desktop CLI without executing it.
  The [Windows service wrapper](#windows-service-wrapper-and-incomplete-updates) keeps its own placeholder wait gate; updater inspection never runs installer recovery.
```

### `structure/ops/service-and-sidecars.md`, Stable service launcher paragraph at lines 139–145

Before first four lines:
```md
Launcher mode omits the package-local Bun provenance pair because an upgrade may delete that
versioned tree. The only runtime path carried through the launcher is a pre-Bun, proof-bound
`OPENCODEX_BUN_PATH` whose durable runtime source is `override`; bundled and process fallbacks are
rediscovered by the current launcher. The API-auth token remains file-backed and is loaded only by
```
After (four lines, retain lines 143–145 beginning `the service shell at start`):
```md
Launcher mode omits the package-local Bun provenance pair because an upgrade may delete that
versioned tree. Only a pre-Bun, proof-bound `OPENCODEX_BUN_PATH` with durable source `override` is
carried through; `bin/ocx.mjs` rediscovers bundled or validated PATH Bun, stamping PATH selection as
`process` via `src/lib/bun-path-runtime.mjs`. The API-auth token remains file-backed and is loaded only by
```

No systemd exception is removed and no service definition algorithm changes.

## MODIFY public installation troubleshooting

Search result: no docs-site page currently contains the literal `bun dependency is not installed` (with or without backticks). The relevant troubleshooting is the **existing blocked-postinstall note** in `docs-site/src/content/docs/getting-started/installation.md:30–43`; use it instead of inventing a page. Korean counterpart: `docs-site/src/content/docs/ko/getting-started/installation.md:24–37`. Keep reinstall commands unchanged.

English before, lines 31–35:
```md
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. Reinstall allowing bun's
script — and always include the package name (npm's abbreviated suggestion
omits it, which would reinstall the current directory instead):
```
After:
```md
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. After trying permitted bundled-runtime
recovery, the launcher can use an executable Bun from an absolute PATH directory if its
stable version has the pinned major and a minor at least the pinned minor. With the current
1.4.2 dependency, that means 1.4.0 or newer within major 1. A one-line stderr notice names the
selected Bun version. Bun is still bundled; installing it yourself is optional.

If no runtime works, the error still includes “the `bun` dependency is not installed” when
the dependency is missing. On macOS, it also names an executable Desktop CLI found at
`/Applications/OpenCodex.app/Contents/MacOS/ocx` or
`~/Applications/OpenCodex.app/Contents/MacOS/ocx`. You can invoke that path explicitly;
the package launcher does not delegate automatically or install a PATH shim.

To repair the bundled runtime, reinstall allowing bun's script. Always include the package
name: npm's abbreviated suggestion omits it and would reinstall the current directory:
```

Korean before, lines 25–29:
```md
최신 npm은 bun의 postinstall 스크립트를 차단할 수 있습니다(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`).
이 경우 번들 Bun 런타임이 준비되지 않으므로 bun 스크립트를 허용해서
재설치하세요. npm 경고의 축약 명령에는 패키지 이름이 빠져 있어 현재
디렉터리를 재설치하게 되니, 항상 패키지 이름을 명시해야 합니다:
```
After:
```md
최신 npm은 bun의 postinstall 스크립트를 차단할 수 있습니다(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`).
이 경우 번들 Bun 런타임이 준비되지 않을 수 있습니다. 런처는 허용된 번들 복구를
시도한 다음, 절대 경로 PATH 디렉터리의 실행 가능한 Bun을 검증합니다. 정식 버전의
major가 패키지 pin과 같고 minor가 pin 이상이면 사용할 수 있습니다. 현재 의존성
1.4.2에서는 1.4.0 이상, 2.0.0 미만이며 선택한 Bun 버전을 stderr 한 줄로 알립니다.
Bun은 계속 패키지에 포함되므로 별도 설치는 선택 사항입니다.

사용할 런타임이 없고 의존성이 빠져 있으면 오류에 “the `bun` dependency is not installed”가
표시됩니다. macOS에서는 실행 가능한 Desktop CLI가 있으면
`/Applications/OpenCodex.app/Contents/MacOS/ocx` 또는
`~/Applications/OpenCodex.app/Contents/MacOS/ocx` 경로도 안내합니다. 이 경로를 직접 실행할
수 있지만 패키지 런처가 자동 위임하거나 PATH shim을 설치하지는 않습니다.

번들 런타임을 복구하려면 bun 스크립트를 허용해서 재설치하세요. npm 경고의 축약 명령에는
패키지 이름이 빠져 있어 현재 디렉터리를 재설치하게 되니, 항상 패키지 이름을 명시해야 합니다:
```

After the alias verification block (English `:50`, Korean `:44`) add respectively:

```md
Before start, stop, restart, service, or an update handled by the Bun CLI, a brief stderr
notice can identify a CLI/proxy version mismatch. It is advisory and preserves the command's
exit code; JSON and help output do not trigger it. npm/pnpm updates handled by the Node launcher
before the Bun CLI starts do not emit this notice. `ocx status`, `ocx doctor`, and `ocx resolve`
already report version skew through their diagnostics.
```

```md
start, stop, restart, service와 Bun CLI가 처리하는 update에서는 CLI와 실행 중인 프록시의
버전이 다르면 짧은 stderr 안내가 나올 수 있습니다. 안내는 명령 종료 코드를 바꾸지 않으며
JSON·도움말 모드에서는 실행하지 않습니다. Bun CLI 시작 전에 Node 런처가 처리하는
npm/pnpm update에는 이 안내가 적용되지 않습니다. `ocx status`, `ocx doctor`, `ocx resolve`는
기존 진단에서 버전 차이를 표시합니다.
```

Other locale prerequisites still say bundled Bun needs no manual installation and remain true. Do not copy new English/Korean fallback claims into every translation as an ungrounded bulk edit.

## Implementation verifier packet (commands specified, NOT executed during planning)

Run from the lane workdir. Focused list includes direct source-oracle files because an import graph cannot discover launcher text reads or fixture subprocess relationships:

```bash
bun test tests/cli/ocx-launcher-runtime.test.ts tests/cli/ocx-launcher-source.test.ts tests/cli/cli-version-skew.test.ts tests/cli/cli-help-recovery.test.ts tests/cli/cli-ready.test.ts tests/cli/cli-ready-subprocess.test.ts tests/cli/cli-resolve.test.ts tests/cli/cli-resolve-subprocess.test.ts tests/ci-workflows/structure-ssot.test.ts tests/ci-workflows/file-size-ratchet.test.ts
bun run typecheck
bun run structure:check
bun run privacy:scan
```

All listed test paths were verified present with `rg --files tests`; add `tests/cli/cli-resolve-subprocess.test.ts` to the focused packet to preserve its early-exit behavior as well. Typecheck currently includes `src` only (`tsconfig.json:15`), contrary to the broader statement in 000; do not claim it typechecks the test snippets. Bun test execution is the test-file validation. Full local `bun run test` is prohibited by lane scope; broad coverage is exact-head hosted CI (four shards plus Windows shards). Record command/results and remaining native limitations in PR Verification. No test was run by this writer.

Documentation-site instructions also require a docs build after implementation:
```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```
Run only in the implementation phase under parent authority; this plan does not execute installs/builds. Structure changes use existing ownership, so no `structure:index` regeneration is necessary. Newly referenced source files must be tracked by the parent before structure:check, which resolves paths from the git index.

## Risks and acceptance boundaries

1. PATH is a local trust surface: size and a stable version are policy validation, not a digest/signature authenticity check. Run only the exact canonical candidate without shell; never print rejected paths. Existing override/bundled validation remains unchanged as accepted design.
2. Patch compatibility is policy. In particular, runtime pin 1.4.2 includes a Windows fetch fix (`structure/runtime.md:7`) that 1.4.0 lacks. Bundled/installer priority keeps the shipped fix first; recovery fallback may retain old-runtime defects. Tests establish selection and bounded execution, not universal compatibility.
3. `spawnSync` timeout and in-process HTTP timers bound their children/network work but cannot preempt blocked filesystem syscalls or a blocked host event loop. A long/malformed PATH must not multiply process timeouts. Changing invalid pin handling to accept any version would violate the policy.
4. One cheap skew probe can miss a proxy behind a stale runtime record or a slow loopback filter. Quiet failure is deliberate and never authorizes stop/update/start; actual lifecycle safety belongs to existing guards and wp5.
5. Existing `computeVersionSkew` may suggest `service restart` for an older proxy. Reuse it as accepted; Desktop competition protection is wp5, and the notice must not infer ownership. PR C should not claim it alone fixes Desktop safety.
6. Node-managed npm/pnpm/mise update skew warnings are explicitly absent. Parent must retain this limitation in PR C and closeout rather than generalize “all updates warn.”
7. Keep the pre-Bun provenance pair intact through dotenv and the systemd launcher-mode rediscovery rule. Do not stamp PATH fallback as override, or persist a process marker in launcher-mode service artifacts.
8. The pure helper seam is synthetic policy evidence; actual Node fixture is launcher activation evidence; real copied Bun is executable evidence. Native Windows/macOS integrated assertions and exact-head hosted CI remain necessary before merge readiness.

Open product/design question: none within accepted wp3 scope. Recorded implementation limits: hard real-time 200 ms is not enforceable over synchronous filesystem stalls; Node-managed update is excluded from skew preflight; all test snippets must be checked with the focused commands during implementation. Parent owns review/PR/CI/goal state.


## r2 amendments (Pascal reflection)

1. Version policy wording everywhere: same major as the pinned `bun` dependency and minor ≥ pinned minor.
2. **Identity probe:** after `--version`, run `<bun> -e "process.stdout.write(String(typeof Bun==='object'&&Bun.version))"`
   (spawnSync, no shell, shared deadline, 4 KiB cap) and require it to equal the `--version` output. On POSIX reject a
   candidate whose resolved file or parent directory is group- or world-writable (`mode & 0o022`). Describe the result as
   "version-policy and identity checks", not authentication. Fixture: the padded shell script must now answer `-e` too
   for the positive case; add a negative case that answers `--version` only.
3. **Consumer proof:** extend `tests/ci-workflows/bun-runtime.test.ts`: PATH-selected `process` provenance survives
   `durableBunRuntime()` and is not replaced by a project `.env`.
4. **Neutral notice text:** `version-skew-notice.ts` prints
   "ocx <cli> does not match the running proxy <proxy>. Check which opencodex installation you meant to use (`ocx status` shows both)."
   and does not reuse `computeVersionSkew().warning`.
5. Timeout test claims only "returns null within the deadline"; the lingering-child claim is dropped.



## r4 amendments (A audit round 1)

- **F3:** the source assertion "launcher does not reference desktop-supervision.mjs" is scoped to the `resolveBun` and
  `fail` function bodies (extract the text between their declarations), so PR B's updater import does not trip it.
  Verify on the combined tree before the last push of the later PR.
- **F6:** add `tests/ci-workflows/bun-runtime.test.ts` to the focused verifier command.



## r6 amendment (hosted CI, 2026-10-09)

Production budget raised from 750 ms to `PATH_BUN_PROBE_BUDGET_MS = 5_000` in `bin/ocx.mjs`. Windows CI run
37894746375 (`windows 9/9`) rejected a valid PATH Bun: the two cold probes of a freshly copied `bun.exe` exceeded 750 ms
under on-access scanning. The fallback runs only when the bundled runtime is unusable, so a larger bound costs nothing
on the normal path; it stays a total bound shared by both probes.

