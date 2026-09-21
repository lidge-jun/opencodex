/**
 * The installed-artifact gate (D9 part two, R3).
 *
 * Installs the REAL desktop artifact on the host platform, launches it against a staged
 * npm runtime, and drives the ownership contract from devlog plan 260921
 * (080_decisions_round2.md): the staged runtime on a non-default port is drained with
 * its registration preserved, the desktop install id becomes the owner with exactly one
 * consent-generation increment, healthz on the preserved home and port reports the
 * bundled sidecar as a child of the app process, close and the OS quit gesture leave
 * both pids alive with the window reopenable, a full quit and relaunch restore
 * ownership without re-asking consent, and tray Quit lets an in-flight request finish
 * before both pids end. On Linux both update paths are exercised (R3): an AppImage
 * updates in place without elevation to the exact target bytes, and a deb install asks
 * for authorization only after Install is chosen, never retries a cancelled prompt with
 * another elevation mechanism, preserves the old version on cancel, and installs the
 * new version on accept.
 *
 * Safety shape, per the external re-audit (110_reaudit.md):
 * - preflight-isolation runs BEFORE any mutation. A run that refuses because it found
 *   an existing app, service registration or default-home state makes ZERO mutating
 *   calls, cleanup included — cleanup only ever touches resources this run acquired.
 * - GUI automation comes from operator-installed hook FILES under --hooks-dir, never
 *   from dispatch-provided command text.
 * - version inputs are strict semver; the npm package name is derived from this
 *   repository's own package.json, never accepted as an argument.
 *
 * Every side effect goes through GateDeps so tests can prove call discipline (see the
 * refusal test in tests/ci-workflows/installed-gate-drivers.test.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { commandInvocation } from "../../src/lib/win-exec";
import {
  type CommandSpec,
  type GateFormat,
  type GatePlatform,
  type PlatformAdapter,
  type ProcessEvidence,
  linuxAdapter,
  macosAdapter,
  windowsAdapter,
} from "./installed-gate-platforms";

export interface GateOptions {
  platform: GatePlatform;
  format: GateFormat;
  artifact: string;
  olderArtifact?: string;
  workDir: string;
  toVersion: string;
  fromVersion?: string;
  reportPath: string;
  hooksDir?: string;
  consentHook?: string;
  trayClickHook?: string;
  trayQuitHook?: string;
  trayCheckHook?: string;
  trayInstallHook?: string;
  /** Hook that answers the deb update's elevation prompt (drives the accept path). */
  elevateAcceptHook?: string;
  takeoverTimeoutMs: number;
}

export interface GatePhaseResult {
  phase: string;
  status: "pass" | "fail";
  detail: string;
  evidence: Record<string, unknown>;
}

export interface GateReport {
  platform: GatePlatform;
  format: GateFormat;
  toVersion: string;
  startedAt: string;
  finishedAt?: string;
  phases: GatePhaseResult[];
  ok?: boolean;
}

export interface SpawnedProcess {
  pid: number;
  kill: () => void;
  exited: Promise<number>;
}

/**
 * Every side effect the engine can perform. Tests inject fakes; production gets the
 * real implementations from defaultGateDeps().
 */
export interface GateDeps {
  run(spec: CommandSpec, env?: Record<string, string | undefined>): Promise<ProcessEvidence>;
  pidAlive(pid?: number): boolean;
  killProcess(pid: number): void;
  fileExists(path: string): boolean;
  readJsonFile(path: string): unknown;
  writeTextFile(path: string, content: string): void;
  makeDir(path: string): void;
  fetchJson(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number; body: unknown }>;
  spawnLogged(binary: string, logPath: string, errPath: string, env: Record<string, string | undefined>): SpawnedProcess;
  serveMockProvider(): MockProvider;
  digestFile(path: string): string | null;
  homeDir(): string;
  sleep(ms: number): Promise<void>;
  readTextFile(path: string): string;
}

/** Hook names are file names inside --hooks-dir, nothing more. */
const HOOK_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Version inputs become npm dist-tags and artifact URLs. Strict semver shape is the
 * whole grammar they are allowed to carry — anything else (an npm alias like
 * npm:other@latest, a flag fragment) is rejected before it can reach npm or a shell.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Numeric-triple semver order. A prerelease suffix sorts before the bare release of the
 * same triple; two suffixed versions compare lexically. The gate only needs "strictly
 * older" answers for well-formed inputs, which parseGateArguments guarantees.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [triple, suffix] = v.split("-", 2);
    const parts = triple!.split(".").map(Number);
    return { parts, suffix };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const delta = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.suffix === right.suffix) return 0;
  if (left.suffix === undefined) return 1;
  if (right.suffix === undefined) return -1;
  return left.suffix < right.suffix ? -1 : 1;
}

export function parseGateArguments(argv: string[]): { options?: GateOptions; error?: string } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const required = ["platform", "format", "artifact", "work-dir", "to-version", "report"] as const;
  const missing = required.filter(name => !value(name));
  if (missing.length > 0) {
    return { error: `missing required arguments: ${missing.map(name => `--${name}`).join(", ")}` };
  }
  const platform = value("platform");
  const format = value("format");
  if (platform !== "macos" && platform !== "windows" && platform !== "linux") {
    return { error: "--platform must be macos, windows or linux" };
  }
  const expectedFormat: Record<GatePlatform, GateFormat[]> = {
    macos: ["dmg"],
    windows: ["msi"],
    linux: ["deb", "appimage"],
  };
  if (!expectedFormat[platform].includes(format as GateFormat)) {
    return { error: `--format ${format} is not a ${platform} artifact format` };
  }
  // R3: a Linux gate that cannot see one of the two promised update paths is not a gate,
  // so the older artifact and its version are required, exactly like every other input.
  if (platform === "linux" && !value("older-artifact")) {
    return { error: "--older-artifact is required on linux: both update paths are in scope" };
  }
  const toVersion = value("to-version")!;
  const fromVersion = value("from-version");
  if (!SEMVER.test(toVersion)) return { error: "--to-version must be a strict semver (x.y.z[-suffix])" };
  if (fromVersion !== undefined && !SEMVER.test(fromVersion)) {
    return { error: "--from-version must be a strict semver (x.y.z[-suffix])" };
  }
  if (platform === "linux") {
    if (!fromVersion) return { error: "--from-version is required on linux: the update phases need a proven-older release" };
    if (fromVersion === toVersion) return { error: "--from-version must differ from --to-version" };
    if (compareSemver(fromVersion, toVersion) >= 0) {
      return { error: "--from-version must be strictly older than --to-version" };
    }
  }
  const hooksDir = value("hooks-dir");
  const hooks: Array<[keyof GateOptions, string | undefined]> = [
    ["consentHook", value("consent-hook")],
    ["trayClickHook", value("tray-click-hook")],
    ["trayQuitHook", value("tray-quit-hook")],
    ["trayCheckHook", value("tray-check-hook")],
    ["trayInstallHook", value("tray-install-hook")],
    ["elevateAcceptHook", value("elevate-accept-hook")],
  ];
  for (const [key, name] of hooks) {
    if (name === undefined) continue;
    if (!hooksDir) return { error: `--${key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())} requires --hooks-dir` };
    if (!HOOK_NAME.test(name)) {
      return { error: `hook name \`${name}\` must be a plain file name inside the hooks directory` };
    }
  }
  const takeoverTimeoutMs = Number(value("takeover-timeout") ?? 180) * 1000;
  if (!Number.isFinite(takeoverTimeoutMs) || takeoverTimeoutMs <= 0) {
    return { error: "--takeover-timeout must be a positive number of seconds" };
  }
  return {
    options: {
      platform,
      format: format as GateFormat,
      artifact: value("artifact")!,
      olderArtifact: value("older-artifact"),
      workDir: value("work-dir")!,
      toVersion,
      fromVersion,
      reportPath: value("report")!,
      hooksDir,
      consentHook: value("consent-hook"),
      trayClickHook: value("tray-click-hook"),
      trayQuitHook: value("tray-quit-hook"),
      trayCheckHook: value("tray-check-hook"),
      trayInstallHook: value("tray-install-hook"),
      elevateAcceptHook: value("elevate-accept-hook"),
      takeoverTimeoutMs,
    },
  };
}

/**
 * The staged npm runtime's package spec, derived from this repository's own
 * package.json — the gate never takes a package spec as an argument.
 */
export function npmPackageSpec(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

export function readOwnPackageName(packageJsonText: string): string | undefined {
  try {
    const parsed = JSON.parse(packageJsonText) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export interface OwnershipObservation {
  ownerInstallId?: string;
  consentGeneration?: number;
  raw: unknown;
}

/**
 * Reads the durable ownership fields from service-state.json using lane C's schema:
 * the record root carries an \`ownership\` object with the desktop install id and the
 * consent generation. Any other shape is no observation, and the phase fails naming
 * the file it read — the gate does not guess at schemas.
 */
export function observeOwnership(state: unknown): OwnershipObservation {
  if (typeof state !== "object" || state === null) return { raw: state };
  const ownership = (state as Record<string, unknown>).ownership;
  if (typeof ownership !== "object" || ownership === null) return { raw: state };
  const record = ownership as Record<string, unknown>;
  return {
    ownerInstallId: typeof record.installId === "string" ? record.installId : undefined,
    consentGeneration: typeof record.consentGeneration === "number" ? record.consentGeneration : undefined,
    raw: state,
  };
}

export function evaluateOwnership(
  before: OwnershipObservation,
  after: OwnershipObservation,
): { ok: boolean; detail: string } {
  if (before.ownerInstallId !== undefined) {
    return { ok: false, detail: "the staged npm runtime already carried an owner; the takeover precondition is an unowned runtime" };
  }
  if (!after.ownerInstallId) {
    return { ok: false, detail: "the desktop install id is not recorded as owner in service-state.json" };
  }
  const beforeGeneration = before.consentGeneration ?? 0;
  if (after.consentGeneration === undefined) {
    return { ok: false, detail: "no consent generation is recorded in service-state.json" };
  }
  if (after.consentGeneration !== beforeGeneration + 1) {
    return {
      ok: false,
      detail: `consent generation moved from ${beforeGeneration} to ${after.consentGeneration}; the contract allows exactly one increment`,
    };
  }
  return { ok: true, detail: `owner ${after.ownerInstallId} recorded with consent generation ${after.consentGeneration}` };
}

/**
 * Parses a pid listing. Empty output is no pids — never pid 0, which on POSIX means
 * the caller's own process group and must never be signalled from here.
 */
export function parsePidList(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0);
}

export function describeGatePhases(options: GateOptions): string[] {
  const phases = [
    "preflight-isolation",
    "runner-readiness",
    "stage-npm-runtime",
    "install-artifact",
    "launch-and-take-over",
    "runtime-identity",
    "close-gesture",
    "quit-gesture",
    "relaunch-consent",
    "tray-quit-drains",
  ];
  if (options.platform === "linux") phases.push("update-verify");
  phases.push("cleanup");
  return phases;
}

export function summarizeReport(report: GateReport): string {
  const lines = report.phases.map(
    phase => `${phase.status === "pass" ? "PASS" : "FAIL"}  ${phase.phase}${phase.detail ? ` — ${phase.detail}` : ""}`,
  );
  return [`installed-artifact gate: ${report.ok ? "PASS" : "FAIL"} (${report.platform}/${report.format} v${report.toVersion})`, ...lines].join("\n");
}

interface Healthz {
  status: string;
  version?: string;
  pid?: number;
  role?: string;
}

const NON_DEFAULT_PORT = 10431;
const ELEVATION_POLL_MS = 250;

export interface MockProvider {
  port: number;
  /** Resolves when the first chat completion actually reached the mock. */
  reached: Promise<void>;
  /** Lets the held request finish. */
  release: () => void;
  stop: () => void;
}

/** The openai-chat compatible mock the drain phase holds an in-flight request against. */
export function startMockProvider(): MockProvider {
  let finish: () => void = () => {};
  let markReached: () => void = () => {};
  const held = new Promise<void>(resolve => { finish = resolve; });
  const reached = new Promise<void>(resolve => { markReached = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      if (new URL(request.url).pathname.endsWith("/chat/completions")) {
        markReached();
        await held;
        return Response.json({
          id: "gate-drain",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "drained" }, finish_reason: "stop" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port, reached, release: finish, stop: () => server.stop(true) };
}

export function defaultGateDeps(): GateDeps {
  const spawnProcess = (binary: string, env: Record<string, string | undefined>, outPath?: string, errPath?: string): SpawnedProcess => {
    const invocation = commandInvocation(binary, []);
    const child = Bun.spawn({
      cmd: [invocation.file, ...invocation.args],
      env,
      // Bun.spawn accepts a BunFile directly; a FileSink is not a valid stdio target.
      stdout: outPath ? Bun.file(outPath) : "ignore",
      stderr: errPath ? Bun.file(errPath) : "ignore",
      stdin: "ignore",
      ...invocation.options,
    });
    return { pid: child.pid, kill: () => child.kill(), exited: child.exited };
  };
  return {
    run: async (spec, env) => {
      const invocation = commandInvocation(spec.file, spec.args);
      const proc = Bun.spawn({
        cmd: [invocation.file, ...invocation.args],
        stdout: "pipe",
        stderr: "pipe",
        env: env ?? { ...process.env },
        ...invocation.options,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: exitCode === 0, exitCode, stdout, stderr };
    },
    pidAlive: pid => {
      if (typeof pid !== "number") return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    killProcess: pid => process.kill(pid),
    fileExists: path => existsSync(path),
    readJsonFile: path => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
    },
    writeTextFile: (path, content) => writeFileSync(path, content),
    makeDir: path => mkdirSync(path, { recursive: true }),
    fetchJson: async (url, init) => {
      const response = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        signal: AbortSignal.timeout(init?.timeoutMs ?? 4000),
      });
      let body: unknown = undefined;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { ok: response.ok, status: response.status, body };
    },
    spawnLogged: (binary, logPath, errPath, env) => spawnProcess(binary, env, logPath, errPath),
    serveMockProvider: () => startMockProvider(),
    digestFile: path => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null),
    homeDir: () => homedir(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    readTextFile: path => readFileSync(path, "utf8"),
  };
}

export async function runGate(options: GateOptions, deps: GateDeps = defaultGateDeps()): Promise<GateReport> {
  const report: GateReport = {
    platform: options.platform,
    format: options.format,
    toVersion: options.toVersion,
    startedAt: new Date().toISOString(),
    phases: [],
  };
  const workDir = options.workDir;
  const home = join(workDir, "preserved-home");
  const codexHome = join(workDir, "codex-home");
  const npmPrefix = join(workDir, "npm-prefix");
  const port = NON_DEFAULT_PORT;
  const isolatedEnv = (): Record<string, string | undefined> => ({
    ...process.env,
    OPENCODEX_HOME: home,
    CODEX_HOME: codexHome,
  });
  // Every command the gate drives runs under the staged homes — a probe or a service
  // invocation must never read the runner account's real opencodex or codex home.
  const run = (spec: CommandSpec): Promise<ProcessEvidence> => deps.run(spec, isolatedEnv());
  const adapter: PlatformAdapter = (options.platform === "macos" ? macosAdapter : options.platform === "windows" ? windowsAdapter : linuxAdapter)(
    { run, mkdir: path => deps.makeDir(path), fileExists: path => deps.fileExists(path), homeDir: () => deps.homeDir() },
  );
  const launcher = adapter.npmLauncher(npmPrefix);
  const spawned: SpawnedProcess[] = [];
  let npmPid: number | undefined;
  let appPid: number | undefined;
  let appBinary: string | undefined;
  let packageName: string | undefined;
  let takeoverOwnerId: string | undefined;
  let takeoverGeneration: number | undefined;
  let takeoverRuntimePid: number | undefined;
  let installScope: string | undefined;
  let mock: MockProvider | undefined;
  let stopVerification = false;

  const record = (phase: string, ok: boolean, detail: string, evidence: Record<string, unknown> = {}) => {
    report.phases.push({ phase, status: ok ? "pass" : "fail", detail, evidence });
    if (!ok) stopVerification = true;
  };

  const listPids = async (spec: CommandSpec): Promise<number[]> => {
    const result = await run(spec);
    if (!result.ok) return [];
    return parsePidList(result.stdout);
  };

  const healthz = async (): Promise<Healthz | null> => {
    try {
      const response = await deps.fetchJson(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 4000 });
      if (!response.ok) return null;
      const body = response.body as Record<string, unknown>;
      if (body?.status !== "ok") return null;
      return {
        status: "ok",
        version: typeof body.version === "string" ? body.version : undefined,
        pid: typeof body.pid === "number" ? body.pid : undefined,
        role: typeof body.role === "string" ? body.role : undefined,
      };
    } catch {
      return null;
    }
  };

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await deps.sleep(everyMs);
    }
    return await predicate();
  };

  /**
   * A registration is present when any manager probe exits zero OR any on-disk
   * registration file exists — unloaded launchd jobs, disabled systemd units and the
   * WinSW native service all leave traces a single manager query would miss.
   */
  /** Resources THIS invocation placed on the machine; cleanup touches nothing else. */
  const acquired = { service: false, artifact: false };

  const resolveHook = (name?: string): string | undefined =>
    name && options.hooksDir ? join(options.hooksDir, name) : undefined;

  /** A pre-installed hook file runs directly, never through a shell. */
  const runHook = async (name: string | undefined, fallback: () => CommandSpec | null): Promise<{ ok: boolean; via: string }> => {
    const hook = resolveHook(name);
    if (hook) {
      if (!deps.fileExists(hook)) return { ok: false, via: `missing hook ${hook}` };
      return { ok: (await run({ file: hook, args: [] })).ok, via: hook };
    }
    const spec = fallback();
    if (!spec) return { ok: false, via: "no hook and no platform default" };
    return { ok: (await run(spec)).ok, via: spec.file };
  };

  const windowVisible = async (): Promise<boolean> => {
    const probe = await run(adapter.windowVisible());
    // macOS prints a window count, Linux prints one window id per line, Windows
    // prints nothing and answers through the exit code.
    const firstLine = probe.stdout.trim().split(/\r?\n/)[0] ?? "";
    return probe.ok && (firstLine === "" || Number(firstLine) > 0);
  };

  try {
    // ---- preflight-isolation: refuse to touch a machine with real opencodex state.
    // This phase completes BEFORE anything mutating; a refusal skips every later phase,
    // and the cleanup below touches only resources recorded in `acquired`/`spawned`.
    // Registration absence must be PROVEN: an unreadable manager probe is "unknown",
    // and unknown refuses the run exactly like present does.
    const registration = await adapter.registrationState();
    const defaultState = join(deps.homeDir(), ".opencodex", "service-state.json");
    const defaultStatePresent = deps.fileExists(defaultState);
    const runningApp = await listPids(adapter.appNameProbe());
    // A dormant install counts too: the gate would overwrite it, and cleanup could
    // then remove something this run never installed. For deb the package name is read
    // from the artifact (read-only) before probing dpkg.
    let dormantInstall = false;
    if (options.format === "deb") {
      const nameProbe = await run({ file: "dpkg-deb", args: ["-f", options.artifact, "Package"] });
      if (nameProbe.ok && nameProbe.stdout.trim()) {
        const installed = adapter.existingInstallation("deb", nameProbe.stdout.trim());
        dormantInstall = installed !== null && (await run(installed)).ok;
      }
    } else {
      const installed = adapter.existingInstallation(options.format);
      dormantInstall = installed !== null && (await run(installed)).ok;
    }
    const isolated = registration === "absent" && !defaultStatePresent && runningApp.length === 0 && !dormantInstall;
    record(
      "preflight-isolation",
      isolated,
      isolated
        ? "no existing registration, default-home state or running app"
        : "this runner already carries opencodex state; the gate would overwrite or remove it — refusing to run",
      { registration, defaultStatePresent, runningApp, dormantInstall },
    );

    if (!stopVerification) {
      deps.makeDir(home);
      deps.makeDir(codexHome);
      // ---- runner-readiness: every external command the adapter needs must resolve
      // before an artifact is installed.
      const dependencies = [...adapter.dependencies(), "npm"];
      const missing: string[] = [];
      for (const dependency of dependencies) {
        const probe = process.platform === "win32"
          ? await run({ file: "where.exe", args: [dependency] })
          : await run({ file: "sh", args: ["-c", `command -v ${dependency}`] });
        if (!probe.ok) missing.push(dependency);
      }
      record("runner-readiness", missing.length === 0,
        missing.length === 0 ? `${dependencies.length} external commands resolve` : `missing: ${missing.join(", ")}`,
        { missing });
    }

    if (!stopVerification) {
      // ---- stage-npm-runtime: register FIRST so the recorded pid is the managed one.
      // The package name comes from this repository's own package.json; only the
      // semver-validated version is operator input.
      const staging: Record<string, unknown> = {};
      const packageName_ = readOwnPackageName(deps.readTextFile(join(import.meta.dir, "..", "..", "package.json")));
      if (!packageName_) {
        record("stage-npm-runtime", false, "could not read this repository's npm package name", staging);
      } else {
        const spec = npmPackageSpec(packageName_, options.fromVersion ?? options.toVersion);
        staging.npmPackage = spec;
        const install = await run({ file: "npm", args: ["install", "--prefix", npmPrefix, spec] });
        staging.npmInstallExit = install.exitCode;
        mock = deps.serveMockProvider();
        deps.writeTextFile(
          join(home, "config.json"),
          JSON.stringify(
            {
              port,
              defaultProvider: "gate-mock",
              providers: {
                "gate-mock": {
                  adapter: "openai-chat",
                  baseUrl: `http://127.0.0.1:${mock.port}/v1`,
                  apiKey: "gate-mock-key",
                },
              },
            },
            null,
            2,
          ) + "\n",
        );
        let ok = install.ok;
        if (ok) {
          const registered = await run(adapter.serviceInstall(launcher));
          staging.serviceInstallExit = registered.exitCode;
          ok = registered.ok;
          // A nonzero exit can still leave a registration behind; if anything is
          // registered now, this run owns removing it.
          acquired.service = (await adapter.registrationState()) === "present";
        }
        if (ok) ok = await waitFor(() => healthz().then(Boolean), 60_000);
        const before = await healthz();
        npmPid = before?.pid;
        const present = (await adapter.registrationState()) === "present";
        staging.npmRuntime = before;
        staging.registrationPresent = present;
        ok = ok && present && typeof npmPid === "number";
        record(
          "stage-npm-runtime",
          ok,
          ok ? `managed npm runtime pid ${npmPid} on port ${port}; registration present` : "staging failed; see evidence",
          staging,
        );
      }
    }

    const ownershipBefore = observeOwnership(deps.readJsonFile(join(home, "service-state.json")));

    if (!stopVerification) {
      // ---- install-artifact: the real artifact, installed like a user would.
      try {
        const installResult = await adapter.installArtifact(options.artifact, workDir, options.format);
        appBinary = installResult.appBinary;
        packageName = installResult.packageName;
        installScope = installResult.scope;
        acquired.artifact = true;
        record("install-artifact", Boolean(appBinary), `installed ${basename(options.artifact)} -> ${appBinary}`, installResult.evidence);
      } catch (error) {
        // A partial install is still an acquisition: mark it so cleanup rolls it back.
        acquired.artifact = true;
        record("install-artifact", false, String(error));
      }
    }

    if (!stopVerification && appBinary) {
      // ---- launch-and-take-over: consent once, drain the npm runtime, keep the registration.
      const launched = deps.spawnLogged(appBinary, join(workDir, "app.log"), join(workDir, "app.err.log"), isolatedEnv());
      spawned.push(launched);
      appPid = launched.pid;
      if (options.consentHook) await runHook(options.consentHook, () => null);
      const taken = await waitFor(async () => {
        const now = await healthz();
        return now !== null && typeof now.pid === "number" && now.pid !== npmPid;
      }, options.takeoverTimeoutMs);
      const after = await healthz();
      const npmDrained = !deps.pidAlive(npmPid);
      const registration = (await adapter.registrationState()) === "present";
      const ownershipAfter = observeOwnership(deps.readJsonFile(join(home, "service-state.json")));
      const ownership = evaluateOwnership(ownershipBefore, ownershipAfter);
      if (ownership.ok) {
        takeoverOwnerId = ownershipAfter.ownerInstallId;
        takeoverGeneration = ownershipAfter.consentGeneration;
        takeoverRuntimePid = after?.pid;
      }
      const ok = taken && npmDrained && registration && ownership.ok;
      record("launch-and-take-over", ok, [ownership.detail, `npm pid drained: ${npmDrained}`, `registration present: ${registration}`].join("; "), {
        before: ownershipBefore.raw,
        after: ownershipAfter.raw,
        healthzAfter: after,
      });
    }

    if (!stopVerification) {
      // ---- runtime-identity: healthz on the preserved home+port is the bundled sidecar,
      // a child of THIS launched app, reporting THIS release's version.
      const now = await healthz();
      const children = appPid !== undefined ? await listPids(adapter.childPids(appPid)) : [];
      const portRecord = deps.readJsonFile(join(home, "runtime-port.json")) as { port?: number; pid?: number } | undefined;
      const ok =
        now?.pid !== undefined &&
        children.includes(now.pid) &&
        portRecord?.port === port &&
        portRecord?.pid === now.pid &&
        now.version === options.toVersion;
      record("runtime-identity", ok, ok
        ? `healthz pid ${now?.pid} v${now?.version} is a child of app pid ${appPid} on preserved port ${port}`
        : "the answering runtime is not the bundled sidecar of the launched app on the preserved home",
        { healthz: now, appPid, sidecarCandidates: children, runtimePortRecord: portRecord });
    }

    const gesture = async (phase: string, spec: CommandSpec) => {
      if (stopVerification) return;
      const before = await healthz();
      const gestureResult = await run(spec);
      // The gesture must actually hide the window; a no-op command exit is not the
      // contract.
      const windowHidden = await waitFor(async () => !(await windowVisible()), 10_000);
      const after = await healthz();
      const runtimeAlive = before?.pid !== undefined && before.pid === after?.pid;
      const appAlive = deps.pidAlive(appPid);
      const reopen = await runHook(options.trayClickHook, () => adapter.trayClick());
      const visible = await waitFor(windowVisible, 15_000);
      const ok = gestureResult.ok && windowHidden && runtimeAlive && appAlive && reopen.ok && visible;
      record(phase, ok,
        `gesture exit ${gestureResult.exitCode}; window hidden: ${windowHidden}; runtime pid ${after?.pid} alive: ${runtimeAlive}; app pid ${appPid} alive: ${appAlive}; window reopened via ${reopen.via}: ${visible}`,
        { before, after });
    };

    await gesture("close-gesture", adapter.closeGesture());
    await gesture("quit-gesture", adapter.quitGesture());

    if (!stopVerification && appBinary) {
      // ---- relaunch-consent: a FULL quit (tray Quit drains and ends both pids), then a
      // cold relaunch must restore ownership WITHOUT asking again — the same install id,
      // the same consent generation. Watching a single-instance duplicate exit is not
      // this contract.
      const quit = await runHook(options.trayQuitHook, () => adapter.trayQuit());
      // Both pids — the app AND the runtime it owned at takeover — must actually end
      // before the relaunch means anything.
      const previousAppPid = appPid;
      const ended = await waitFor(async () =>
        !deps.pidAlive(previousAppPid)
        && !deps.pidAlive(takeoverRuntimePid)
        && (installScope === undefined || (await listPids(adapter.appProcessProbe(installScope))).length === 0),
      30_000);
      let ownershipRestored = false;
      let relaunchHealth: Healthz | null = null;
      if (ended) {
        const relaunched = deps.spawnLogged(appBinary, join(workDir, "relaunch.log"), join(workDir, "relaunch.err.log"), isolatedEnv());
        spawned.push(relaunched);
        appPid = relaunched.pid;
        const up = await waitFor(() => healthz().then(Boolean), 60_000);
        relaunchHealth = await healthz();
        const ownership = observeOwnership(deps.readJsonFile(join(home, "service-state.json")));
        ownershipRestored = up
          && ownership.ownerInstallId !== undefined
          && ownership.ownerInstallId === takeoverOwnerId;
        // A re-asked consent would move the generation; identical generation is the
        // proof that nothing was asked.
        ownershipRestored &&= ownership.consentGeneration !== undefined && ownership.consentGeneration === takeoverGeneration;
      }
      const ok = quit.ok && ended && ownershipRestored;
      record("relaunch-consent", ok, ok
        ? `full quit and cold relaunch restored owner ${takeoverOwnerId} without re-asking consent`
        : "ownership was not restored after a cold relaunch, or consent was asked again",
        { quitVia: quit.via, ended, ownerAfterRelaunch: relaunchHealth, takeoverOwnerId });
    }

    if (!stopVerification) {
      // ---- tray-quit-drains: the request must be verifiably in flight when Quit fires.
      const before = await healthz();
      const request = deps.fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer gate-mock-key" },
        body: JSON.stringify({ model: "gate-mock/gate-model", messages: [{ role: "user", content: "hold" }] }),
        timeoutMs: 90_000,
      }).then(response => response.status);
      const inFlight = await Promise.race([
        mock!.reached.then(() => true),
        deps.sleep(15_000).then(() => false),
      ]);
      const quit = await runHook(options.trayQuitHook, () => adapter.trayQuit());
      await deps.sleep(2000);
      mock?.release();
      let requestStatus: number | null = null;
      try {
        requestStatus = await request;
      } catch {
        requestStatus = null;
      }
      const drained = requestStatus === 200;
      const bothEnded = await waitFor(async () => !deps.pidAlive(before?.pid) && (installScope === undefined || (await listPids(adapter.appProcessProbe(installScope))).length === 0), 30_000);
      const ok = inFlight && quit.ok && drained && bothEnded;
      record("tray-quit-drains", ok,
        `request in flight at Quit: ${inFlight}; tray Quit driven via ${quit.via}; request finished with ${requestStatus}; both pids ended: ${bothEnded}`,
        { runtimePid: before?.pid, requestStatus });
    }

    if (!stopVerification && options.platform === "linux" && options.olderArtifact && options.fromVersion) {
      // ---- update-verify (R3): both Linux formats update through their own path, on
      // both authorization outcomes. A failed prerequisite stops the phase BEFORE the
      // next mutation, never after it.
      for (const spec of adapter.uninstall(options.artifact, workDir, options.format, packageName)) {
        await run(spec);
      }
      const older = await adapter.installArtifact(options.olderArtifact, workDir, options.format);
      packageName = older.packageName;
      installScope = older.scope;
      const oldApp = deps.spawnLogged(older.appBinary, join(workDir, "older-app.log"), join(workDir, "older-app.err.log"), isolatedEnv());
      spawned.push(oldApp);
      appPid = oldApp.pid;
      const oldHealthy = await waitFor(() => healthz().then(Boolean), 60_000);
      const preVersion = adapter.installedVersion(options.format, packageName);
      const preVersionOutput = preVersion ? await run(preVersion) : null;
      const preVersionText = preVersionOutput?.ok ? preVersionOutput.stdout.trim() : "";
      const preDigest = options.format === "appimage" ? deps.digestFile(older.appBinary) : null;
      const targetDigest = options.format === "appimage" ? deps.digestFile(options.artifact) : null;

      // One continuous monitor across the whole update operation: a fixed window can
      // close before download and signature verification reach the elevation step.
      // Sightings are attributed by the timestamp of each driver action.
      const sightings: Array<{ pid: number; at: number }> = [];
      const elevationProbe = adapter.elevationProbe();
      let monitoring = true;
      const monitorTask = (async () => {
        while (monitoring && elevationProbe) {
          for (const pid of await listPids(elevationProbe)) sightings.push({ pid, at: Date.now() });
          await deps.sleep(ELEVATION_POLL_MS);
        }
      })();
      const stopMonitor = async () => { monitoring = false; await monitorTask; };
      const sightingsAfter = (timestamp: number): number[] =>
        [...new Set(sightings.filter(sighting => sighting.at >= timestamp).map(sighting => sighting.pid))];

      try {
        let check = { ok: false, via: "skipped: old app never became healthy" };
        let install = { ok: false, via: "skipped: old app never became healthy" };
        let installStart = Number.POSITIVE_INFINITY;
        if (oldHealthy) {
          check = await runHook(options.trayCheckHook, () => adapter.trayCheck());
          installStart = Date.now();
          install = await runHook(options.trayInstallHook, () => adapter.trayInstall());
        }
        const elevationDuringCheck = [...new Set(
          sightings.filter(sighting => sighting.at < installStart).map(sighting => sighting.pid),
        )];

        if (options.format === "appimage") {
          // The installed file must become byte-identical to the target artifact — a
          // changed digest alone would pass for an update to the wrong version, and a
          // missing pre/target digest would make the transition vacuous.
          await waitFor(async () => deps.digestFile(older.appBinary) === targetDigest, 120_000);
          const postDigest = deps.digestFile(older.appBinary);
          const anyElevation = sightingsAfter(0);
          const ok = oldHealthy && check.ok && install.ok
            && elevationDuringCheck.length === 0 && anyElevation.length === 0
            && preDigest !== null && targetDigest !== null && preDigest !== targetDigest
            && postDigest !== null && postDigest === targetDigest;
          record("update-verify", ok,
            `AppImage updated in place to the exact target artifact (digest match: ${postDigest === targetDigest}); no elevation anywhere (${anyElevation.length} sighted); path kept`,
            { preDigest, postDigest, targetDigest, elevation: anyElevation });
        } else {
          // Cancel path: wait for the prompt, dismiss exactly the sighted pids, prove
          // they exited, then prove NO elevation mechanism retries (the pinned plugin
          // otherwise falls back pkexec -> zenity/kdialog -> sudo), and the version
          // never moved.
          const prompted = await waitFor(async () => sightingsAfter(installStart).length > 0, 90_000);
          const elevation = sightingsAfter(installStart);
          const cancel = adapter.cancelElevation(elevation);
          let cancelOk = elevation.length === 0;
          if (cancel && elevation.length > 0) {
            cancelOk = (await run(cancel)).ok;
            cancelOk &&= await waitFor(async () => elevation.every(pid => !deps.pidAlive(pid)), 10_000);
          }
          const cancelDoneAt = Date.now();
          await deps.sleep(10_000);
          const retriedElevation = sightingsAfter(cancelDoneAt);
          const settledVersion = adapter.installedVersion(options.format, packageName);
          const settledVersionOutput = settledVersion ? await run(settledVersion) : null;
          const settledVersionText = settledVersionOutput?.ok ? settledVersionOutput.stdout.trim() : "";
          const cancelPreserved = preVersionText !== "" && preVersionText === options.fromVersion && settledVersionText === preVersionText;
          const cancelOkAll = oldHealthy && check.ok && install.ok
            && elevationDuringCheck.length === 0 && prompted
            && cancelOk && retriedElevation.length === 0 && cancelPreserved;

          // Accept path: only after the cancel path held. Drive Install again, answer
          // through the operator hook, and require the package to reach the target.
          let acceptOk = false;
          let acceptEvidence: Record<string, unknown> = { skipped: "no --elevate-accept-hook" };
          if (options.elevateAcceptHook && cancelOkAll) {
            const acceptStart = Date.now();
            const installAgain = await runHook(options.trayInstallHook, () => adapter.trayInstall());
            const promptedAgain = await waitFor(async () => sightingsAfter(acceptStart).length > 0, 90_000);
            let hookOk = false;
            if (promptedAgain) {
              hookOk = (await runHook(options.elevateAcceptHook, () => null)).ok;
            }
            const accepted = await waitFor(async () => {
              const probe = adapter.installedVersion(options.format, packageName);
              if (!probe) return false;
              const result = await run(probe);
              return result.ok && result.stdout.trim() === options.toVersion;
            }, 120_000);
            acceptOk = installAgain.ok && promptedAgain && hookOk && accepted;
            acceptEvidence = { installAgain: installAgain.ok, promptedAgain, hookOk, accepted };
          } else if (options.elevateAcceptHook) {
            acceptEvidence = { skipped: "cancel path failed; accept not attempted" };
          }
          const ok = cancelOkAll && acceptOk;
          record("update-verify", ok,
            `deb cancel path preserved ${settledVersionText} with no elevation retry (${retriedElevation.length}); accept path reached ${options.toVersion}: ${acceptOk}`,
            { preVersion: preVersionText, postCancelVersion: settledVersionText, cancelOk, prompted, retriedElevation, accept: acceptEvidence });
        }
      } finally {
        await stopMonitor();
      }
    }
  } catch (error) {
    // A thrown exception is a fatal phase of its own: without this, a crash between
    // phases could leave a report whose recorded phases all pass.
    record("fatal-error", false, String(error));
  } finally {
    // ---- cleanup: rolls back ONLY what this invocation acquired. A preflight refusal
    // means nothing here runs against machine state: the gate must never destroy an
    // existing installation it detected. Every rollback step runs; a failure fails the
    // phase but never stops the remaining steps.
    const cleanupEvidence: Record<string, unknown> = {};
    let cleanupOk = true;
    const fail = (key: string, error: unknown) => {
      cleanupOk = false;
      cleanupEvidence[key] = String(error);
    };
    for (const child of spawned) {
      try { child.kill(); } catch (error) { fail(`spawned-${child.pid}`, error); }
    }
    // Processes the gate no longer owns: an AppImage update restarts detached from the
    // original spawn handle. Only swept when this run launched an app at all.
    if (appPid !== undefined && installScope !== undefined) {
      for (const pid of await listPids(adapter.appProcessProbe(installScope))) {
        try { deps.killProcess(pid); } catch (error) { fail(`app-${pid}`, error); }
      }
    }
    if (deps.pidAlive(npmPid)) {
      try { deps.killProcess(npmPid!); } catch (error) { fail("npm-runtime", error); }
    }
    if (acquired.service) {
      try {
        const result = await run(adapter.serviceUninstall(launcher));
        if (!result.ok) fail("service-uninstall", result.stderr.trim() || `exit ${result.exitCode}`);
      } catch (error) { fail("service-uninstall", error); }
    }
    if (acquired.artifact) {
      for (const spec of adapter.uninstall(options.artifact, workDir, options.format, packageName)) {
        try {
          const result = await run(spec);
          if (!result.ok) fail(`uninstall:${spec.args[1] ?? spec.file}`, result.stderr.trim() || `exit ${result.exitCode}`);
        } catch (error) { fail("uninstall", error); }
      }
    }
    mock?.stop();
    record("cleanup", cleanupOk, cleanupOk ? "everything the gate installed was rolled back" : "a rollback step failed; see evidence", cleanupEvidence);
    report.finishedAt = new Date().toISOString();
    // Green means every phase ran AND passed — a report missing phases (a crash, an
    // early refusal) is not green even if everything recorded passed.
    const expectedPhases = describeGatePhases(options);
    const covered = expectedPhases.every(name => report.phases.some(phase => phase.phase === name));
    report.ok = report.phases.every(phase => phase.status === "pass") && covered;
    deps.writeTextFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (import.meta.main) {
  const parsed = parseGateArguments(Bun.argv.slice(2));
  if (!parsed.options || parsed.error) {
    console.error(parsed.error ?? "invalid arguments");
    console.error(
      "usage: installed-gate.ts --platform <macos|windows|linux> --format <dmg|msi|deb|appimage> --artifact <path>" +
        " --older-artifact <path> --work-dir <dir> --to-version <version> --from-version <version> --report <path>" +
        " [--hooks-dir <dir>] [--consent-hook <name>] [--tray-click-hook <name>] [--tray-quit-hook <name>]" +
        " [--tray-check-hook <name>] [--tray-install-hook <name>] [--elevate-accept-hook <name>] [--takeover-timeout <seconds>]",
    );
    process.exit(2);
  }
  const report = await runGate(parsed.options);
  console.log(summarizeReport(report));
  process.exit(report.ok ? 0 : 1);
}
