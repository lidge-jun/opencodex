import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runNpmCachePreflight } from "../../src/update/npm-cache-preflight.mjs";
import { resolveCodexHomeDir } from "../../src/codex/home";
import { isProcessAlive, killProxy } from "../../src/lib/process-control";
import { createIsolatedTestEnvironment } from "../../scripts/test";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port ? resolve(port) : reject(new Error("no free port")));
  });
  return promise;
}

/**
 * Budget for the whole recovery case, and the arithmetic that keeps it honest.
 *
 * A cold detached proxy takes ~2s locally, but this test runs inside a CI batch of twelve files
 * on a shared runner where the same boot has blown a 15s budget. Raising the readiness wait to
 * 45s fixed that and introduced a worse failure: the case ALSO spawns `node launcher update`
 * (up to 30s) before the wait even starts, and `node launcher stop` (up to 30s) after it. With
 * a 60s Bun timeout, a 45s wait leaves the readiness probe unable to finish inside the case at
 * all — observed failing at 46-47s on macOS, which reads as a product defect and is not one.
 *
 * So the budget is derived from the timeout rather than guessed against it: the wait gets what
 * remains after the spawns, and the Bun timeout is stated as the sum of its parts. The deadline
 * exists to stop a HUNG proxy, not to assert a boot deadline the suite never intended to
 * enforce — a slow-but-live proxy must still pass.
 */
const UPDATE_SPAWN_TIMEOUT_MS = 30_000;
// 45s exhausted repeatedly on loaded shared runners (46-47s failures recorded
// on at least four unrelated PRs; the detached Bun proxy can take >45s to
// serve /healthz there). 90s keeps the derived case budget honest below.
const PROXY_READY_TIMEOUT_MS = 90_000;
/** Spawn + readiness + teardown spawn, plus headroom for fixture IO on a loaded runner. */
const RECOVERY_CASE_TIMEOUT_MS = UPDATE_SPAWN_TIMEOUT_MS + PROXY_READY_TIMEOUT_MS + UPDATE_SPAWN_TIMEOUT_MS + 15_000;

async function waitForProxy(port: number, onFailure: (lastProbe: string) => void): Promise<boolean> {
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  let lastProbe = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        // A loaded runner can exceed 500ms on the very first connection while
        // the process is still binding; a short per-probe timeout there reads
        // as "not ready" for a proxy that is merely slow to accept.
        signal: AbortSignal.timeout(2_000),
      });
      lastProbe = `HTTP ${response.status}`;
      if (response.ok) return true;
    } catch (error) {
      // Error messages can contain URLs/credentials. Report only fixed error categories.
      lastProbe = JSON.stringify(recoveryErrorFields(error));
    }
    // The detached process exposes readiness only over HTTP; fake timers cannot advance it.
    await Bun.sleep(100);
  }
  onFailure(lastProbe);
  return false;
}

const RECOVERY_ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ESRCH", "EADDRINUSE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "ENOSPC", "ENOEXEC", "EIO", "ETXTBSY", "EPIPE",
  "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_WORKER_INIT_FAILED", "ERR_SYSTEM_ERROR",
]);
const RECOVERY_ERROR_NAMES = new Set(["Error", "AbortError", "TimeoutError", "TypeError", "SyntaxError", "ReferenceError", "RangeError"]);
const RECOVERY_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGPIPE", "SIGQUIT", "SIGTRAP"]);
const RECOVERY_EVENTS = new Set([
  "launcher-start", "launcher-exit", "boot-restore-enter", "boot-restore-result", "boot-restore-error",
  "runtime-resolution-enter", "runtime-resolved", "runtime-install-enter", "runtime-install-result",
  "runtime-spawn-call", "runtime-spawned", "runtime-spawn-error", "runtime-exit",
]);

function recoveryOwnData(value: unknown, key: string): unknown {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function recoveryErrorFields(error: unknown): { errorName: string; code: string; causeCode: string } {
  let name = recoveryOwnData(error, "name");
  if (name === undefined && error !== null && typeof error === "object") {
    try { name = recoveryOwnData(Object.getPrototypeOf(error), "name"); } catch { /* unknown */ }
  }
  const code = recoveryOwnData(error, "code");
  const causeCode = recoveryOwnData(recoveryOwnData(error, "cause"), "code");
  return {
    errorName: typeof name === "string" && RECOVERY_ERROR_NAMES.has(name) ? name : "unknown",
    code: typeof code === "string" && RECOVERY_ERROR_CODES.has(code) ? code : "unknown",
    causeCode: typeof causeCode === "string" && RECOVERY_ERROR_CODES.has(causeCode) ? causeCode : "unknown",
  };
}

function recoveryStatusRecord(raw: unknown): Record<string, string | number | null> | null {
  const event = recoveryOwnData(raw, "event");
  if (recoveryOwnData(raw, "v") !== 1 || typeof event !== "string" || !RECOVERY_EVENTS.has(event)) return null;
  const out: Record<string, string | number | null> = { v: 1, event };
  if (event === "launcher-start" || event === "runtime-spawned") {
    const pid = recoveryOwnData(raw, "pid");
    out.pid = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : "unknown";
  }
  if (event === "runtime-resolved") {
    const source = recoveryOwnData(raw, "source");
    out.source = source === "override" || source === "bundled" ? source : "unknown";
  }
  if (event === "boot-restore-result") {
    const action = recoveryOwnData(raw, "action");
    out.action = action === "restored" || action === "failed" || action === "none" || action === "reaped" ? action : "unknown";
  }
  if (event === "launcher-exit" || event === "runtime-exit" || event === "runtime-install-result") {
    const code = recoveryOwnData(raw, "exitCode");
    const signal = recoveryOwnData(raw, "signal");
    out.exitCode = code === null || (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) ? code : "unknown";
    out.signal = signal === null || (typeof signal === "string" && RECOVERY_SIGNALS.has(signal)) ? signal : "unknown";
  }
  if (event === "runtime-spawn-error" || event === "boot-restore-error" || event === "runtime-install-result") {
    for (const key of ["errorName", "code", "causeCode"]) {
      const value = recoveryOwnData(raw, key);
      const allowed = key === "errorName" ? RECOVERY_ERROR_NAMES : RECOVERY_ERROR_CODES;
      out[key] = typeof value === "string" && allowed.has(value) ? value : "unknown";
    }
  }
  return out;
}

function diagnosticCategories(text: string): string {
  const matches = text.match(/\b(?:ENOENT|EACCES|EPERM|ESRCH|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAGAIN|ENOMEM|EMFILE|ENFILE|ENOSPC|ENOEXEC|EIO|ETXTBSY|EPIPE|ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|ERR_WORKER_INIT_FAILED|ERR_SYSTEM_ERROR|AbortError|TimeoutError|TypeError|SyntaxError|ReferenceError|RangeError|Cannot find package|Cannot find module|Failed to resolve|ConnectionRefused|FailedToOpenSocket)\b/g);
  const categories = new Set(matches ?? []);
  if (/out of memory|cannot allocate memory|allocation failed/i.test(text)) categories.add("allocation-failure");
  if (/dyld\[|library not loaded|symbol not found/i.test(text)) categories.add("native-loader-failure");
  if (/segmentation fault|bus error|illegal instruction|panic:/i.test(text)) categories.add("native-runtime-failure");
  return [...categories].join(", ") || "unclassified (text redacted)";
}

function recoveryStatusRecords(text: string): Array<Record<string, string | number | null>> {
  const records: Array<Record<string, string | number | null>> = [];
  for (const line of text.slice(-8192).split("\n")) {
    try {
      const record = recoveryStatusRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch { /* malformed/torn records are not evidence */ }
  }
  return records.slice(-16);
}

function recoveryLiveness(pid: unknown, probe: (pid: number) => unknown = pid => process.kill(pid, 0)): string {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unrecorded";
  try { probe(pid); return "alive"; }
  catch (error) { return recoveryOwnData(error, "code") === "ESRCH" ? "absent" : "unknown"; }
}

// Read at most 8 KiB even if a broken child logs continuously. Never emit raw output:
// arbitrary startup messages may include tokens, account identifiers, or request bodies.
function recoveryDiagnosticFile(path: string, status = false): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 8192));
    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    const text = bytes.subarray(0, count).toString("utf8");
    if (status) {
      const records = recoveryStatusRecords(text);
      return JSON.stringify({ records, liveness: {
        launcher: recoveryLiveness(records.findLast(row => row.event === "launcher-start")?.pid),
        runtime: recoveryLiveness(records.findLast(row => row.event === "runtime-spawned")?.pid),
      } });
    }
    const frames = [...text.matchAll(/\b(src\/[\w./-]+\.(?:ts|mjs))(?::(\d+)(?::(\d+))?)?/g)]
      .filter(match => !match[1]!.includes("..") && existsSync(join(repoRoot, match[1]!)))
      .slice(-6).map(match => `${match[1]}${match[2] ? `:${match[2]}` : ""}${match[3] ? `:${match[3]}` : ""}`);
    return `bytes=${size}; ${diagnosticCategories(text)}; frames=${frames.join(", ") || "none"}`.slice(0, 1200);
  } catch {
    return "unavailable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function recoveryInstrumentationPrelude(directory: string): string {
  // Reuse exactly the projector exercised by the in-process redaction tests.
  return `
import { spawn as fixtureSpawn, spawnSync } from "node:child_process";
import { openSync as fixtureOpen, closeSync as fixtureClose, appendFileSync as fixtureAppend } from "node:fs";
const fixtureDiagnosticDir = ${JSON.stringify(directory)};
const RECOVERY_ERROR_CODES = new Set(${JSON.stringify([...RECOVERY_ERROR_CODES])});
const RECOVERY_ERROR_NAMES = new Set(${JSON.stringify([...RECOVERY_ERROR_NAMES])});
const RECOVERY_SIGNALS = new Set(${JSON.stringify([...RECOVERY_SIGNALS])});
const RECOVERY_EVENTS = new Set(${JSON.stringify([...RECOVERY_EVENTS])});
${recoveryOwnData.toString()}
${recoveryErrorFields.toString()}
${recoveryStatusRecord.toString()}
let fixtureStatusCount = 0;
function fixtureStatus(event, fields = {}) {
  if (process.argv[2] !== "start" || fixtureStatusCount >= 16) return;
  try {
    const record = recoveryStatusRecord({ ...fields, v: 1, event });
    if (!record) return;
    fixtureStatusCount += 1;
    fixtureAppend(fixtureDiagnosticDir + "/status", JSON.stringify(record) + "\\n", { mode: 0o600 });
  } catch { /* diagnostics must not interrupt the real exit/signal handler or teardown */ }
}
function spawn(bin, args, options) {
  if (!options?.detached || args[1] !== "start") return fixtureSpawn(bin, args, options);
  const stdout = fixtureOpen(fixtureDiagnosticDir + "/stdout", "a", 0o600);
  let stderr;
  try {
    stderr = fixtureOpen(fixtureDiagnosticDir + "/stderr", "a", 0o600);
    return fixtureSpawn(bin, args, { ...options, stdio: ["ignore", stdout, stderr] });
  } finally {
    fixtureClose(stdout);
    if (stderr !== undefined) fixtureClose(stderr);
  }
}
fixtureStatus("launcher-start", { pid: process.pid });
process.on("exit", code => fixtureStatus("launcher-exit", { exitCode: code, signal: null }));
`;
}

function instrumentRecoveryLauncher(source: string, directory: string): string {
  // Fail closed on drift, preserving the real calls and every original handler.
  const replaceOnce = (needle: string, replacement: string) => {
    if (source.split(needle).length !== 2) throw new Error("recovery diagnostic fixture: launcher seam changed");
    source = source.replace(needle, () => replacement);
  };
  replaceOnce('import { spawn, spawnSync } from "node:child_process";', recoveryInstrumentationPrelude(directory));
  const boot = 'const probe = bootRestoreProbe(resolve(here, ".."));';
  replaceOnce(boot, `fixtureStatus("boot-restore-enter");\n    ${boot}\n    fixtureStatus("boot-restore-result", { action: probe.action });`);
  replaceOnce('} catch { /* the probe must never block launch */ }', '} catch (error) { fixtureStatus("boot-restore-error", recoveryErrorFields(error)); /* the probe must never block launch */ }');
  const runtime = 'const bunRuntime = resolveBun({ allowInstall: !codexCliUpdateInspection });';
  replaceOnce(runtime, `fixtureStatus("runtime-resolution-enter");\n${runtime}\nfixtureStatus("runtime-resolved", { source: bunRuntime.source });`);
  const install = 'const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });';
  replaceOnce(install, `fixtureStatus("runtime-install-enter");\n    ${install}\n    fixtureStatus("runtime-install-result", { exitCode: r.status, signal: r.signal, ...recoveryErrorFields(r.error) });`);
  replaceOnce('const child = spawn(bun,', 'fixtureStatus("runtime-spawn-call");\nconst child = spawn(bun,');
  // The updater exits before its detached child, so observe the Bun child from the
  // recovery launcher itself, BEFORE the existing handler mirrors its exit/signal.
  replaceOnce('child.on("exit", (code, signal) => {', `child.on("exit", (code, signal) => {
  fixtureStatus("runtime-exit", { exitCode: code, signal });`);
  replaceOnce('child.on("error", err => {', `child.on("error", err => {
  fixtureStatus("runtime-spawn-error", recoveryErrorFields(err));`);
  replaceOnce('const clearHandlers = () => {', 'child.on("spawn", () => fixtureStatus("runtime-spawned", { pid: child.pid }));\nconst clearHandlers = () => {');
  return source;
}
const updateSource = readFileSync(join(repoRoot, "src", "update", "index.ts"), "utf8");
const launcherSource = readFileSync(join(repoRoot, "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(repoRoot, "src", "server", "index.ts"), "utf8");
const dispatchSource = readFileSync(join(repoRoot, "src", "cli", "dispatch.ts"), "utf8");

describe("bounded recovery diagnostics", () => {
  test("structured codes preserve resource causes without messages, paths or getter execution", () => {
    const cause = { code: "EMFILE", path: "/synthetic-private/credential" };
    const error = Object.assign(new TypeError("https://secret.invalid/bearer?token=private"), { code: "EAGAIN", cause });
    expect(recoveryErrorFields(error)).toEqual({ errorName: "TypeError", code: "EAGAIN", causeCode: "EMFILE" });
    expect(recoveryErrorFields({ name: "secret", code: "ERR_SECRET_TOKEN", cause: { code: "private" } }))
      .toEqual({ errorName: "unknown", code: "unknown", causeCode: "unknown" });
    let getterCalls = 0;
    const getters = Object.defineProperties({}, Object.fromEntries(["name", "message", "code", "cause", "stack"].map(key => [key, {
      get() { getterCalls += 1; throw new Error("must not read getters"); },
    }])));
    expect(recoveryErrorFields(getters)).toEqual({ errorName: "unknown", code: "unknown", causeCode: "unknown" });
    expect(getterCalls).toBe(0);
    const cyclic = { name: "Error", code: "ENOMEM", cause: undefined as unknown };
    cyclic.cause = cyclic;
    expect(recoveryErrorFields(cyclic)).toEqual({ errorName: "Error", code: "ENOMEM", causeCode: "ENOMEM" });
    expect(recoveryErrorFields(null)).toEqual({ errorName: "unknown", code: "unknown", causeCode: "unknown" });
  });

  test("status projects only event-specific fields and rejects forged schemas", () => {
    expect(recoveryStatusRecord({ v: 1, event: "runtime-resolved", source: "bundled", path: "/synthetic-private", token: "secret", pid: 12 }))
      .toEqual({ v: 1, event: "runtime-resolved", source: "bundled" });
    expect(recoveryStatusRecord({ v: 1, event: "runtime-exit", exitCode: 7, signal: null, stack: "secret" }))
      .toEqual({ v: 1, event: "runtime-exit", exitCode: 7, signal: null });
    expect(recoveryStatusRecord({ v: 1, event: "runtime-exit", exitCode: -1, signal: "SIG_SECRET" }))
      .toEqual({ v: 1, event: "runtime-exit", exitCode: "unknown", signal: "unknown" });
    expect(recoveryStatusRecord({ v: 1, event: "launcher-start", pid: "123 /private" }))
      .toEqual({ v: 1, event: "launcher-start", pid: "unknown" });
    expect(recoveryStatusRecord({ v: 2, event: "runtime-exit" })).toBeNull();
    expect(recoveryStatusRecord({ v: 1, event: "secret" })).toBeNull();
    const many = Array.from({ length: 30 }, () => JSON.stringify({ v: 1, event: "runtime-spawn-call", token: "secret" })).join("\n");
    const records = recoveryStatusRecords(`${many}\nnot-json\n{"v":1`);
    expect(records).toHaveLength(16);
    for (const record of records) expect(record).toEqual({ v: 1, event: "runtime-spawn-call" });
    expect(JSON.stringify(records)).not.toContain("secret");
  });

  test("bounded stderr summaries classify native/resource failures but never expose arbitrary text", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-recovery-redaction-"));
    try {
      const path = join(directory, "stderr");
      writeFileSync(path, "hidden-prefix".repeat(1000) + "\nENOMEM dyld[123]: Library not loaded: /synthetic-private/token\npanic: bearer-secret@example.test\n");
      const summary = recoveryDiagnosticFile(path);
      expect(summary).toContain("ENOMEM");
      expect(summary).toContain("native-loader-failure");
      expect(summary).toContain("native-runtime-failure");
      expect(summary).not.toContain("hidden-prefix");
      expect(summary).not.toContain("/synthetic-private/");
      expect(summary).not.toContain("bearer-secret");
      expect(summary).not.toContain("@");
      expect(summary.length).toBeLessThanOrEqual(1200);
      expect(diagnosticCategories("220 bytes of unknown material: https://secret.invalid/token"))
        .toBe("unclassified (text redacted)");
      const statusPath = join(directory, "status");
      writeFileSync(statusPath, JSON.stringify({ v: 1, event: "runtime-resolved", source: "bundled", path: "secret" }) + "\n");
      expect(JSON.parse(recoveryDiagnosticFile(statusPath, true))).toEqual({
        records: [{ v: 1, event: "runtime-resolved", source: "bundled" }],
        liveness: { launcher: "unrecorded", runtime: "unrecorded" },
      });
    } finally { removeTreeWithRetry(directory); }
  });

  test("liveness distinguishes absent from inaccessible without sending termination signals", () => {
    const calls: number[] = [];
    expect(recoveryLiveness(123, pid => { calls.push(pid); })).toBe("alive");
    expect(calls).toEqual([123]);
    expect(recoveryLiveness(123, () => { throw { code: "ESRCH" }; })).toBe("absent");
    expect(recoveryLiveness(123, () => { throw { code: "EPERM" }; })).toBe("unknown");
    expect(recoveryLiveness(undefined, () => { throw new Error("must not probe"); })).toBe("unrecorded");
  });

  test("instrumentation fails closed if any selected launcher seam disappears or duplicates", () => {
    const seams = [
      'import { spawn, spawnSync } from "node:child_process";',
      'const probe = bootRestoreProbe(resolve(here, ".."));',
      '} catch { /* the probe must never block launch */ }',
      'const bunRuntime = resolveBun({ allowInstall: !codexCliUpdateInspection });',
      'const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });',
      'const child = spawn(bun,', 'child.on("exit", (code, signal) => {',
      'child.on("error", err => {', 'const clearHandlers = () => {',
    ];
    for (const seam of seams) {
      expect(() => instrumentRecoveryLauncher(launcherSource.replace(seam, ""), "/fixture"))
        .toThrow("recovery diagnostic fixture: launcher seam changed");
      expect(() => instrumentRecoveryLauncher(`${launcherSource}\n${seam}`, "/fixture"))
        .toThrow("recovery diagnostic fixture: launcher seam changed");
    }
  });

  test("generated capture wrapper preserves spawn options, return/error identity and FD finally", () => {
    const calls: unknown[][] = [];
    const closed: number[] = [];
    const records: string[] = [];
    let unrefs = 0;
    const child = { unref: () => { unrefs += 1; } };
    const failure = new Error("fixture spawn failure");
    let failSpawn = false;
    let failAppend = false;
    let failSecondOpen = false;
    let nextFd = 10;
    // Evaluate ONLY the generated prelude with inert dependencies, never the real updater.
    const prelude = recoveryInstrumentationPrelude("/fixture").replace(/^import .*;\n/gm, "");
    const fixture = new Function("fixtureSpawn", "fixtureOpen", "fixtureClose", "fixtureAppend", "process",
      `${prelude}\nreturn { spawn, fixtureStatus };`)(
      (...args: unknown[]) => { calls.push(args); if (failSpawn) throw failure; return child; },
      (_path: string, flags: string, mode: number) => {
        expect([flags, mode]).toEqual(["a", 0o600]);
        if (failSecondOpen && nextFd === 11) throw failure;
        return nextFd++;
      },
      (fd: number) => closed.push(fd),
      (_path: string, record: string, options: { mode: number }) => {
        expect(options).toEqual({ mode: 0o600 });
        if (failAppend) throw failure;
        records.push(record);
      },
      { argv: ["node", "fixture", "start"], pid: 123, on: () => {} },
    ) as { spawn: (bin: string, args: string[], options: Record<string, unknown>) => typeof child; fixtureStatus: (event: string, fields?: object) => void };
    const args = ["launcher", "start", "--port", "1234"];
    const env = { FIXTURE: "unchanged" };
    const options = { detached: true, stdio: "ignore", windowsHide: true, env };
    expect(fixture.spawn("node", args, options)).toBe(child);
    expect(calls[0]).toEqual(["node", args, { ...options, stdio: ["ignore", 10, 11] }]);
    expect(calls[0][1]).toBe(args);
    expect((calls[0][2] as { env: unknown }).env).toBe(env);
    expect(options.stdio).toBe("ignore");
    expect(closed).toEqual([10, 11]);
    expect(unrefs).toBe(0);
    child.unref();
    expect(unrefs).toBe(1);
    const ordinary = { stdio: "inherit", env };
    expect(fixture.spawn("bun", ["cli", "start"], ordinary)).toBe(child);
    expect(calls[1][2]).toBe(ordinary);
    expect(closed).toEqual([10, 11]);
    failAppend = true;
    expect(() => fixture.fixtureStatus("runtime-spawn-call")).not.toThrow();
    expect(fixture.spawn("bun", [], ordinary)).toBe(child);
    failAppend = false;
    for (let i = 0; i < 40; i++) fixture.fixtureStatus("runtime-resolved", { source: "bundled", token: "secret" });
    expect(records.length).toBeLessThanOrEqual(16);
    expect(records.join("")).not.toContain("secret");
    failSpawn = true;
    try { fixture.spawn("node", args, options); throw new Error("expected spawn failure"); }
    catch (error) { expect(error).toBe(failure); }
    expect(closed).toEqual([10, 11, 12, 13]);
    failSpawn = false;
    failSecondOpen = true;
    nextFd = 10;
    try { fixture.spawn("node", args, options); throw new Error("expected open failure"); }
    catch (error) { expect(error).toBe(failure); }
    expect(closed.at(-1)).toBe(10);
  });

  test("instrumented inert launcher records milestones without changing error/exit handlers", () => {
    const inertSource = `import { spawn, spawnSync } from "node:child_process";
try {
  const probe = bootRestoreProbe(resolve(here, ".."));
} catch { /* the probe must never block launch */ }
function resolveBun() {
  const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
  return { source: "bundled", path: "fixture-bun" };
}
const bunRuntime = resolveBun({ allowInstall: !codexCliUpdateInspection });
const bun = bunRuntime.path;
const child = spawn(bun, ["fixture-cli", "start"], childOptions);
const clearHandlers = () => { events.push("clear"); };
child.on("error", err => { clearHandlers(); events.push(err); process.exit(1); });
child.on("exit", (code, signal) => {
  clearHandlers();
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
return child;`;
    const source = instrumentRecoveryLauncher(inertSource, "/fixture").replace(/^import .*;\n/gm, "");
    const records: string[] = [];
    const events: unknown[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const child = { pid: 456, on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler) };
    const childOptions = { stdio: "inherit", env: { FIXTURE: "same" } };
    const io = {
      fixtureSpawn: (bin: string, args: string[], options: unknown) => {
        expect([bin, args]).toEqual(["fixture-bun", ["fixture-cli", "start"]]);
        expect(options).toBe(childOptions);
        return child;
      },
      spawnSync: (bin: string, args: string[], options: unknown) => {
        expect([bin, args, options]).toEqual(["node", ["fixture-install"], { stdio: "inherit" }]);
        return { status: 0, signal: null };
      },
      fixtureOpen: () => { throw new Error("runtime stdio must stay inherited"); },
      fixtureClose: () => { throw new Error("no capture FD expected"); },
      fixtureAppend: (_path: string, record: string) => records.push(record),
      process: { argv: ["node", "fixture", "start"], pid: 123, execPath: "node", on: () => {},
        exit: (code: number) => events.push(code), kill: (pid: number, signal: string) => events.push([pid, signal]) },
      bootRestoreProbe: () => ({ action: "none" }), resolve: () => "/fixture", here: "/fixture",
      installJs: "fixture-install", codexCliUpdateInspection: false, childOptions, events,
    };
    const execute = new Function("io", `const { ${Object.keys(io).join(", ")} } = io;\n${source}`);
    expect(execute(io)).toBe(child);
    handlers.get("spawn")!();
    handlers.get("exit")!(7, null);
    expect(events).toEqual(["clear", 7]);
    handlers.get("exit")!(null, "SIGTERM");
    expect(events.slice(-2)).toEqual(["clear", [123, "SIGTERM"]]);
    const failure = Object.assign(new Error("private error text"), { code: "EAGAIN", cause: { code: "ENOMEM" } });
    handlers.get("error")!(failure);
    expect(events.slice(-3)).toEqual(["clear", failure, 1]);
    const decoded = recoveryStatusRecords(records.join(""));
    expect(decoded.map(row => row.event)).toEqual([
      "launcher-start", "boot-restore-enter", "boot-restore-result", "runtime-resolution-enter",
      "runtime-install-enter", "runtime-install-result", "runtime-resolved", "runtime-spawn-call",
      "runtime-spawned", "runtime-exit", "runtime-exit", "runtime-spawn-error",
    ]);
    expect(decoded.at(-1)).toEqual({ v: 1, event: "runtime-spawn-error", errorName: "Error", code: "EAGAIN", causeCode: "ENOMEM" });
    expect(records.join("")).not.toContain("private error text");
    events.length = 0;
    handlers.clear();
    expect(execute({ ...io, fixtureAppend: () => { throw new Error("diagnostic disk unavailable"); } })).toBe(child);
    handlers.get("error")!(failure);
    expect(events).toEqual(["clear", failure, 1]);
  });
});

describe("update stops the running proxy before replacing files", () => {
  // The recovery case starts a real detached proxy, and its own result says nothing about
  // whether cleanup reaped it — it stayed green while an escapee spun on a deleted tree for
  // hours. Auditing the pid once the suite is done turns a silent leak back into a red test.
  let auditedRecoveryPid: number | undefined;

  afterAll(() => {
    if (auditedRecoveryPid === undefined) return;
    expect(isProcessAlive(auditedRecoveryPid)).toBe(false);
  });

  test("recovery sandbox replaces an inherited Codex home without claiming a managed service", () => {
    const parentEnv = { CODEX_HOME: "/synthetic-parent-codex", OCX_REAL_HOME: "/synthetic-real-home", FIXTURE: "unchanged" };
    const isolated = createIsolatedTestEnvironment(parentEnv);
    try {
      expect(resolveCodexHomeDir({ env: isolated.env })).toBe(join(isolated.root, ".codex"));
      expect(existsSync(join(isolated.root, ".codex"))).toBe(true);
      expect(isolated.env.OCX_REAL_HOME).toBe("/synthetic-real-home");
      expect(isolated.env.FIXTURE).toBe("unchanged");
      expect(existsSync(join(isolated.root, ".opencodex", "service-state.json"))).toBe(false);
      expect(parentEnv).toEqual({ CODEX_HOME: "/synthetic-parent-codex", OCX_REAL_HOME: "/synthetic-real-home", FIXTURE: "unchanged" });
    } finally {
      isolated.cleanup();
    }
  });

  test("a failed cache pre-flight aborts before the stop callback can run", () => {
    let stopped = false;
    const malformedSpawn = (() => ({ status: 0, signal: null, stdout: "not-json", stderr: "" })) as never;
    const preflight = runNpmCachePreflight({ platform: "linux", spawnSyncFn: malformedSpawn });

    if (preflight.ok) stopped = true;

    expect(preflight).toEqual({ ok: false, reason: "worker_output_malformed" });
    expect(stopped).toBe(false);
  });

  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, selfLaunchArgv(["stop"])');
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const updateAt = updateSource.indexOf("spawnSync(target.bin, target.args");
    expect(stopAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding())");
  });

  test("integrity pre-flight runs BEFORE the stop so anomalous metadata never unloads the proxy", () => {
    const gateAt = updateSource.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const abortAt = updateSource.indexOf("aborting the update before stopping the proxy");
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    expect(gateAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(stopAt);
    expect(abortAt).toBeLessThan(stopAt);
  });

  test("cache access gates in both CLI entry points precede every tray/proxy stop", () => {
    const runtimeGate = updateSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const runtimeStop = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherGate = launcherSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const launcherTrayStop = launcherSource.indexOf('runTrayLifecycle(launcher, "stop")');
    const launcherProxyStop = launcherSource.indexOf('[launcher, "stop"]');

    expect(runtimeGate).toBeGreaterThan(-1);
    expect(launcherGate).toBeGreaterThan(-1);
    expect(runtimeGate).toBeLessThan(runtimeStop);
    expect(launcherGate).toBeLessThan(launcherTrayStop);
    expect(launcherGate).toBeLessThan(launcherProxyStop);
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    // #1942: the destructive step is now the transactional staged update, not a direct
    // global npm install. The stop must still precede it.
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(stopAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
    expect(launcherSource).toContain('existsSync(join(configDir(), "runtime-port.json"))');
  });

  test("Windows npm paths resolve safely before stop and never use shell:true", () => {
    const updateResolveAt = updateSource.indexOf("const target = updateSpawnTarget(bin, cmdArgs);");
    const updateStopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherResolveAt = launcherSource.indexOf("const installInvocation = npmInvocation(");
    const launcherStopAt = launcherSource.indexOf('[launcher, "stop"]');

    expect(updateResolveAt).toBeGreaterThan(-1);
    expect(launcherResolveAt).toBeGreaterThan(-1);
    expect(updateResolveAt).toBeLessThan(updateStopAt);
    expect(launcherResolveAt).toBeLessThan(launcherStopAt);
    expect(updateSource).not.toContain("shell: true");
    expect(launcherSource).not.toContain("shell: true");
    expect(updateSource).not.toContain('"npm.cmd"');
    expect(launcherSource).not.toContain('"npm.cmd"');
  });

  test("both paths abort when the stop fails, and REPAIR a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    // 260804 #970: the refresh must not re-register. `install` reaches `schtasks /create`
    // on Windows scheduler backends, which a non-elevated updater cannot run — it would
    // stop a working proxy and then fail to bring its service back.
    expect(updateSource).toContain("serviceReinstallArgs()");
    expect(launcherSource).toContain("aborting the update");
    expect(launcherSource).toContain('"service", "repair"');
    // The launcher still reads service-state.json for service-installed detection, and
    // for the backend choice on the genuinely-absent install fallback.
    expect(launcherSource).toContain('"service-state.json"');
    // That marker can be STALE, so the fallback asks for structured state rather than
    // parsing a failure message; bin/ocx.mjs is plain Node and cannot import
    // diagnoseService(), so it reads startup.serviceInstalled from `status --json`.
    expect(launcherSource).toContain("startup?.serviceInstalled");
    expect(updateSource).toContain("OCX_BAKE_PORT");
    expect(launcherSource).toContain("OCX_BAKE_PORT");
    // Live runtime port 10100 must not be discarded as a missing-port sentinel.
    expect(launcherSource).toContain("sawRuntimePort");
    expect(updateSource).toContain("runtimeTrusted");
  });

  test.skipIf(process.platform === "win32")(
    "npm launcher restarts the stopped runtime after a staged update failure",
    async () => {
      const isolated = createIsolatedTestEnvironment();
      const root = isolated.root;
      const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
      const launcher = join(packageRoot, "bin", "ocx.mjs");
      const opencodexHome = isolated.env.OPENCODEX_HOME!;
      const fakeBin = join(root, "fake-bin");
      const fakeNpm = join(fakeBin, "npm");
      const cache = join(root, "npm-cache");
      const diagnostics = join(root, "recovery-diagnostics");
      const bundledBun = join(repoRoot, "node_modules", "bun");
      const env = {
        ...isolated.env,
        OCX_FAKE_NPM_CACHE: cache,
        PATH: `${fakeBin}:${isolated.env.PATH ?? ""}`,
      };
      let recoveredPid: number | undefined;

      try {
        // Bind the actual child environment, not merely HOME, to this case.
        expect(resolveCodexHomeDir({ env })).toBe(join(root, ".codex"));
        const port = await freePort();
        expect(existsSync(bundledBun)).toBe(true);
        mkdirSync(dirname(launcher), { recursive: true });
        mkdirSync(join(packageRoot, "node_modules"), { recursive: true });
        mkdirSync(opencodexHome, { recursive: true });
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(cache, { recursive: true });
        mkdirSync(diagnostics, { mode: 0o700 });
        for (const name of ["stdout", "stderr", "status"]) {
          writeFileSync(join(diagnostics, name), "", { mode: 0o600, flag: "wx" });
        }
        writeFileSync(launcher, instrumentRecoveryLauncher(launcherSource, diagnostics));
        chmodSync(launcher, 0o755);
        symlinkSync(join(repoRoot, "src"), join(packageRoot, "src"), "dir");
        symlinkSync(bundledBun, join(packageRoot, "node_modules", "bun"), "dir");
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
          name: "@bitkyc08/opencodex",
          version: "1.0.0",
          type: "module",
        }));
        writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ port }));
        writeFileSync(join(opencodexHome, "runtime-port.json"), JSON.stringify({ port, pid: 999_999_999 }));
        writeFileSync(fakeNpm, `#!/bin/sh
case "$1" in
  view) printf '2.0.0\\n' ;;
  config) printf '%s\\n' "$OCX_FAKE_NPM_CACHE" ;;
  install) exit 1 ;;
  *) exit 1 ;;
esac
`);
        chmodSync(fakeNpm, 0o755);

        const result = Bun.spawnSync(["node", launcher, "update"], {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: UPDATE_SPAWN_TIMEOUT_MS,
        });
        const output = result.stdout.toString() + result.stderr.toString();

        expect(result.exitCode).toBe(1);
        expect(output).toContain("Stopping the running proxy before updating");
        expect(output).toContain("restarting the previous version directly");
        expect(output).toContain(`Attempting to restart the proxy on port ${port}.`);
        expect(await waitForProxy(port, lastProbe => {
          console.error(new Error([
            "Recovery readiness failed (raw child output redacted).",
            `lastProbe=${lastProbe}`,
            `runtimeFiles=${JSON.stringify(Object.fromEntries(["ocx.pid", "runtime-port.json"].map(name => [name, existsSync(join(opencodexHome, name))])))}`,
            `status=${recoveryDiagnosticFile(join(diagnostics, "status"), true)}`,
            `stdout=${recoveryDiagnosticFile(join(diagnostics, "stdout"))}`,
            `stderr=${recoveryDiagnosticFile(join(diagnostics, "stderr"))}`,
          ].join("\n").slice(0, 4096)));
        })).toBe(true);
        const runtime = JSON.parse(readFileSync(join(opencodexHome, "runtime-port.json"), "utf8"));
        expect(runtime.pid).toBeGreaterThan(0);
        recoveredPid = runtime.pid;
      } finally {
        // Resolve the pid FIRST. `stop` rewrites runtime-port.json and the rmSync below
        // deletes it outright, so this is the last moment the detached proxy the recovery
        // path started can still be identified at all.
        if (!recoveredPid) {
          try {
            recoveredPid = JSON.parse(readFileSync(join(opencodexHome, "runtime-port.json"), "utf8")).pid;
          } catch { /* the proxy never wrote runtime state */ }
        }
        auditedRecoveryPid = Number.isSafeInteger(recoveredPid) && recoveredPid! > 0
          ? recoveredPid
          : undefined;
        if (existsSync(launcher)) {
          Bun.spawnSync(["node", launcher, "stop"], {
            cwd: root,
            env,
            stdout: "ignore",
            stderr: "ignore",
            timeout: UPDATE_SPAWN_TIMEOUT_MS,
          });
        }
        try {
          // `stop` exiting 0 is a claim, not proof: it also reports success when it finds no
          // live runtime to stop, which is indistinguishable here from one it failed to stop.
          // Gating the reap on that exit code let a detached proxy survive, get reparented to
          // init, and then spin on a fixture tree this same block had already deleted — one
          // escapee burned a full core for hours. Verify liveness and reap regardless.
          // bin/ocx.mjs mirrors its Bun child's exit, so reaping the recorded child pid takes
          // the node launcher with it.
          if (Number.isSafeInteger(recoveredPid) && recoveredPid! > 0 && isProcessAlive(recoveredPid!)) {
            killProxy(recoveredPid!);
          }
        } finally {
          // Ordered after the reap on purpose: deleting the tree out from under a live
          // detached proxy is what turned a missed kill into a permanently spinning orphan.
          removeTreeWithRetry(root);
        }
      }
    },
    RECOVERY_CASE_TIMEOUT_MS,
  );

  /**
   * The budget arithmetic itself, pinned.
   *
   * The recovery case spawns `update`, waits for readiness, then spawns `stop`. A wait budget
   * chosen independently of the Bun timeout is how this test became flaky: 45s of readiness
   * inside a 60s case that also spends up to 60s on two spawns cannot finish, and it failed at
   * 46-47s on macOS while the product was healthy.
   *
   * This asserts the relationship rather than the numbers, so raising any single budget in
   * future cannot silently recreate the impossible one.
   */
  test("the recovery case timeout can actually contain its own spawns and readiness wait", () => {
    // Both spawns plus the readiness wait must fit, with room left for fixture IO.
    const consumed = UPDATE_SPAWN_TIMEOUT_MS * 2 + PROXY_READY_TIMEOUT_MS;
    expect(RECOVERY_CASE_TIMEOUT_MS).toBeGreaterThanOrEqual(consumed);
    expect(RECOVERY_CASE_TIMEOUT_MS - consumed).toBeGreaterThanOrEqual(10_000);
  });


  test("both update paths surface an incomplete manifest-backed history restore after the stop", () => {
    // A codex-history-backup-*.json surviving `ocx stop` means exact metadata restoration
    // remains pending. It can be contention or an integrity refusal, so neither update path
    // may claim a DB lock or that every routed thread is hidden.
    expect(updateSource).toContain("export function historyRestoreIncomplete(");
    expect(updateSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    // The warning now also fires on the dedicated stop code, so the manifest check is one
    // of two triggers rather than the whole condition (#3008).
    expect(updateSource).toContain("if (historyOnlyStop || historyRestoreIncomplete())");
    expect(launcherSource).toContain("function historyRestoreIncomplete()");
    expect(launcherSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(launcherSource).toContain("if (historyOnlyStop || historyRestoreIncomplete())");
    const warnAt = launcherSource.indexOf("Codex resume-history metadata restore is incomplete");
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(warnAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
    expect(updateSource).toContain("manifest/target may need review");
    expect(launcherSource).toContain("untracked routed history is intentionally unchanged");
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    // A pending-teardown receipt is a fourth reason to stop: after a parent crashed
    // mid-deferral the service, pid and runtime records can all be absent while shared
    // client config still points at a proxy that is gone (#3008).
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState || hasPendingTeardown)");
    // The rule now lives in the shared post-stop decision both lanes import (#3008): a
    // history-only stop proceeds, every other nonzero status and any surviving runtime
    // state aborts. Pinned by tests/update/update-stop-classification.test.ts.
    expect(launcherSource).toContain("decidePostStopUpdate({");
    expect(launcherSource).toContain("hasRuntimeState: stillHasRuntimeState");
  });

  test("GUI worker update children use pipe stdio so background updates do not open consoles", () => {
    expect(updateSource).toContain("function updateChildStdio()");
    expect(updateSource).toContain('process.env.OCX_SERVICE === "1"');
    expect(updateSource).toContain('return "pipe"');
    // All three update children (stop, installer, service reinstall) go through it.
    expect(updateSource).toContain("stdio: stopStdio");
    expect(updateSource).toContain("stdio: installStdio");
    expect(updateSource).toContain("stdio: svcStdio");
    expect(updateSource).toContain("windowsHide: true");
  });
});

describe("ocx update --help has no side effects (#168)", () => {
  test("the Bun CLI short-circuits help before importing the update runner", () => {
    const caseAt = dispatchSource.indexOf('update: async');
    const helpAt = dispatchSource.indexOf('printSubcommandUsage("update")');
    const runAt = dispatchSource.indexOf("await runUpdate()");
    expect(caseAt).toBeGreaterThan(-1);
    expect(helpAt).toBeGreaterThan(caseAt);
    expect(helpAt).toBeLessThan(runAt);
  });

  test("the npm launcher intercepts update --help before the self-update path", () => {
    const helpAt = launcherSource.indexOf("updateHelpRequested");
    const updateAt = launcherSource.indexOf("runNpmSelfUpdate();");
    expect(helpAt).toBeGreaterThan(-1);
    expect(launcherSource).toContain('process.argv[2] === "update" &&');
    // The guard that CALLS the self-update must come after the help exit.
    const guardAt = launcherSource.lastIndexOf('process.argv[2] === "update" && isNodeModulesInstall()');
    expect(helpAt).toBeLessThan(guardAt);
    expect(updateAt).toBeGreaterThan(guardAt);
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: healthPort");
  });
});
