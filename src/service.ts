/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { findLiveProxy, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort, verifyPidIdentity } from "./config";
import { loadConfig } from "./config";
import { restoreNativeCodex, restoreNativeCodexAsync } from "./codex/inject";
import { stripGrokConfig } from "./grok/inject";
import { isWslRuntime, resolveCodexHomeDir, type CodexHomeDeps } from "./codex/home";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime } from "./lib/bun-runtime";
import type { BunRuntimeSource } from "./lib/bun-runtime";
import { isProcessAlive, stopProxy } from "./lib/process-control";
import { serviceApiTokenFilePath } from "./lib/service-secrets";
import { PROXY_ENV_KEYS } from "./lib/proxy-env";
import { randomUUID } from "node:crypto";
import {
  ELEVATION_REQUEST_TIMEOUT_MS,
  OCX_ELEVATED_PROTOCOL_FAILED,
  raceWithTimeout,
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSchtasksExe,
  startElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  runWindowsElevatedScheduledTaskRegistration,
  toWindowsSchtasksError,
  WindowsElevationError,
  WindowsSchtasksError,
  type ElevatedSchedulerOutcome,
  type ElevatedSchtasksCreateAndRunExecution,
  type ElevatedSchtasksCreateAndRunResult,
} from "./lib/windows-elevation";
import { defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, winswXmlPath, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION, type WinswStatus } from "./lib/winsw";
import {
  forgetEphemeralSecretDir,
  forgetEphemeralSecretPath,
  hardenSecretDir,
  hardenSecretPath,
} from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { killWindowsSchedulerWrappers } from "./lib/windows-service-wrappers";
import { maybeShowStarPrompt } from "./cli/star-prompt";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

export type ServiceBackend = "scheduler" | "native";

function cliEntry(): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bake the bundled Bun (npm global prefix, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  //
  // Path and provenance come from ONE resolution so the marker can never describe a
  // different binary than the one actually baked.
  const runtime = durableBunRuntime();
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(import.meta.dir, "cli", "index.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "opencodex-service-launcher.vbs");
}

function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "opencodex-service-task.xml");
}

function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function defaultOpenCodexHome(): string {
  return resolve(join(homedir(), ".opencodex"));
}

function serviceStatePaths(): string[] {
  const paths = [serviceStatePath()];
  const defaultPath = join(defaultOpenCodexHome(), "service-state.json");
  if (normalizePathForCompare(defaultPath) !== normalizePathForCompare(paths[0])) paths.push(defaultPath);
  return paths;
}

function currentCodexHome(deps: CodexHomeDeps = {}): string {
  // Service ownership must identify the same home as the runtime. In WSL an
  // unset CODEX_HOME can resolve to the single Windows Desktop home rather than
  // Linux ~/.codex; recording the fallback here creates a false foreign owner.
  return resolveCodexHomeDir(deps);
}

function currentCodexSqliteHomeAbsolute(target: "native" | "windows" = "native"): string | undefined {
  const raw = process.env.CODEX_SQLITE_HOME?.trim();
  if (!raw) return undefined;
  const expanded = expandUserPath(raw);
  // Service artifacts can be rendered by cross-platform tests and repair tooling, so an
  // already-absolute path for the TARGET platform is preserved rather than re-anchored
  // against the writing host. `resolve()` is host-relative in both directions: on a POSIX
  // host it turns `C:\data` into `<cwd>/C:\data`, and on a Windows host it turns `/tmp/x`
  // into `D:\tmp\x` — neither is a path the target can use. A relative value still resolves,
  // because a service unit has no meaningful working directory.
  //
  // CODEX_HOME and OPENCODEX_HOME are carried through literally, so without this the same
  // generated file disagreed with itself about two variables holding the same kind of value.
  if (target === "windows") {
    return win32.isAbsolute(expanded) ? win32.normalize(expanded) : resolve(expanded);
  }
  return posix.isAbsolute(expanded) ? posix.normalize(expanded) : resolve(expanded);
}

function currentOpenCodexHome(): string {
  // getConfigDir() already resolves OPENCODEX_HOME with ~ expansion; keep the
  // install-state comparison on the same normalization or `~/...` values falsely
  // fail the environment-match check depending on cwd.
  return getConfigDir();
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface ServiceInstallState {
  version: 1 | 2;
  codexHome: string;
  opencodexHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string;
  /** v2: which Windows backend was chosen at install; absent (v1/legacy) means scheduler. */
  backend?: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 && state.version !== 2) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.opencodexHome !== "string" || state.opencodexHome.length === 0) return null;
  for (const key of ["bunPath", "cliPath", "winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  if (state.version === 1) {
    if (state.backend !== undefined) return null;
  } else if (state.backend !== "scheduler" && state.backend !== "native") {
    return null;
  }
  return state as unknown as ServiceInstallState;
}

function writeServiceInstallState(backend: ServiceBackend = "scheduler"): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 2,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
    bunPath: bun,
    cliPath: cli,
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
  };
  for (const path of serviceStatePaths()) {
    const dir = dirname(path);
    recordOwnedConfigPath(getConfigDir(), path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
  }
}

function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

/** What ONE state path said. Absent, unreadable and invalid are different answers. */
export type ServiceStateEvidence =
  | { readonly path: string; readonly kind: "absent" }
  | { readonly path: string; readonly kind: "unreadable"; readonly reason: string }
  | { readonly path: string; readonly kind: "invalid" }
  | { readonly path: string; readonly kind: "valid"; readonly state: ServiceInstallState };

/**
 * Every state path, with what each one said.
 *
 * `readServiceInstallState` returns the FIRST path that parsed and discards the
 * rest, so a valid mirror beside a corrupt one reads as clean. That is the right
 * behavior for callers that just need the install state; it is the wrong input
 * for deciding ownership, where a disagreement between mirrors is exactly the
 * evidence that matters.
 */
export function inspectServiceStateEvidence(
  paths: readonly string[] = serviceStatePaths(),
): readonly ServiceStateEvidence[] {
  return paths.map((path): ServiceStateEvidence => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      // ENOENT is an answer. EACCES, ENOTDIR and the rest are a failure to ask,
      // and collapsing them into absence is how a locked-down state file would
      // become permission to write.
      if (code === "ENOENT") return { path, kind: "absent" };
      return { path, kind: "unreadable", reason: code || String(error) };
    }
    let parsed: ServiceInstallState | null;
    try {
      parsed = parseServiceInstallState(JSON.parse(raw));
    } catch {
      return { path, kind: "invalid" };
    }
    return parsed ? { path, kind: "valid", state: parsed } : { path, kind: "invalid" };
  });
}

/** The homes this process is actually using, for comparison against a claim. */
export function currentServiceHomes(deps: CodexHomeDeps = {}): { codexHome: string; opencodexHome: string } {
  return { codexHome: currentCodexHome(deps), opencodexHome: currentOpenCodexHome() };
}

export function serviceHomeMatches(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** Single accessor for backend-sensitive service code — v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/**
 * The `ocx` argv that refreshes an already-installed service after an update.
 *
 * `repair` discovers the installed backend itself and, on Windows scheduler installs,
 * rewrites the wrapper assets and restarts the existing task WITHOUT `schtasks /create`
 * (see repairService below). `install` always reaches `/create`, which requires
 * elevation — so an ordinary non-elevated `ocx update` used to stop a working proxy and
 * then fail to bring its service back.
 *
 * The historical export name is kept for callers outside this module.
 */
export function serviceReinstallArgs(): string[] {
  return ["service", "repair"];
}

/** The `ocx` argv that registers a service from scratch, preserving the chosen backend. */
export function serviceInstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}

/**
 * The service was installed under a different CODEX_HOME/OPENCODEX_HOME, so this process may not
 * touch it. Distinct from "stop failed": the manager was never even contacted, which means the
 * installed service is still live and shared state (native Codex config, the Grok fence) must be
 * left alone — tearing it down would strip config out from under a running service.
 */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}

export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}

/**
 * True when no installed service exists, or the installed one belongs to THIS
 * CODEX_HOME/OPENCODEX_HOME. Callers use it to decide whether they may tear down shared state
 * (native Codex config, the Grok fence) that a foreign service would still be relying on.
 */
export function serviceEnvironmentOwnedHere(): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    return true;
  } catch (err) {
    if (isServiceOwnershipError(err)) return false;
    return true; // unrelated failure: fall back to the previous behavior rather than wedging
  }
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const actualCodexHome = currentCodexHome();
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(actualCodexHome);
  if (expected !== actual) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${actualCodexHome}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedOpenCodexHome = normalizePathForCompare(state.opencodexHome);
  const actualOpenCodexHome = normalizePathForCompare(currentOpenCodexHome());
  if (expectedOpenCodexHome !== actualOpenCodexHome) {
    throw new ServiceOwnershipError(
      `Service was installed with OPENCODEX_HOME=${state.opencodexHome}, but current OPENCODEX_HOME=${currentOpenCodexHome()}. ` +
        "Run the service command from the same OpenCodex home so service state and secrets match.",
    );
  }
}


function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

/**
 * The `ocx` command a user should rerun for the service state they actually have.
 *
 * `installed` alone is not enough: `repairService()` refuses a Task-Scheduler-plus-WinSW
 * conflict outright, so recommending repair there names a command guaranteed to fail.
 * Install IS the valid conflict recovery, because `installWindows` removes the native
 * backend first. Exported so the guard tests the real selector rather than a copy of it.
 */
export function serviceRetryCommand(
  diag: Pick<ServiceDiagnostic, "installed" | "conflict"> = diagnoseService(),
): string {
  return diag.installed && !diag.conflict ? "ocx service repair" : "ocx service install";
}

export function assertServiceAuthEnvironment(): void {
  const config = loadConfig();
  if (isLoopbackHostname(config.hostname)) return;
  if (process.env.OPENCODEX_API_AUTH_TOKEN?.trim()) return;
  // Reached from `service repair` as well as `install`, so name a command that can
  // actually succeed (see serviceRetryCommand).
  const diag = diagnoseService();
  const retry = serviceRetryCommand(diag);
  throw new Error(
    `OPENCODEX_API_AUTH_TOKEN is required before ${diag.installed ? "refreshing" : "installing"} a service `
      + `for non-loopback hostname. Set it in the same shell, then rerun \`${retry}\`.`,
  );
}

function writeServiceApiTokenFile(): string | null {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (!token) return null;
  const path = serviceApiTokenFilePath();
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  return path;
}

export function buildPlist(proxyEnv: { name: string; value: string }[] = resolvedProxyEnv()): string {
  const { bun, bunRuntimeSource, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const codexSqliteHome = currentCodexSqliteHomeAbsolute();
  const opencodexHome = process.env.OPENCODEX_HOME?.trim();
  const envLines = [
    `    <key>OCX_SERVICE</key><string>1</string>`,
    `    <key>${BUN_RUNTIME_SOURCE_ENV}</key><string>${bunRuntimeSource}</string>`,
    `    <key>${BUN_RUNTIME_PATH_ENV}</key><string>${plistString(bun)}</string>`,
    `    <key>PATH</key><string>${plistString(path)}</string>`,
    codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : null,
    codexSqliteHome ? `    <key>CODEX_SQLITE_HOME</key><string>${plistString(codexSqliteHome)}</string>` : null,
    opencodexHome ? `    <key>OPENCODEX_HOME</key><string>${plistString(opencodexHome)}</string>` : null,
    ...proxyEnv.map(({ name, value }) =>
      `    <key>${name}</key><string>${plistString(value)}</string>`),
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = buildServiceShellCommand(bun, cli);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${plistString(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Listen port baked into service wrappers / WinSW XML.
 * Priority: explicit override → OCX_BAKE_PORT (update restart) → config.port → 10100.
 * `config.port === 0` means ephemeral for interactive start; services need a stable pin,
 * so treat 0 / invalid like unset (default 10100) instead of baking `--port 0`.
 */
export function resolveServiceListenPort(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0 && override <= 65535) {
    return Math.trunc(override);
  }
  const baked = process.env.OCX_BAKE_PORT?.trim();
  if (baked && /^\d+$/.test(baked)) {
    const n = Number(baked);
    if (n > 0 && n <= 65535) return n;
  }
  const configured = loadConfig().port;
  if (typeof configured === "number" && configured > 0 && configured <= 65535) return configured;
  return 10100;
}

function buildServiceShellCommand(bun: string, cli: string, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${shellQuote(cli)} start --port ${port}`;
}

/**
 * The `--port <n>` actually baked into the installed launchd plist, or null when it
 * cannot be read. macOS only — named for launchd rather than "service" so no caller
 * assumes it covers systemd or the Windows wrapper.
 *
 * `start` needs this because it does NOT rewrite the plist: an install made under
 * OCX_BAKE_PORT, or any later config.port edit, would otherwise leave launchd serving
 * one port while the confirmation probes another, failing a healthy service.
 *
 * Anchored on the closing tag and matched LAST: the command also carries the Bun and
 * CLI paths, and a path containing the literal `start --port 9999` must not shadow
 * the real argument. buildPlist emits the command as the final ProgramArguments
 * string, and buildServiceShellCommand puts the port at the very end of it.
 */
export function launchdListenPort(deps: { readPlist?: () => string } = {}): number | null {
  try {
    const text = (deps.readPlist ?? (() => readFileSync(plistPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})\s*<\/string>/g)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/** The `--port <n>` baked into the installed systemd user unit. Linux only. */
export function systemdListenPort(deps: { readUnit?: () => string } = {}): number | null {
  try {
    const text = (deps.readUnit ?? (() => readFileSync(unitPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Shared tail parser for the baked `--port <n>`.
 *
 * Terminators cover all three artifact shapes: whitespace (batch wrapper, systemd
 * unit), `"` (systemd's quoted ExecStart), `<` (WinSW's `</arguments>`), and `&` (an
 * XML-escaped quote). Matched LAST because every artifact carries the Bun and CLI
 * paths ahead of the argument, and a path containing the literal must not shadow it.
 */
function parseBakedListenPort(read: () => string): number | null {
  try {
    const last = [...read().matchAll(/start --port (\d{1,5})(?:\s|"|&|<|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/** The `--port <n>` baked into the Task Scheduler wrapper. Windows scheduler backend. */
export function windowsListenPort(deps: { readScript?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readScript ?? (() => readFileSync(windowsServiceScriptPath(), "utf8")));
}

/**
 * The `--port <n>` baked into the WinSW XML's `<arguments>`. Windows native backend.
 *
 * Separate from {@link windowsListenPort} rather than one function branching on
 * `readServiceBackend()`: the recorded backend can disagree with what is actually on
 * disk (the `stale` / `backendStateMismatch` cases `deriveWindowsServiceDiagnostic`
 * exists to catch), and a reader that trusted it would then read the wrong file.
 * Each returns null when its own artifact is absent, so the chain needs no branch.
 */
export function winswListenPort(deps: { readXml?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readXml ?? (() => readFileSync(winswXmlPath(), "utf8")));
}

/**
 * The listen port of the INSTALLED service artifact, falling back to the configured
 * one. Each reader returns null off its own platform, so the chain needs no platform
 * branch — and on Windows both return null, preserving today's behavior.
 */
export function installedServiceListenPort(): number {
  return launchdListenPort()
    ?? systemdListenPort()
    ?? windowsListenPort()
    ?? winswListenPort()
    ?? resolveServiceListenPort();
}

export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * Whether a proxy actually answers on the port this install/start just produced.
 *
 * Registration is not service: `launchctl list` reports a job that never bound, and
 * `systemctl is-active` reports a process that bound nothing. Probing is the only
 * thing that answers the question the user is actually asking.
 *
 * Probes the BAKED target rather than resolving one. `findLiveProxy` resolves through
 * pidfile -> runtime-port -> config.port, and a service reinstall has just invalidated
 * the first two while `resolveServiceListenPort` (OCX_BAKE_PORT precedence, config.port
 * === 0 normalization) can disagree with the third.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark and
 * an actionable warning.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? installedServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? SERVICE_INSTALL_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
    if (now() >= deadline) return { ok: false, port };
    await sleep(500);
  }
}

/**
 * Print the outcome of `install` / `start` / `repair` in terms of what the user cares
 * about — is it serving? — instead of whether the manager accepted the registration.
 *
 * Sets `process.exitCode = 1` when nothing answers. That is deliberate: the GUI update
 * worker reads the child's exit status, so a registered-but-silent service now makes it
 * fall back to a direct proxy start rather than reporting a successful update over a
 * dead port.
 */
async function reportServiceServing(
  verb: "installed" | "started" | "repaired",
  deps: Parameters<typeof confirmServiceServing>[0] = {},
): Promise<void> {
  const serving = await confirmServiceServing(deps);
  if (serving.ok) {
    console.log(`✅ opencodex service ${verb} and serving on port ${serving.port}.`);
    return;
  }
  console.error(
    `⚠️  Service ${verb}, but no proxy answered on port ${serving.port} within `
    + `${Math.trunc(SERVICE_INSTALL_HEALTH_MS / 1000)}s.\n`
    + `   The manager registered the job; that is not the same as serving.\n`
    + `   Log:       ${serviceLogPath()}\n`
    + `   Meanwhile: ocx start   (serves in the foreground)`,
  );
  process.exitCode = 1;
}

/**
 * The command that repairs the CURRENTLY INSTALLED backend without re-registering it.
 *
 * `ocx service repair` reads the recorded backend itself, so it cannot silently switch a
 * WinSW install to Task Scheduler the way a plain `ocx service install` would, and on
 * Windows it needs no elevation because it never calls `schtasks /create`.
 */
function serviceRepairCommand(): string {
  return "ocx service repair";
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

/**
 * Outbound proxy settings the installing shell had, resolved for baking into a service
 * definition.
 *
 * A service manager does not inherit the environment of the shell that installed it, and
 * `ExecStart=/bin/sh -lc` is dash on Ubuntu/WSL — login dash reads `.profile`, not
 * `.bashrc`, which is where proxy exports usually live. So a user who needs a proxy to
 * reach the upstream got a service that dialed direct: the socket was reset, the retry
 * budget drained, and the request surfaced as `502 Provider unreachable` (#2107). The
 * same install driven through `ocx codex-shim` worked, because that path spawns with
 * `{ ...process.env }`.
 *
 * Lower-case variants are honored because curl-style tooling sets them and the runtime's
 * own `applyProxyEnv` already treats both cases as equivalent. Only the canonical
 * upper-case name is baked, so a definition never carries two spellings of one setting.
 */
export function resolvedProxyEnv(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
  const resolved: { name: string; value: string }[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
    if (value) resolved.push({ name: key, value });
  }
  return resolved;
}

function systemdOutputTarget(value: string): string {
  // StandardOutput/StandardError use output specifiers such as append:/path.
  // Quoting the full specifier makes systemd reject it as an invalid output target.
  return value.replace(/%/g, "%%").replace(/\n/g, "\\n");
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Run `launchctl` and report BOTH streams regardless of exit status.
 *
 * `launchctl load` writes "Load failed: <n>: <reason>" to stderr and exits 0 for
 * every already-bootstrapped job. `sh()` above is execSync, which throws only on a
 * non-zero exit, so install and start both reported success for a load that did
 * nothing — leaving launchd running the PREVIOUS plist while a freshly written one
 * sat unused on disk. That is the 2026-08-02 report: `ocx service` prints a
 * checkmark, `launchctl list` shows the job, and the port answers nothing.
 *
 * spawnSync, NOT execFileSync: execFileSync discards stderr when the child exits 0,
 * which is precisely this case — a runner built on it returns an empty stderr and
 * the guard below can never fire. Measured on macOS 27.0.
 */
export function runLaunchctl(
  args: string[],
  deps: { run?: typeof spawnSync } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const run = deps.run ?? spawnSync;
  const result = run("/bin/launchctl", args, { encoding: "utf8", windowsHide: true });
  // `error` is set when the spawn itself failed (ENOENT off macOS) and `status` is
  // null for a signalled child; neither may be reported as success.
  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error.message ?? ""), status: null };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    /*
     * The NUMBER, not just its zero-ness.
     *
     * `launchctl print` distinguishes "that domain does not exist" (112) from
     * "the domain answered and has no such service" (113), and an ownership
     * probe needs that difference: the second proves absence, the first only
     * proves we could not look. Collapsing both into `ok: false` forced callers
     * to parse stderr, which Apple does not treat as a stable interface.
     */
    status: result.status ?? null,
  };
}

/**
 * Whether launchctl output indicates the operation did not take. Needed because
 * `ok` alone is insufficient for the legacy `load`/`unload` subcommands, which
 * report failure on stderr while exiting 0. `bootstrap` exits 5, so for that path
 * this is belt-and-braces rather than the only signal.
 */
export function launchctlLoadFailed(stderr: string): boolean {
  return /\b(?:Load|Bootstrap) failed\b/i.test(stderr);
}

/** launchd domain target for the current user's GUI session. */
function launchdGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Whether launchd is running the job from the CURRENT plist. `launchctl list` only
 * proves domain membership — a job bootstrapped from an older plist stays listed
 * forever. `launchctl print` exposes the live `arguments`, which is the only way to
 * catch a load that silently no-op'd.
 */
export function launchdJobMatchesPlist(
  expectedCommand: string,
  deps: { run?: typeof runLaunchctl } = {},
): { loaded: boolean; matchesPlist: boolean } {
  const run = deps.run ?? runLaunchctl;
  const printed = run(["print", `${launchdGuiDomain()}/${LABEL}`]);
  if (!printed.ok) return { loaded: false, matchesPlist: false };
  // `print` writes the arguments block to stdout for a live job. Search both streams
  // anyway so a future launchctl that moves diagnostics between them cannot turn this
  // into a false negative — a false "stale" verdict would send users to `bootout` for
  // nothing.
  const printedText = `${printed.stdout}\n${printed.stderr}`;
  return { loaded: true, matchesPlist: printedText.includes(expectedCommand) };
}

/**
 * Decode schtasks stdout. `/query /xml` emits UTF-16LE (often with BOM) because the
 * registered task document is UTF-16; reading that as UTF-8 makes every health check
 * fail ("registration present but unhealthy") and rolls back a successful elevated create.
 */
export function decodeSchtasksOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const bomUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomUtf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const looksUtf16Le = buffer.length >= 4
    && buffer[1] === 0x00
    && buffer[3] === 0x00
    && buffer[0] !== 0x00;
  if (bomUtf16Le || looksUtf16Le) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "").trim();
  }
  if (bomUtf16Be) {
    // Swap pairs then decode as utf16le.
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1]!;
      swapped[i - 1] = buffer[i]!;
    }
    return swapped.toString("utf16le").trim();
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
}

function runFile(file: string, args: string[]): string {
  const buffer = execFileSync(file, args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as Buffer;
  return decodeSchtasksOutput(buffer);
}

function windowsSchtasks(): string {
  return resolveTrustedWindowsSchtasksExe();
}

function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}

let querySchtasksForTests: ((args: string[]) => string) | null = null;

function querySchtasks(args: string[]): string {
  if (querySchtasksForTests) return querySchtasksForTests(args);
  return runFile(windowsSchtasks(), args);
}

/** Test-only seam for Task Scheduler query used by presence probes. */
export function setQuerySchtasksForTests(next: ((args: string[]) => string) | null): void {
  querySchtasksForTests = next;
}

function schtasks(args: string[]): string {
  try {
    return querySchtasks(args);
  } catch (error) {
    throw toWindowsSchtasksError(error, args);
  }
}

/** Tri-state Task Scheduler presence: never treat a failed query as proven absence. */
export type WindowsSchedulerTaskProbe =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

export type WindowsSchedulerProxyProbe =
  | { status: "running"; port: number }
  | { status: "not-running" }
  | { status: "unknown" };

/**
 * Render Task Scheduler status without exposing localized `schtasks` table output.
 * The task probe answers installation state; the identity-checked health probe answers
 * runtime state. Keep probe details out of this user-facing line because they can contain
 * incorrectly decoded, locale-specific command output.
 */
export function formatWindowsSchedulerServiceStatus(
  task: WindowsSchedulerTaskProbe,
  proxy: WindowsSchedulerProxyProbe,
): string {
  if (task.status === "present") {
    if (proxy.status === "running") {
      return `✅ service installed (Task Scheduler); OpenCodex proxy running on port ${proxy.port}.`;
    }
    if (proxy.status === "not-running") {
      return "⚠️  service installed (Task Scheduler); OpenCodex proxy not running.";
    }
    return "⚠️  service installed (Task Scheduler); OpenCodex proxy status unknown.";
  }
  if (task.status === "absent") {
    if (proxy.status === "running") {
      return `❌ service not installed (Task Scheduler); OpenCodex proxy is running independently on port ${proxy.port}.`;
    }
    if (proxy.status === "unknown") {
      return "❌ service not installed (Task Scheduler); OpenCodex proxy status unknown.";
    }
    return "❌ service not installed (Task Scheduler).";
  }
  if (proxy.status === "running") {
    return `⚠️  Task Scheduler registration unknown; OpenCodex proxy running on port ${proxy.port}.`;
  }
  if (proxy.status === "not-running") {
    return "⚠️  service status unknown (Task Scheduler query failed); OpenCodex proxy not running.";
  }
  return "⚠️  service status unknown (Task Scheduler and proxy checks failed).";
}

export async function inspectWindowsSchedulerServiceStatus(io: {
  probeTask?: () => WindowsSchedulerTaskProbe;
  findProxy?: () => Promise<{ port: number } | null>;
} = {}): Promise<string> {
  let task: WindowsSchedulerTaskProbe;
  try {
    task = (io.probeTask ?? probeWindowsSchedulerTask)();
  } catch (error) {
    task = { status: "unknown", detail: schtasksErrorDetail(error) };
  }

  let proxy: WindowsSchedulerProxyProbe;
  try {
    const live = await (io.findProxy ?? findLiveProxy)();
    proxy = live ? { status: "running", port: live.port } : { status: "not-running" };
  } catch {
    proxy = { status: "unknown" };
  }

  return formatWindowsSchedulerServiceStatus(task, proxy);
}

function schtasksErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a schtasks CSV listing line refers to the given task name. */
export function windowsSchedulerCsvIncludesTask(csv: string, taskName: string): boolean {
  const needle = taskName.toLowerCase();
  for (const line of csv.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes(needle)) continue;
    // Prefer exact CSV field matches ("\TaskName" / "TaskName") before a substring hit.
    if (
      lower.includes(`"\\${needle}"`)
      || lower.includes(`"${needle}"`)
      || new RegExp(`(^|[,\\\\])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,"]|$)`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Probe whether the OpenCodex Task Scheduler task exists.
 * Query failures fall back to a CSV listing before concluding absence; if both
 * fail, returns `unknown` so callers can fail closed instead of releasing locks.
 */
export function probeWindowsSchedulerTask(taskName = TASK): WindowsSchedulerTaskProbe {
  if (process.platform !== "win32") return { status: "absent" };

  let queryFailure: string | null = null;
  try {
    const out = querySchtasks(["/query", "/tn", taskName]);
    if (out.includes(taskName)) return { status: "present" };
  } catch (error) {
    queryFailure = schtasksErrorDetail(error);
  }

  try {
    const csv = querySchtasks(["/query", "/fo", "CSV"]);
    if (windowsSchedulerCsvIncludesTask(csv, taskName)) return { status: "present" };
    return { status: "absent" };
  } catch (error) {
    const listDetail = schtasksErrorDetail(error);
    const detail = queryFailure
      ? `Specific query failed (${queryFailure}); CSV listing also failed (${listDetail}).`
      : `Task query did not confirm presence and CSV listing failed (${listDetail}).`;
    return { status: "unknown", detail };
  }
}

/** True when the Task Scheduler registration for the default proxy task is proven present. */
export function windowsSchedulerTaskInstalled(taskName = TASK): boolean {
  return probeWindowsSchedulerTask(taskName).status === "present";
}

export interface WindowsSchedulerInstallVerification {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  /** Well-formed XML that is PUBLISHED but policy-violating — permanent, never
   * worth a settle retry (vs an empty/unreadable view, which is publication
   * lag and transient). */
  registrationInvalid: boolean;
  assetsHealthy: boolean;
  nativeServiceAbsent: boolean;
  /** True when SCM probe failed; not a proven WinSW presence. */
  nativeStatusUnknown: boolean;
  conflict: boolean;
  ok: boolean;
  detail: string;
}

/** Pure postcondition evaluation for an elevated scheduler install. */
export function evaluateWindowsSchedulerInstallVerification(inputs: {
  taskInstalled: boolean;
  xml: string;
  assetsExist: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  wscript?: string;
  launcher?: string;
}): WindowsSchedulerInstallVerification {
  const registrationHealthy = inputs.xml.length > 0
    && windowsTaskRegistrationHealthy(inputs.xml, inputs.wscript, inputs.launcher);
  // Permanent invalidity: the XML IS published but violates the registration
  // contract — no amount of settling changes it. Empty/unreadable XML stays
  // transient (publication lag).
  const registrationInvalid = inputs.taskInstalled && inputs.xml.length > 0 && !registrationHealthy;
  const assetsHealthy = inputs.assetsExist;
  const nativeServiceAbsent = inputs.nativeStatus === "nonexistent";
  const nativeStatusUnknown = inputs.nativeStatus === "unknown";
  // Only treat proven WinSW presence as a backend conflict — never "unknown".
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const ok = inputs.taskInstalled && registrationHealthy && assetsHealthy && nativeServiceAbsent && !conflict;
  const detail = !inputs.taskInstalled
    ? "Task Scheduler task is not installed."
    : conflict
      ? `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`
      : !assetsHealthy
        ? "Required scheduler service assets are missing."
        : !registrationHealthy
          ? (inputs.xml.trim()
            ? "Task Scheduler registration is present but unhealthy."
            : "Task Scheduler task is present but its XML could not be read.")
          : nativeStatusUnknown
            ? "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent."
            : "ok";
  return {
    taskInstalled: inputs.taskInstalled,
    registrationHealthy,
    registrationInvalid,
    assetsHealthy,
    nativeServiceAbsent,
    nativeStatusUnknown,
    conflict,
    ok,
    detail,
  };
}

/** Conflict-free postcondition check for an elevated scheduler install. */
export function verifyWindowsSchedulerInstall(taskName = TASK): WindowsSchedulerInstallVerification {
  const taskInstalled = windowsSchedulerTaskInstalled(taskName);
  let xml = "";
  if (taskInstalled) {
    try { xml = querySchtasks(["/query", "/tn", taskName, "/xml"]); } catch { xml = ""; }
  }
  // After elevated create, non-elevated `/query /xml` can fail or return empty while the
  // task is still listed. Fall back to the on-disk document we registered.
  if (taskInstalled && !xml.trim()) {
    const diskPath = windowsTaskXmlPath();
    if (existsSync(diskPath)) {
      try { xml = decodeSchtasksOutput(readFileSync(diskPath)); } catch { /* keep empty */ }
    }
  }
  return evaluateWindowsSchedulerInstallVerification({
    taskInstalled,
    xml,
    assetsExist: [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()].every(existsSync),
    nativeStatus: statusWinswRaw(),
  });
}

async function elevateSchtasks(args: string[]): Promise<void> {
  const exitCode = await runWindowsElevated(windowsSchtasks(), args);
  if (exitCode !== 0) {
    throw new Error(`Background service install failed with exit code ${exitCode}.`);
  }
}

export interface WindowsSchedulerRollbackDeps {
  queryXml?: () => string;
  deleteTask?: () => Promise<void>;
  probe?: () => WindowsSchedulerTaskProbe;
}

export async function rollbackWindowsSchedulerTaskOwnedByAttempt(
  attemptNonce: string,
  taskName = TASK,
  deps: WindowsSchedulerRollbackDeps = {},
): Promise<string | null> {
  let registeredXml = "";
  try {
    registeredXml = (deps.queryXml ?? (() => querySchtasks(["/query", "/tn", taskName, "/xml"])))();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Task Scheduler task ${taskName} ownership could not be proven: ${detail}. Residual scheduler state: task ${taskName} presence is unknown; no rollback deletion was attempted.`;
  }
  if (!registeredXml.trim()) {
    return `Task Scheduler task ${taskName} ownership could not be proven because its live XML was empty. Residual scheduler state: task ${taskName} presence is unknown; no rollback deletion was attempted.`;
  }
  if (!windowsTaskRegistrationOwnedByAttempt(registeredXml, attemptNonce)) {
    return `Task Scheduler task ${taskName} ownership could not be proven because its attempt nonce does not match. Residual scheduler state: task ${taskName} remains registered; no rollback deletion was attempted.`;
  }

  try {
    await (deps.deleteTask ?? (() => elevateSchtasks(["/delete", "/tn", taskName, "/f"])))();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Rollback deletion failed: ${detail}. Residual scheduler state: task ${taskName} may remain registered.`;
  }
  const probe = (deps.probe ?? (() => resolveWindowsSchedulerTaskProbe(taskName)))();
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}. Residual scheduler state: task presence is unknown.`;
  }
  return `Residual scheduler state: task ${taskName} is still present after rollback.`;
}

// Legacy dashboard finalization creates and runs in one elevated child, whose protocol
// performs its own rollback before returning. This fallback remains for indeterminate
// protocol outcomes that predate the staged CLI transaction.
async function rollbackElevatedSchedulerTask(taskName = TASK): Promise<string | null> {
  try {
    await elevateSchtasks(["/delete", "/tn", taskName, "/f"]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const probe = resolveWindowsSchedulerTaskProbe(taskName);
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}`;
  }
  return `Task Scheduler task ${taskName} is still present after rollback.`;
}

type ElevateCreateAndRunStart = (
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
) => ElevatedSchtasksCreateAndRunExecution;

type FinalizeHooks = {
  startElevateCreateAndRun?: ElevateCreateAndRunStart;
  /** Legacy sync hook used by older tests — wraps a resolved result as an execution. */
  elevateCreateAndRun?: (
    schtasksPath: string,
    createArgs: string[],
    runArgs: string[],
    deleteArgs: string[],
  ) => Promise<ElevatedSchtasksCreateAndRunResult>;
  verify?: () => WindowsSchedulerInstallVerification;
  writeInstallState?: () => void;
  /** Preferred tri-state probe for security-sensitive reconciliation. */
  probeTask?: () => WindowsSchedulerTaskProbe;
  /** Legacy boolean hook; mapped to present/absent when probeTask is unset. */
  taskInstalled?: () => boolean;
  /** Defense-in-depth: late reconciliation must still own this attempt. */
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
  /** Test-only seam for the post-create settle backoff; real installs use a timer. */
  settleDelay?: (ms: number) => Promise<void>;
};

let finalizeHooks: FinalizeHooks | null = null;

function resolveWindowsSchedulerTaskProbe(taskName = TASK): WindowsSchedulerTaskProbe {
  if (finalizeHooks?.probeTask) return finalizeHooks.probeTask();
  if (finalizeHooks?.taskInstalled) {
    return finalizeHooks.taskInstalled() ? { status: "present" } : { status: "absent" };
  }
  return probeWindowsSchedulerTask(taskName);
}

/** Test-only hooks for elevated create+run finalization. */
export function setFinalizeWindowsSchedulerHooksForTests(hooks: FinalizeHooks | null): void {
  finalizeHooks = hooks;
}

function throwPartialInstall(parts: string[]): never {
  throw new Error(parts.filter(Boolean).join(" "));
}

/**
 * Reconcile an unrecognized elevated exit when we cannot trust the phase code.
 * Never invent a create-vs-run classification; inspect actual task state first.
 * An unverifiable probe must fail closed (partial / blocked), never release.
 */
async function reconcileUnknownElevatedOutcome(exitCode: number): Promise<void> {
  const probe = resolveWindowsSchedulerTaskProbe();
  const parts = [
    "The elevated Task Scheduler operation returned an unknown result.",
    `Exit code: ${exitCode}.`,
    "OpenCodex could not prove whether task creation completed, so installation state was not written.",
  ];
  if (probe.status === "unknown") {
    parts.push(`Task Scheduler presence could not be verified: ${probe.detail}`);
    parts.push("A partial Task Scheduler backend may remain.");
    throwPartialInstall(parts);
  }
  if (probe.status === "absent") {
    parts.push("No OpenCodex Task Scheduler task was found after the elevated operation.");
    throwPartialInstall(parts);
  }
  parts.push("A Task Scheduler task is present; attempting cleanup.");
  const rollbackError = await rollbackElevatedSchedulerTask();
  if (rollbackError) {
    parts.push(`Cleanup also failed: ${rollbackError}`);
    parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if it remains.`);
  } else {
    parts.push("The elevated Task Scheduler task was removed.");
  }
  throwPartialInstall(parts);
}

type ApplyElevatedOptions = {
  attemptId: string;
  writeOnSuccess: boolean;
  stillOwnsAttempt?: (attemptId: string) => boolean;
};

function attemptStillOwned(options: ApplyElevatedOptions): boolean {
  const check = options.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  return !check || check(options.attemptId);
}

/**
 * Bounded post-create backoff, 1.1s total. Task Scheduler's non-elevated view can
 * lag an elevated `/create` by a few hundred milliseconds, so a single verification
 * would roll back a task that is merely not visible yet.
 */
const SCHEDULER_SETTLE_DELAYS_MS = [50, 150, 300, 600] as const;

/**
 * Whether a failed verification is still worth re-checking after a short delay.
 *
 * Retrying is confined to states that a lagging scheduler view actually produces:
 * the task is not visible yet, or it is visible but its registration has not been
 * published in full. Everything else keeps its existing fail-closed meaning and is
 * rejected here so no delay can turn it into a pass:
 *
 * - a proven conflict (both backends present) is a real dual-backend install;
 * - missing assets are missing on disk, which no amount of waiting creates;
 * - a WinSW service that is proven present (`started`/`stopped`) is never absent
 *   later. This is checked independently of `conflict`, which only becomes true
 *   once the task itself is visible — while the task is still invisible the pair
 *   is `conflict: false` with `nativeServiceAbsent: false`, and that must not retry;
 * - unknown SCM status is unproven rather than transient, and has its own
 *   task-preserving branch below.
 */
/** Exported for tests: the transient-vs-permanent settle decision. */
export function schedulerVerificationMaySettle(v: WindowsSchedulerInstallVerification): boolean {
  if (v.ok) return false;
  if (v.conflict) return false;
  if (!v.assetsHealthy) return false;
  if (!v.nativeServiceAbsent) return false;
  // A published-but-invalid registration is permanent: no delay repairs it.
  if (v.registrationInvalid) return false;
  return !v.taskInstalled || !v.registrationHealthy;
}

function settleDelay(ms: number): Promise<void> {
  const hook = finalizeHooks?.settleDelay;
  if (hook) return hook(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verify the elevated install, re-checking only while the failure looks like a
 * scheduler view that has not caught up yet. Returns `null` when this attempt lost
 * ownership mid-settle: a newer attempt owns the task, so this one must neither
 * write install state nor roll anything back.
 */
async function verifyWindowsSchedulerInstallAfterSettle(
  options: ApplyElevatedOptions,
): Promise<WindowsSchedulerInstallVerification | null> {
  const verify = finalizeHooks?.verify ?? verifyWindowsSchedulerInstall;
  let verification = verify();
  for (const delayMs of SCHEDULER_SETTLE_DELAYS_MS) {
    if (!schedulerVerificationMaySettle(verification)) break;
    if (!attemptStillOwned(options)) return null;
    await settleDelay(delayMs);
    if (!attemptStillOwned(options)) return null;
    verification = verify();
  }
  return verification;
}

async function applyElevatedSchedulerResult(
  result: ElevatedSchtasksCreateAndRunResult,
  options: ApplyElevatedOptions,
): Promise<void> {
  if (!attemptStillOwned(options)) {
    return;
  }
  const outcome: ElevatedSchedulerOutcome = result.outcome;

  if (outcome === "create-failed") {
    throw new Error("Elevated schtasks /create failed. The Task Scheduler task was not registered.");
  }
  if (outcome === "run-failed-rolled-back") {
    throw new Error(
      "Elevated schtasks /run failed after the task was registered. The elevated process rolled the task back. Installation state was not written.",
    );
  }
  if (outcome === "run-failed-rollback-failed") {
    throwPartialInstall([
      "Elevated schtasks /run failed after the task was registered, and elevated rollback also failed.",
      "A partial Task Scheduler backend may remain.",
      `Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if present.`,
      "Installation state was not written.",
    ]);
  }
  if (outcome !== "success") {
    await reconcileUnknownElevatedOutcome(result.exitCode);
  }

  const verification = await verifyWindowsSchedulerInstallAfterSettle(options);
  // Ownership moved to a newer attempt while settling; that attempt owns the outcome.
  if (!verification) return;
  if (!verification.ok) {
    // Preserve a healthy elevated task when WinSW absence cannot be proven (unknown SCM status).
    // Unknown is not a confirmed dual-backend conflict; install state is still withheld.
    const preserveElevatedTask = verification.taskInstalled
      && verification.registrationHealthy
      && verification.assetsHealthy
      && !verification.conflict
      && verification.nativeStatusUnknown;
    if (preserveElevatedTask) {
      throwPartialInstall([
        "Elevated Task Scheduler registration did not produce a conflict-free install.",
        verification.detail,
        "The elevated Task Scheduler task was left in place because native WinSW status could not be verified.",
        "Installation state was not written.",
      ]);
    }
    // Rollback deletes a real task, so it needs the same ownership fence as the
    // state write below: a stale attempt must never delete a newer attempt's task.
    if (!attemptStillOwned(options)) return;
    const rollbackError = await rollbackElevatedSchedulerTask();
    const parts = [
      "Elevated Task Scheduler registration did not produce a conflict-free install.",
      verification.detail,
    ];
    if (rollbackError) {
      parts.push(`Rollback also failed: ${rollbackError}`);
      parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' and the native service with 'sc delete ${WINSW_SERVICE_ID}' if present.`);
    } else {
      parts.push("The elevated Task Scheduler task was rolled back.");
    }
    parts.push("Installation state was not written.");
    throwPartialInstall(parts);
  }
  if (options.writeOnSuccess) {
    if (!attemptStillOwned(options)) {
      return;
    }
    (finalizeHooks?.writeInstallState ?? (() => writeServiceInstallState("scheduler")))();
  }
}

/** Outcome of late reconciliation after a request-level elevation timeout. */
export type ElevatedReconciliationOutcome =
  | "released"
  | "blocked-partial";

export type FinalizeWindowsSchedulerResult =
  | { kind: "done" }
  | {
      kind: "indeterminate";
      attemptId: string;
      /** Settles after the elevated transaction finishes and late reconciliation runs. */
      reconciliation: Promise<ElevatedReconciliationOutcome>;
    };

export type FinalizeWindowsSchedulerOptions = {
  attemptId?: string;
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
};

function startElevateExecution(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): ElevatedSchtasksCreateAndRunExecution {
  if (finalizeHooks?.startElevateCreateAndRun) {
    return finalizeHooks.startElevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
  }
  if (finalizeHooks?.elevateCreateAndRun) {
    const completion = finalizeHooks.elevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
    return { completion, launcherPid: null };
  }
  return startElevatedSchtasksCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
}

function isPartialInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /partial Task Scheduler/i.test(error.message)
    || /Cleanup also failed/i.test(error.message)
    || /left in place because native WinSW status could not be verified/i.test(error.message)
    || /Task Scheduler presence could not be verified/i.test(error.message);
}

/**
 * Re-register the scheduler task with elevation after a non-elevated install wrote assets.
 *
 * Request timeout does not kill the elevated launcher. On timeout this returns
 * `indeterminate` and keeps reconciling the eventual protocol result.
 */
export async function finalizeWindowsSchedulerServiceRegistration(
  script = windowsServiceScriptPath(),
  options?: FinalizeWindowsSchedulerOptions,
): Promise<FinalizeWindowsSchedulerResult> {
  if (process.platform !== "win32") {
    throw new Error("Windows scheduler registration is only supported on Windows.");
  }
  const attemptId = options?.attemptId ?? randomUUID();
  const stillOwnsAttempt = options?.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  const createArgs = buildWindowsSchtasksCreateArgs(script);
  const runArgs = ["/run", "/tn", TASK];
  const deleteArgs = ["/delete", "/tn", TASK, "/f"];
  const started = startElevateExecution(windowsSchtasks(), createArgs, runArgs, deleteArgs);
  const timeoutMs = options?.requestTimeoutMs
    ?? finalizeHooks?.requestTimeoutMs
    ?? ELEVATION_REQUEST_TIMEOUT_MS;
  const applyOpts: ApplyElevatedOptions = { attemptId, writeOnSuccess: true, stillOwnsAttempt };

  let raced: { status: "completed"; value: ElevatedSchtasksCreateAndRunResult } | { status: "timed-out" };
  try {
    raced = await raceWithTimeout(started.completion, timeoutMs);
  } catch (error) {
    // Cancellation / launch failure / signal before or instead of a protocol result.
    // Signal after Start-Process may leave an elevated child; reconcile conservatively.
    if (error instanceof WindowsElevationError && error.reason === "terminated") {
      try {
        await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
      } catch (reconcileError) {
        // Prefer the reconciliation detail (partial install / cleanup guidance) over the
        // generic signal message so callers can block retries when a task remains.
        throw reconcileError;
      }
    }
    throw error;
  }

  if (raced.status === "completed") {
    await applyElevatedSchedulerResult(raced.value, applyOpts);
    return { kind: "done" };
  }

  const reconciliation = (async (): Promise<ElevatedReconciliationOutcome> => {
    try {
      const result = await started.completion;
      await applyElevatedSchedulerResult(result, applyOpts);
      return "released";
    } catch (error) {
      if (error instanceof WindowsElevationError && error.reason === "cancelled") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "launch-failed") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "terminated") {
        try {
          await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
          return "released";
        } catch (reconcileError) {
          return isPartialInstallError(reconcileError) ? "blocked-partial" : "released";
        }
      }
      // applyElevatedSchedulerResult failures are expected (create/run/conflict); swallow for background.
      if (isPartialInstallError(error)) {
        return "blocked-partial";
      }
      return "released";
    }
  })();

  return { kind: "indeterminate", attemptId, reconciliation };
}

/**
 * Pure post-restart / pre-install advisory check. Does not mutate state.
 * A process-local indeterminate lock cannot survive restart — callers must inspect reality.
 */
export function evaluateSchedulerInstallRestartReconciliation(inputs: {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  assetsHealthy: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  installStateBackend: "scheduler" | "native" | null;
}): {
  status: "healthy" | "orphan-task" | "stale-install-state" | "conflict" | "unhealthy" | "unverified";
  detail: string;
} {
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  if (conflict) {
    return {
      status: "conflict",
      detail: `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`,
    };
  }
  if (inputs.taskInstalled && inputs.nativeStatus === "unknown") {
    return {
      status: "unverified",
      detail: "The Task Scheduler task exists, but native WinSW status could not be verified.",
    };
  }
  if (inputs.taskInstalled && (!inputs.registrationHealthy || !inputs.assetsHealthy)) {
    return {
      status: "unhealthy",
      detail: !inputs.assetsHealthy
        ? "Required scheduler service assets are missing."
        : "Task Scheduler registration is present but unhealthy.",
    };
  }
  if (inputs.taskInstalled && inputs.installStateBackend !== "scheduler") {
    return {
      status: "orphan-task",
      detail: "A Task Scheduler task is present without matching scheduler install state.",
    };
  }
  if (!inputs.taskInstalled && inputs.installStateBackend === "scheduler") {
    return {
      status: "stale-install-state",
      detail: "Scheduler install state is present but the Task Scheduler task is absent.",
    };
  }
  return { status: "healthy", detail: "ok" };
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

type WindowsBatchValueKind = "raw" | "path" | "pathList";

function windowsBatchSet(name: string, value: string | undefined, kind: WindowsBatchValueKind = "raw"): string | null {
  if (!value) return null;
  const rendered =
    kind === "path" ? windowsEnvIndirectBatchValue(value, windowsBatchValue)
    : kind === "pathList" ? windowsEnvIndirectBatchPathList(value, windowsBatchValue)
    : windowsBatchValue(value);
  return `set "${name}=${rendered}"`;
}

function taskXmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * RunLevel check. Schema default is LeastPrivilege (omitted on export). Elevated
 * `schtasks /create` often rewrites the registered task to HighestAvailable even when
 * the source XML asked for LeastPrivilege — still InteractiveToken / same user.
 * Keep accepting HighestAvailable here: rejecting it would false-fail healthy elevated
 * installs, and windowsTaskRegistrationHealthy tests encode that contract.
 */
function taskXmlRunLevelAcceptable(principal: string): boolean {
  if (taskXmlHasPrefixedTag(principal, "RunLevel")) return false;
  const count = taskXmlElementCount(principal, "RunLevel");
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<RunLevel(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/RunLevel>`, "i").exec(principal)?.[1]?.trim().toLowerCase();
  return value === "leastprivilege" || value === "highestavailable";
}

export function buildWindowsServiceScript(
  entry = cliEntry(),
  port = resolveServiceListenPort(),
  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
): string {
  // Provenance rides along with the entry: a second durableBunRuntime() call here could
  // resolve differently from the binary the caller actually baked.
  const { bun, bunRuntimeSource, cli } = entry;
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    // The wrapper console is hidden by the wscript launcher (window style 0), so switching
    // it to UTF-8 is safe (no leak into user shells) and lets cmd parse UTF-8 remnants.
    "chcp 65001 >nul",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
    windowsBatchSet(BUN_RUNTIME_PATH_ENV, bun, "path"),
    windowsBatchSet("PATH", path, "pathList"),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim(), "path"),
    windowsBatchSet("CODEX_SQLITE_HOME", currentCodexSqliteHomeAbsolute("windows"), "path"),
    windowsBatchSet("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim(), "path"),
    ...proxyEnv.map(({ name, value }) => windowsBatchSet(name, value)),
    windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath(), "path"),
    windowsBatchSet("OCX_SERVICE_LOG", serviceLogPath(), "path"),
    windowsBatchSet("OCX_BUN", bun, "path"),
    windowsBatchSet("OCX_CLI", cli, "path"),
    // Package root for the transactional-update restore path (#1942): cli is
    // <pkg>\src\cli\index.ts, so the package dir is three levels up.
    'for %%I in ("%OCX_CLI%\\..\\..\\..") do set "OCX_PKG_DIR=%%~fI"',
    'if exist "%OCX_API_TOKEN_FILE%" (',
    '  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start',
    '>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"',
    `>>"%OCX_SERVICE_LOG%" echo bun_source="${bunRuntimeSource}"`,
    '>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"',
    '>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"',
    'if not exist "%OCX_BUN%" (',
    "  call :restore_backup",
    ")",
    'if not exist "%OCX_BUN%" (',
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: bundled Bun is missing; reinstall opencodex, then run ocx service repair',
    "  exit /b 3",
    ")",
    'if not exist "%OCX_CLI%" (',
    "  call :restore_backup",
    ")",
    'if not exist "%OCX_CLI%" (',
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: CLI entry is missing; reinstall opencodex, then run ocx service repair',
    "  exit /b 3",
    ")",
    `"%OCX_BUN%" "%OCX_CLI%" start --port ${port} >>"%OCX_SERVICE_LOG%" 2>&1`,
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    // `timeout` needs console stdin and dies with "Input redirection is not supported"
    // under Task Scheduler, turning the 5s cooldown into a hot restart loop; ping doesn't.
    "  ping -n 6 127.0.0.1 >nul",
    "  goto loop",
    ")",
    "endlocal",
    "goto :eof",
    "",
    // #1942/#1849: a power loss mid-swap leaves the live package dir missing/broken and
    // a sibling .ocx-backup-* holding the previous version. This wrapper lives OUTSIDE
    // the package tree, so it can restore when the launcher itself is gone — the exact
    // window the in-launcher boot probe cannot reach.
    ":restore_backup",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] install incomplete - looking for a transactional-update backup to restore',
    'for /f "delims=" %%B in (\'dir /b /ad /o-n "%OCX_PKG_DIR%\\..\\.ocx-backup-*" 2^>nul\') do (',
    '  if exist "%OCX_PKG_DIR%\\..\\%%B\\opencodex\\package.json" (',
    '    if exist "%OCX_PKG_DIR%" rmdir /s /q "%OCX_PKG_DIR%" 2>nul',
    '    move "%OCX_PKG_DIR%\\..\\%%B\\opencodex" "%OCX_PKG_DIR%" >nul 2>&1',
    '    if exist "%OCX_PKG_DIR%\\package.json" (',
    '      >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] restored previous install from %%B',
    "      goto :eof",
    "    )",
    "  )",
    ")",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] no restorable backup found',
    "goto :eof",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  const xml = script === windowsServiceScriptPath() ? windowsTaskXmlPath() : `${script}.xml`;
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/** Build the fixed scheduler-create command from an explicit staged XML document. */
export function buildWindowsSchtasksCreateArgsForXml(xml: string): string[] {
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/**
 * VBS launcher that starts the batch wrapper with a hidden window (style 0).
 * bWaitOnReturn=True keeps wscript.exe resident for the wrapper's lifetime so the
 * scheduled task stays "running": MultipleInstancesPolicy=IgnoreNew keeps preventing
 * duplicates and `schtasks /end` still has a live task instance to stop. Without the
 * launcher, the console batch action shows a closable cmd window in the interactive
 * session (issue #165). VBS string literals escape `"` as `""`.
 */
export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  const lines = [
    "' OpenCodex service launcher — runs the batch wrapper with a hidden window.",
    "' Generated by `ocx service install`; do not edit.",
    'Set shell = CreateObject("WScript.Shell")',
    // WshShell.Run(command, windowStyle 0 = hidden, bWaitOnReturn True = stay resident).
    `shell.Run """${escaped}""", 0, True`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function windowsTaskDescription(attemptNonce?: string): string {
  return attemptNonce
    ? `OpenCodex proxy service wrapper; install-attempt=${attemptNonce}`
    : "OpenCodex proxy service wrapper";
}

export function buildWindowsTaskXml(
  script = windowsServiceScriptPath(),
  launcher = windowsLauncherVbsPath(),
  attemptNonce?: string,
): string {
  const escapedWscript = taskXmlString(windowsWscript());
  // Escape the launcher path independently for the <Arguments> element; quoting it
  // keeps spaces intact, and /b (batch mode) suppresses script error popups.
  const escapedLauncherArgs = taskXmlString(`/b /nologo "${launcher}"`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${taskXmlString(windowsTaskDescription(attemptNonce))}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedWscript}</Command>
      <Arguments>${escapedLauncherArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}

/** Drop comments and CDATA so a commented-out decoy cannot satisfy any check. */
function taskXmlWithoutCommentsAndCdata(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}

/**
 * Count occurrences of an unprefixed tag, including the self-closing form. The
 * element boundary matters: `<EnabledExtra>` must not count as `Enabled`.
 */
function taskXmlElementCount(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*?)?\\s*\\/?>`, "gi"))?.length ?? 0;
}

/**
 * True when a namespace-prefixed form of the tag appears. A prefixed element bound
 * to the task namespace carries a real value, but this module parses by regex and
 * cannot resolve prefixes — so it fails closed instead of reading the element as
 * absent (which would silently apply the schema default).
 */
function taskXmlHasPrefixedTag(xml: string, tag: string): boolean {
  return new RegExp(`<[A-Za-z_][\\w.-]*:${tag}(?:[\\s/>])`, "i").test(xml);
}

/**
 * Compare an element that Task Scheduler may omit when exporting a registered task.
 * Absence means the documented schema default (#432); a present element must still
 * match exactly, so a malformed or explicitly unsafe value never reads as healthy.
 */
/**
 * Decode XML's five predefined entities, exactly once.
 *
 * Task Scheduler re-encodes element text when it exports a task, so a needle we
 * escaped ourselves can never match its output (#608). Compare decoded values
 * instead of encoded ones.
 *
 * The single pass is the point: decoding twice would turn `&amp;quot;` into `"`,
 * letting a doubly-encoded value impersonate the expected launcher path.
 */
function taskXmlDecodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => (
    name === "amp" ? "&"
      : name === "lt" ? "<"
        : name === "gt" ? ">"
          : name === "quot" ? "\""
            : "'"
  ));
}

/**
 * Exactly one unprefixed `<tag>` whose DECODED text equals `expected`.
 *
 * Unlike taskXmlOptionalValueEquals(), an absent element is NOT a pass: these
 * elements name what actually gets executed, so a missing <Command>/<Arguments>
 * must fail the health check rather than inherit a schema default.
 */
function taskXmlDecodedValueEquals(xml: string, tag: string, expected: string): boolean {
  // Same reasoning as the optional helper: `<t:Arguments>` must not read as absent.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  if (taskXmlElementCount(xml, tag) !== 1) return false;
  // `[^<]*` refuses nested markup, so a decoy inside a child element cannot match.
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>([^<]*)<\\/${tag}>`, "i").exec(xml)?.[1];
  if (value === undefined) return false;
  return taskXmlDecodeEntities(value).trim().toLowerCase() === expected.trim().toLowerCase();
}

function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
  // Check the prefixed form first: treating `<t:Enabled>false</t:Enabled>` as an
  // omission would turn an explicitly disabled task into a healthy one.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  const count = taskXmlElementCount(xml, tag);
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "i").exec(xml)?.[1];
  return value?.trim().toLowerCase() === expected.toLowerCase();
}

/** True only when the exported live task carries this install attempt's nonce. */
export function windowsTaskRegistrationOwnedByAttempt(xml: string, attemptNonce: string): boolean {
  if (!attemptNonce) return false;
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  if (taskXmlHasPrefixedTag(scrubbed, "RegistrationInfo")) return false;
  if (taskXmlElementCount(scrubbed, "RegistrationInfo") !== 1) return false;
  const registrationInfo = taskXmlSection(scrubbed, "RegistrationInfo");
  return taskXmlDecodedValueEquals(
    registrationInfo,
    "Description",
    windowsTaskDescription(attemptNonce),
  );
}

/** Validate the security/lifecycle-critical fields of the registered scheduler task. */
export function windowsTaskRegistrationHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  // taskXmlSection() takes the FIRST match and the schema allows arbitrary XML under
  // Task/Data, so a Data block placed before the real sections could shadow them.
  // We never emit Data, so its presence alone disqualifies the registration. Both
  // forms are rejected because taskXmlElementCount() ignores prefixed tags.
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  const triggers = taskXmlSection(scrubbed, "Triggers");
  const trigger = taskXmlSection(triggers, "LogonTrigger");
  const principal = taskXmlSection(scrubbed, "Principal");
  const settings = taskXmlSection(scrubbed, "Settings");
  const action = taskXmlSection(scrubbed, "Exec");
  // A self-closing <LogonTrigger /> leaves an empty section, so look for the element
  // itself — scoped to <Triggers> so a decoy elsewhere cannot satisfy it.
  return taskXmlElementCount(triggers, "LogonTrigger") > 0
    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && taskXmlRunLevelAcceptable(principal)
    && taskXmlOptionalValueEquals(settings, "Enabled", "true")
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    // Compare decoded VALUES, not encodings: Task Scheduler canonicalizes the
    // quotes we wrote as `&quot;` back to literal `"` on export, so an escaped
    // needle never matched and a healthy task read as permanently stale (#608).
    // Case-insensitive: elevated `schtasks /create` may rewrite System32 casing.
    && taskXmlDecodedValueEquals(action, "Command", wscript)
    && taskXmlDecodedValueEquals(action, "Arguments", `/b /nologo "${launcher}"`);
}

export interface WindowsSchedulerXmlState {
  installed: boolean;
  enabled: boolean;
  registrationHealthy: boolean;
}

/**
 * Single source of truth for reading a registered task's XML. Both the status
 * diagnostic and its tests go through here, so a partial fix cannot leave one
 * caller on an older, stricter reading of the same document (#432).
 */
export function readWindowsSchedulerXmlState(
  xml: string,
  wscript?: string,
  launcher?: string,
): WindowsSchedulerXmlState {
  const installed = xml.length > 0;
  if (!installed) return { installed: false, enabled: false, registrationHealthy: false };
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const hasData = taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data");
  const settings = hasData ? "" : taskXmlSection(scrubbed, "Settings");
  return {
    installed: true,
    enabled: !hasData && taskXmlOptionalValueEquals(settings, "Enabled", "true"),
    registrationHealthy: windowsTaskRegistrationHealthy(xml, wscript, launcher),
  };
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const p = plistPath();
  // Capture this BEFORE writing: the write below makes the plist exist unconditionally,
  // so a post-write existsSync would call every fresh install an "installed" service.
  const wasInstalled = existsSync(p);
  writeServiceDefinitionFile(p, buildPlist(), "utf8");
  // Best-effort: an absent job is fine here, and a failed unload is caught by the
  // load verification below with a better message than a raw unload error.
  runLaunchctl(["unload", p]);
  const loaded = runLaunchctl(["load", "-w", p]);
  if (!loaded.ok || launchctlLoadFailed(loaded.stderr)) {
    // Do NOT write install state for a load that did not take: state describing an
    // unused plist is what made this failure invisible.
    throw new Error(
      `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
      + "A previous job may still be bootstrapped. Try:\n"
      + `  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n`
      // macOS `service repair` delegates straight to installLaunchd, so this fires for
      // an already-installed service too; repair reloads it without re-registering.
      + `then re-run '${wasInstalled ? "ocx service repair" : "ocx service install"}'.`,
    );
  }
  writeServiceInstallState();
}
/**
 * Deps are named for the layer they replace, not for the process API: `launchctl`
 * returns a {@link runLaunchctl} result and `matches` a {@link launchdJobMatchesPlist}
 * result. Only `runLaunchctl` itself takes a spawnSync mock.
 *
 * Exported for the branch tests. Every parameter is optional, so this stays
 * assignable to `ServiceOps.start` (`() => void`) and `platformOps` wires the same
 * function the tests exercise.
 */
export function startLaunchd(deps: {
  launchctl?: typeof runLaunchctl;
  matches?: typeof launchdJobMatchesPlist;
} = {}): void {
  const run = deps.launchctl ?? runLaunchctl;
  const p = plistPath();
  const loaded = run(["load", "-w", p]);
  if (loaded.ok && !launchctlLoadFailed(loaded.stderr)) return;
  // `Load failed` on start is AMBIGUOUS in a way it is not on install: the job may
  // already be bootstrapped from THIS plist, which is a no-op rather than an error.
  // `install` can assume a stale job (it just rewrote the plist); `start` cannot, and
  // throwing here would break `ocx service start` on every healthy service.
  const entry = cliEntry();
  const live = (deps.matches ?? launchdJobMatchesPlist)(
    buildServiceShellCommand(entry.bun, entry.cli),
  );
  if (live.loaded && live.matchesPlist) {
    console.log("ℹ️  service was already loaded from the current plist; nothing to do.");
    return;
  }
  throw new Error(
    `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
    + (live.loaded
      ? `launchd is running an OLDER plist. Fix:\n  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n  ocx service repair`
      : "The job is not loaded. Run 'ocx service repair' to reload it."),
  );
}
function stopLaunchd(): void { try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ } }
function statusLaunchd(): string { try { return sh(`launchctl list | grep ${LABEL} || true`); } catch { return ""; } }
function uninstallLaunchd(): void {
  const p = plistPath();
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Write a service definition with owner-only permissions.
 *
 * These files carry the outbound proxy environment (#2107), and a proxy URL routinely
 * carries `user:password`. `writeFileSync` without a mode lands at 0644 under the default
 * umask, so the credential would be world-readable on a shared host. Every other
 * secret-bearing write in this file already uses 0600 — the service API token and the
 * install state — and a service definition holding a proxy credential belongs in the same
 * class.
 *
 * The explicit `chmodSync` is not redundant: `mode` only applies when the file is
 * created, so an install over a definition left at 0644 by an earlier version would keep
 * the loose mode.
 *
 * On Windows the POSIX bits are advisory, so the ACL is the real boundary — and whether it
 * may soft-fail depends on what the definition actually contains. A definition carrying a
 * proxy credential is a secret publication and fails closed like the API token and the
 * install state do; one carrying only paths and a port is not worth refusing an install
 * over, since before #2107 these files had no hardening at all and a failure here would
 * regress a user who has no credential to protect.
 */
export function writeServiceDefinitionFile(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  writeFileSync(path, content, { encoding, mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* superseded by the Windows ACL below */ }
  if (process.platform === "win32") {
    hardenSecretPath(path, { required: definitionCarriesCredential(content) });
  }
}

/**
 * Does this service definition embed a credential-bearing proxy URL?
 *
 * Only the userinfo form leaks something: `http://user:pass@host` in any of the four proxy
 * variables. A bare `http://127.0.0.1:7890` is not a secret, and treating it as one would
 * make an icacls stall fail an install that had nothing to protect.
 *
 * The scan is over any URL in the rendered definition rather than over a `KEY=value` shape,
 * because the three formats render differently — systemd writes `Environment="K=V"`, the
 * plist writes `<key>K</key><string>V</string>`, and the Windows wrapper writes
 * `set "K=V"`. Keying on the assignment syntax silently missed the plist.
 */
export function definitionCarriesCredential(content: string): boolean {
  // A userinfo authority: scheme, then anything that is not a delimiter, then '@'.
  return /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/@]+@/i.test(content);
}

// ── Windows (Task Scheduler) ──
/**
 * In-place service-asset write that tolerates the transient EBUSY/EPERM/EACCES Windows
 * throws while the just-ended task's cmd.exe (or an AV scanner) still holds the file.
 */
function writeServiceAssetWithRetry(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeServiceDefinitionFile(path, content, encoding);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
      Bun.sleepSync(150);
    }
  }
}

/**
 * Rewrite on-disk scheduler assets (script/VBS/XML) without re-registering the task.
 * Used by fresh install (before schtasks /create) and by repair (no elevation).
 */
function writeWindowsSchedulerAssets(): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const script = windowsServiceScriptPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8");
  // UTF-16LE + BOM: a BOM-less UTF-8 VBS mis-decodes non-ASCII (e.g. Korean) profile
  // paths on some WSH/codepage combinations — same contract as the task XML below.
  writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le");
  writeServiceAssetWithRetry(windowsTaskXmlPath(), `\uFEFF${buildWindowsTaskXml(script)}`, "utf16le");
}

const WINDOWS_SCHEDULER_STAGE_PREFIX = "opencodex-service-stage-";
const ownedWindowsSchedulerStages = new Set<string>();

export interface WindowsSchedulerRegistrationStageDeps {
  createStageDir?: () => string;
  hardenDir?: (path: string) => void;
  writeXml?: (path: string, contents: string) => void;
  hardenPath?: (path: string) => void;
  removeStageDir?: (path: string) => void;
}

function cleanupWindowsSchedulerStage(
  stageDir: string,
  xmlPath: string,
  removeStageDir: (path: string) => void,
): void {
  let cleanupError: unknown;
  try {
    unlinkSync(xmlPath);
    forgetEphemeralSecretPath(xmlPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      forgetEphemeralSecretPath(xmlPath);
    } else {
      cleanupError = error;
    }
  }
  try {
    removeStageDir(stageDir);
    forgetEphemeralSecretDir(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      forgetEphemeralSecretDir(stageDir);
    } else if (cleanupError) {
      throw new AggregateError([cleanupError, error], "Task Scheduler staging cleanup failed.");
    } else {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
}

export function stageWindowsSchedulerRegistrationXml(
  attemptNonce: string,
  deps: WindowsSchedulerRegistrationStageDeps = {},
): string {
  const createStageDir = deps.createStageDir
    ?? (() => mkdtempSync(join(tmpdir(), WINDOWS_SCHEDULER_STAGE_PREFIX)));
  const hardenDir = deps.hardenDir
    ?? ((path: string) => { hardenSecretDir(path, { required: true }); });
  const writeXml = deps.writeXml ?? ((path: string, contents: string) => {
    writeFileSync(path, contents, { encoding: "utf16le", flag: "wx", mode: 0o600 });
  });
  const hardenPath = deps.hardenPath
    ?? ((path: string) => { hardenSecretPath(path, { required: true }); });
  const removeStageDir = deps.removeStageDir
    ?? ((path: string) => { rmdirSync(path); });

  let stageDir: string | null = null;
  let xmlPath: string | null = null;
  try {
    stageDir = createStageDir();
    try { chmodSync(stageDir, 0o700); } catch { /* required Windows ACL is authoritative */ }
    hardenDir(stageDir);
    xmlPath = join(stageDir, "task.xml");
    // This document points at the canonical launcher but does not publish or rewrite it.
    // The hardened private directory prevents another local account from replacing the
    // document while UAC is pending; the file harden independently proves its identity.
    writeXml(
      xmlPath,
      `\uFEFF${buildWindowsTaskXml(windowsServiceScriptPath(), windowsLauncherVbsPath(), attemptNonce)}`,
    );
    hardenPath(xmlPath);
    ownedWindowsSchedulerStages.add(xmlPath);
    return xmlPath;
  } catch (error) {
    if (stageDir) {
      try {
        cleanupWindowsSchedulerStage(stageDir, xmlPath ?? join(stageDir, "task.xml"), removeStageDir);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Task Scheduler staging failed and its private temporary directory could not be removed.",
        );
      }
    }
    throw error;
  }
}

function removeWindowsSchedulerRegistrationStage(xmlPath: string): void {
  if (!ownedWindowsSchedulerStages.has(xmlPath)) {
    throw new Error("Refusing to remove an unrecognized Task Scheduler staging path.");
  }
  const stageDir = dirname(xmlPath);
  cleanupWindowsSchedulerStage(
    stageDir,
    xmlPath,
    path => { rmdirSync(path); },
  );
  if (existsSync(stageDir)) {
    throw new Error("The private Task Scheduler staging directory still exists after cleanup.");
  }
  ownedWindowsSchedulerStages.delete(xmlPath);
}

export interface FreshWindowsSchedulerRegistrationDeps {
  create?: (args: string[]) => void;
  elevate?: (taskName: string, xml: string) => Promise<void>;
  probe?: () => WindowsSchedulerTaskProbe;
  queryXml?: () => string;
  rollback?: () => Promise<string | null>;
}

export async function registerFreshWindowsSchedulerTask(
  xmlPath: string,
  attemptNonce: string,
  deps: FreshWindowsSchedulerRegistrationDeps = {},
): Promise<void> {
  const args = buildWindowsSchtasksCreateArgsForXml(xmlPath);
  // Capture and validate the exact definition before an access-denied attempt can
  // cross the UAC boundary. The elevated fallback receives these immutable bytes,
  // never the caller-writable staging pathname.
  const expectedXml = decodeSchtasksOutput(readFileSync(xmlPath));
  if (
    !windowsTaskRegistrationHealthy(expectedXml)
    || !windowsTaskRegistrationOwnedByAttempt(expectedXml, attemptNonce)
  ) {
    throw new Error("The staged Task Scheduler registration failed OpenCodex ownership or shape validation.");
  }
  try {
    (deps.create ?? schtasks)(args);
  } catch (error) {
    if (
      !(error instanceof WindowsSchtasksError)
      || error.operation !== "create"
      || error.reason !== "access-denied"
    ) {
      throw error;
    }
    // Register from the captured XML string inside the elevated process. Another
    // same-user process can mutate its own temp files, but cannot change this command.
    const elevate = deps.elevate ?? (async (taskName: string, xml: string) => {
      const exitCode = await runWindowsElevatedScheduledTaskRegistration(taskName, xml);
      if (exitCode !== 0) throw new Error(`Background service install failed with exit code ${exitCode}.`);
    });
    await elevate(TASK, expectedXml);
  }

  const rollbackTask = deps.rollback ?? (() => rollbackWindowsSchedulerTaskOwnedByAttempt(attemptNonce, TASK));
  const probe = (deps.probe ?? (() => probeWindowsSchedulerTask(TASK)))();
  if (probe.status === "absent") {
    throw new Error("Task Scheduler reported success, but the new registration is absent; no service cleanup was started.");
  }
  if (probe.status === "unknown") {
    const rollback = await rollbackTask();
    throw new Error(
      `Task Scheduler registration was not verifiably present after create (${probe.detail}).`
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The unverified registration was rolled back."),
    );
  }

  let registeredXml = "";
  let queryDetail: string | null = null;
  try {
    registeredXml = (deps.queryXml ?? (() => querySchtasks(["/query", "/tn", TASK, "/xml"])))();
  } catch (error) {
    queryDetail = error instanceof Error ? error.message : String(error);
  }
  if (!registeredXml.trim()) {
    const rollback = await rollbackTask();
    throw new Error(
      "Task Scheduler registration was created, but its live XML could not be verified."
      + (queryDetail ? ` Query failed: ${queryDetail}` : " The query returned an empty document.")
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The unverified registration was rolled back."),
    );
  }
  if (
    !windowsTaskRegistrationHealthy(registeredXml)
    || !windowsTaskRegistrationOwnedByAttempt(registeredXml, attemptNonce)
  ) {
    const rollback = await rollbackTask();
    throw new Error(
      "Task Scheduler registration was created but failed the OpenCodex action/trigger or attempt-ownership verification."
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The invalid registration was rolled back."),
    );
  }
}

function recordWindowsSchedulerOwnership(): boolean {
  // Ownership claiming is deliberately conservative: a legacy non-empty config root
  // without metadata stays unclaimed, but that must not turn a service reinstall into
  // an outage after prepareServiceInstall has stopped the previous manager.
  return recordOwnedConfigPath(getConfigDir(), serviceStatePath());
}

export interface RemoveNativeWindowsServiceDeps {
  status?: () => WinswStatus;
  uninstall?: () => void;
  sleep?: (ms: number) => void;
  settleChecks?: number;
}

export function removeNativeWindowsServiceForScheduler(
  deps: RemoveNativeWindowsServiceDeps = {},
): void {
  const status = deps.status ?? statusWinswRaw;
  const uninstall = deps.uninstall ?? uninstallWinswService;
  const sleep = deps.sleep ?? Bun.sleepSync;
  const settleChecks = Math.max(1, deps.settleChecks ?? 20);
  // Transactional backend switch: installing the scheduler backend removes a native
  // service first — two live managers would both respawn the proxy (conflict).
  if (status() !== "nonexistent") {
    console.log("🔁 Removing the native (WinSW) service before installing the Task Scheduler backend...");
    try {
      uninstall();
    } catch (err) {
      throw new Error(`Cannot remove the native service before switching to Task Scheduler: ${err instanceof Error ? err.message : String(err)}. Remove it manually with 'sc delete ${WINSW_SERVICE_ID}' or retry.`);
    }
    for (let check = 0; check < settleChecks; check++) {
      if (status() === "nonexistent") return;
      if (check + 1 < settleChecks) sleep(250);
    }
    throw new Error(`Native service registration could not be re-verified after the removal attempt — aborting switch. Check 'sc.exe query ${WINSW_SERVICE_ID}' and remove it manually if present.`);
  }
}

function installWindows(): void {
  recordWindowsSchedulerOwnership();
  removeNativeWindowsServiceForScheduler();
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  try { stopWindows(); } catch { /* not running */ }
  writeWindowsSchedulerAssets();
  schtasks(buildWindowsSchtasksCreateArgs(windowsServiceScriptPath()));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState("scheduler");
}

export interface RepairServiceDeps {
  diagnose?: () => ServiceDiagnostic;
  assertEnv?: () => void;
  assertAuth?: () => void;
  writeSchedulerAssets?: () => void;
  stopScheduler?: () => void;
  startScheduler?: () => void;
  writeSchedulerState?: () => void;
  writeNativeState?: () => void;
  repairNative?: () => void | Promise<void>;
  repairLaunchd?: () => void;
  repairSystemd?: () => void;
  /** Test seam — defaults to process.platform so Linux CI cannot hit real installSystemd. */
  platform?: NodeJS.Platform;
}

/**
 * Repair an already-installed background service without Task Scheduler re-registration.
 *
 * Windows scheduler: rewrite assets + stop/start — no `schtasks /create`, no UAC.
 * Windows native: WinSW asset rewrite + restart (skips `install /p` when present).
 * macOS/Linux: re-run the user-level install/reload path.
 */
export async function repairService(deps: RepairServiceDeps = {}): Promise<void> {
  const diagnose = deps.diagnose ?? diagnoseService;
  const platform = deps.platform ?? process.platform;
  const diag = diagnose();
  if (!diag.supported) {
    throw new Error(`Background service is unsupported (${diag.summary}).`);
  }
  if (diag.conflict) {
    throw new Error(
      "Cannot repair while Task Scheduler and native WinSW are both present. "
        + "Run 'ocx service uninstall' then reinstall one backend with 'ocx service install'.",
    );
  }
  if (!diag.installed) {
    throw new Error("Background service is not installed. Run 'ocx service install' first.");
  }

  (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
  (deps.assertAuth ?? assertServiceAuthEnvironment)();

  if (platform === "win32") {
    if (diag.backend === "native") {
      await (deps.repairNative ?? (() => installWinswService(defaultWinswEntry(import.meta.dir))))();
      (deps.writeNativeState ?? (() => writeServiceInstallState("native")))();
      return;
    }
    try { (deps.stopScheduler ?? stopWindows)(); } catch { /* not running */ }
    (deps.writeSchedulerAssets ?? writeWindowsSchedulerAssets)();
    (deps.startScheduler ?? startWindows)();
    (deps.writeSchedulerState ?? (() => writeServiceInstallState("scheduler")))();
    return;
  }
  if (platform === "darwin") {
    (deps.repairLaunchd ?? installLaunchd)();
    return;
  }
  if (platform === "linux") {
    (deps.repairSystemd ?? installSystemd)();
    return;
  }
  throw new Error(`Background service repair is unsupported on ${platform}.`);
}

/**
 * Opt-in native backend (`ocx service install --native`). Transactional: removes the
 * scheduler backend first; on failure the machine is left with NO service (explicitly
 * reported) — never a silent fallback to the scheduler.
 */
/** Refuse WinSW when the interactive user is a Microsoft account (SCM cannot authenticate it). */
export function assertWindowsNativeServiceAccountSupported(): void {
  if (process.platform !== "win32") return;
  const source = readWindowsPrincipalSource();
  if (source?.toLowerCase() === "microsoftaccount") {
    throw new Error(
      "The native (WinSW) service backend cannot run under a Microsoft-account Windows login. "
        + "Keep the Task Scheduler backend (`ocx service install`) or sign in with a local/domain account before `ocx service install --native`.",
    );
  }
}

function readWindowsPrincipalSource(): string | null {
  if (process.platform !== "win32") return null;
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(ps)) return null;
  try {
    const out = execFileSync(ps, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue).PrincipalSource",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function installWindowsNative(): Promise<void> {
  assertWindowsNativeServiceAccountSupported();
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  let hadScheduler = false;
  try {
    hadScheduler = schtasks(["/query", "/tn", TASK]).includes(TASK);
  } catch { /* task absent */ }
  if (hadScheduler) {
    console.log("🔁 Removing the Task Scheduler backend before installing the native (WinSW) service...");
    try { stopWindows(); } catch { /* not running */ }
    try {
      uninstallWindows();
    } catch (err) {
      throw new Error(`Cannot remove the Task Scheduler backend before switching to native: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Verify removal — schtasks /delete can silently fail if UAC or policy blocks it.
    try {
      if (schtasks(["/query", "/tn", TASK]).includes(TASK)) {
        throw new Error("Task Scheduler backend still present after removal — aborting switch.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("still present")) throw e;
      /* query failure = task absent, which is what we want */
    }
  }
  try {
    await installWinswService(defaultWinswEntry(import.meta.dir));
  } catch (err) {
    if (hadScheduler) console.error("⚠️  Native install failed AFTER removing the Task Scheduler backend — no service is installed now. Run `ocx service install` to restore the scheduler backend, or retry `--native`.");
    throw err;
  }
  writeServiceInstallState("native");
}
function startWindows(): void { schtasks(["/run", "/tn", TASK]); }

export function isWindowsSchedulerEndBenign(error: unknown): boolean {
  const detail = schtasksErrorDetail(error).toLowerCase();
  return detail.includes("no running instance")
    || detail.includes("not currently running")
    || detail.includes("0x41330");
}

/**
 * End the scheduler task. "Already stopped" is success; other `/end` failures are
 * swallowed so callers can still run tracked-proxy + live-proxy cleanup.
 *
 * Do not key a restart-window wait on `/end` failure: the #764 case is an `/end`
 * that *succeeds* while the wrapper survives and respawns. That verification lives
 * on the stop-verification path (poll across the restart window), not here.
 */
export function stopWindows(): void {
  try {
    schtasks(["/end", "/tn", TASK]);
  } catch (error) {
    if (isWindowsSchedulerEndBenign(error)) return;
  }
}
function statusWindows(): string { try { return schtasks(["/query", "/tn", TASK]); } catch { return ""; } }
function statusWindowsXml(): string { try { return schtasks(["/query", "/tn", TASK, "/xml"]); } catch { return ""; } }

/**
 * Best-effort termination of surviving Windows scheduler launcher/wrapper processes.
 * `schtasks /end` ends the task instance but often leaves wscript/cmd running the
 * `:loop` batch, which brings the proxy back during a stop or restart.
 *
 * The matching rule — canonical paths of THIS installation, as complete
 * command-line tokens — lives in lib/windows-service-wrappers so the update job
 * cannot drift away from it again.
 */
function killWindowsServiceWrapperProcesses(): void {
  killWindowsSchedulerWrappers({
    scriptPath: windowsServiceScriptPath(),
    launcherPath: windowsLauncherVbsPath(),
  });
}
function uninstallWindows(): void {
  const probe = probeWindowsSchedulerTask(TASK);
  if (probe.status === "present") {
    try {
      schtasks(["/delete", "/tn", TASK, "/f"]);
    } catch (error) {
      throw new Error(`Failed to delete Task Scheduler task ${TASK}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const afterDelete = probeWindowsSchedulerTask(TASK);
    if (afterDelete.status === "present") {
      throw new Error(`Task Scheduler task ${TASK} is still present after delete — refusing to remove service assets. Retry from an elevated shell.`);
    }
    if (afterDelete.status === "unknown") {
      throw new Error(`Task Scheduler task ${TASK} presence could not be verified after delete — refusing to remove service assets.`);
    }
  } else if (probe.status === "unknown") {
    throw new Error(`Task Scheduler task ${TASK} presence could not be verified — refusing to remove service assets.`);
  }
  if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
  if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());
  if (existsSync(windowsTaskXmlPath())) unlinkSync(windowsTaskXmlPath());
}

/**
 * Warn when the paths baked into installed service assets no longer exist (npm prefix
 * moved, nvm switch, reinstall) — the service manager would restart-loop on a dead path
 * while `schtasks`/`launchctl` still report "installed".
 */
export function bakedServicePathsDiagnostic(): string | null {
  const state = readServiceInstallState();
  if (!state?.bunPath || !state?.cliPath) return null;
  const missing = [state.bunPath, state.cliPath].filter(path => !existsSync(path));
  if (missing.length === 0) return null;
  return `STALE baked paths (missing: ${missing.join(", ")}) — run 'ocx service repair' to re-bake`;
}

function serviceDiagnosticsSummary(): string {
  const stale = bakedServicePathsDiagnostic();
  return stale ? `${stale}; logs: ${serviceLogPath()}` : `logs: ${serviceLogPath()}`;
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(proxyEnv: { name: string; value: string }[] = resolvedProxyEnv()): string {
  const { bun, bunRuntimeSource, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const codexSqliteHome = systemdEnvironmentAssignment("CODEX_SQLITE_HOME", currentCodexSqliteHomeAbsolute());
  const opencodexHome = systemdEnvironmentAssignment("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
    systemdEnvironmentAssignment(BUN_RUNTIME_PATH_ENV, bun),
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    codexSqliteHome,
    opencodexHome,
    ...proxyEnv.map(({ name, value }) => systemdEnvironmentAssignment(name, value)),
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(buildServiceShellCommand(bun, cli))}
Restart=on-failure
RestartSec=5
${envLines}
StandardOutput=${systemdOutputTarget(`append:${log}`)}
StandardError=${systemdOutputTarget(`append:${log}`)}

[Install]
WantedBy=default.target
`;
}

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ocx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  writeServiceDefinitionFile(unitPath(), buildUnit(), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState();
}
/**
 * Whether systemd's in-memory unit differs from the file on disk.
 *
 * The systemd analogue of launchd's stale-plist case: writing
 * `~/.config/systemd/user/<unit>` does not change the definition systemd has loaded
 * until `daemon-reload`, so a plain `systemctl start` would run the PREVIOUS
 * ExecStart. `NeedDaemonReload` is a per-unit property emitted as a bare
 * `NeedDaemonReload=yes|no` line; pass the unit name or `show` reports the manager's
 * own property instead, which answers a different question.
 *
 * Fail-open: if the query cannot run (no user bus, unit absent) we must not block a
 * start that would otherwise work.
 */
export function systemdNeedsDaemonReload(deps: { show?: () => string } = {}): boolean {
  try {
    const out = (deps.show ?? (() => sh(`systemctl --user show -p NeedDaemonReload ${TASK}`)))();
    return /NeedDaemonReload\s*=\s*yes/i.test(out);
  } catch {
    return false;
  }
}

function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) {
    console.error(`opencodex service is not installed: ${unitPath()}`);
    console.error("Run `ocx service install` first to create and enable the systemd user unit.");
    process.exit(1);
  }
  // The unit on disk may be newer than what systemd loaded; starting now would run
  // the previous definition.
  //
  // `start` alone is not enough after a reload: it is a no-op on an already-active
  // unit, so the stale process would keep running the old ExecStart. NeedDaemonReload
  // compares disk against loaded, never loaded against running, so the only way to
  // make the running process match the file is to restart it.
  if (systemdNeedsDaemonReload()) {
    console.log("ℹ️  unit file changed on disk; reloading systemd and restarting the service.");
    sh("systemctl --user daemon-reload");
    sh(`systemctl --user restart ${TASK}`);
    return;
  }
  sh(`systemctl --user start ${TASK}`);
}
function stopSystemd(): void { try { sh(`systemctl --user stop ${TASK}`); } catch { /* not running */ } }
function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }
function uninstallSystemd(): void {
  try { sh(`systemctl --user disable --now ${TASK}`); } catch { /* absent */ }
  if (existsSync(unitPath())) unlinkSync(unitPath());
  try { sh("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

type ServiceOps = {
  install: () => void | Promise<void>; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

type ServiceInstallCleanupOps = {
  status: () => string | null;
  stop: () => void;
};

function platformOps(backend: ServiceBackend = "scheduler"): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32") {
    if (backend === "native")
      return { install: installWindowsNative, start: startWinswService, stop: stopWinswService, status: winswStatusSummary, uninstall: uninstallWinswService };
    return { install: installWindows, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ocx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd() && !existsSync(unitPath())) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      if (isWslRuntime()) {
        console.error("WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).");
      }
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

/**
 * Install-only manager operations. Unlike the ordinary status/stop helpers, these
 * distinguish confirmed absence from a failed manager query and propagate every
 * non-benign stop failure. Installing new assets is unsafe while either answer is
 * unknown because an old manager may still respawn a listener on the target port.
 */
function platformServiceInstallCleanupOps(backend: ServiceBackend): ServiceInstallCleanupOps | null {
  if (process.platform === "darwin") {
    return {
      status: () => {
        const listing = sh("launchctl list");
        return listing.split("\n").some(line => line.includes(LABEL)) ? listing : null;
      },
      stop: () => { sh(`launchctl unload "${plistPath()}"`); },
    };
  }
  if (process.platform === "win32") {
    if (backend === "native") {
      return {
        status: () => {
          const status = statusWinswRaw();
          if (status === "unknown") throw new Error("Native service status could not be verified.");
          return status === "nonexistent" ? null : status;
        },
        stop: stopWinswService,
      };
    }
    return {
      status: () => {
        const probe = probeWindowsSchedulerTask(TASK);
        if (probe.status === "unknown") throw new Error(`Task Scheduler status could not be verified: ${probe.detail}`);
        return probe.status === "present" ? "present" : null;
      },
      stop: () => {
        try {
          schtasks(["/end", "/tn", TASK]);
        } catch (error) {
          if (!isWindowsSchedulerEndBenign(error)) throw error;
        }
      },
    };
  }
  if (process.platform === "linux") {
    return {
      status: () => {
        // `list-unit-files <name>` exits non-zero when the unit has never been
        // installed, which made a clean first install look like an unknown manager
        // failure. `show LoadState` gives us the tri-state we actually need: a
        // healthy user manager returns `not-found` for a missing unit, while an
        // unreachable/permission-denied manager still makes `sh()` throw and the
        // caller therefore fails closed.
        const loadState = sh(`systemctl --user show ${TASK} --property=LoadState --value`).trim().toLowerCase();
        if (!loadState) throw new Error("systemd service status could not be verified.");
        return loadState === "not-found" ? null : loadState;
      },
      stop: () => { sh(`systemctl --user stop ${TASK}`); },
    };
  }
  return null;
}

type TrackedProxyCleanupResult = "none" | "stale" | "stopped";

function verifiedKillTarget(pid: number | null | undefined): number | null {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const verified = verifyPidIdentity(pid);
  return verified === pid ? verified : null;
}

/**
 * Whether a proxy is still answering after the service manager claimed to stop it.
 *
 * `ops.stop()` reports the outcome of the STOP COMMAND, not of the process. A Windows scheduler
 * task whose wrapper survives `schtasks /end` respawns its child a few seconds later, so a stop
 * that returned success can still leave a live proxy — and `ocx service stop` then restored
 * native Codex on top of a running one (#764). The tracked-pid cleanup does not catch it either:
 * the respawned child writes a different pid, or none this process knows about.
 *
 * Probed rather than assumed, and bounded. The respawn risk is specific to a supervisor that can
 * restart its child — the Windows scheduler wrapper — so only that case pays the restart window.
 * Everywhere else a single probe answers the question, because nothing is going to bring the
 * proxy back after `launchctl unload` or `systemctl stop`. Making every platform wait 7s on a
 * stop that already succeeded would trade one bug for a worse everyday one.
 */
export async function proxyStillLiveAfterStop(deps: {
  findProxy?: () => Promise<{ port: number } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Whether the stopped supervisor can respawn its child; only then is polling worth the wait. */
  canRespawn?: boolean;
} = {}): Promise<{ port: number } | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const canRespawn = deps.canRespawn ?? process.platform === "win32";
  const deadline = now() + (canRespawn ? 7000 : 0);
  // Single-shot (non-respawn) still needs one full SERVICE_STOP_LIVENESS budget; respawn
  // polling shares the outer deadline so multi-candidate discovery cannot overrun it.
  const findProxy = deps.findProxy ?? (() => {
    const probeDeadline = canRespawn
      ? deadline
      : now() + (SERVICE_STOP_LIVENESS.timeoutMs! * SERVICE_STOP_LIVENESS.attempts! + 250);
    return findLiveProxy({ ...SERVICE_STOP_LIVENESS, deadlineAt: probeDeadline, nowFn: now });
  });
  for (;;) {
    try {
      const live = await findProxy();
      if (live) return live;
    } catch {
      // A probe failure is not proof the proxy is gone; keep polling until the deadline.
    }
    if (now() >= deadline) return null;
    await sleep(1000);
  }
}

async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult> {
  let stopped = false;
  const pid = readPid();
  const trackedKillPid = verifiedKillTarget(pid);
  if (trackedKillPid !== null && isProcessAlive(trackedKillPid)) {
    await stopProxy(trackedKillPid);
    removePid(trackedKillPid);
    removeRuntimePort(trackedKillPid);
    stopped = true;
  } else if (pid) {
    removePid(pid);
    removeRuntimePort(pid);
  }
  // Orphan recovery: the pid file can be missing/stale while the service wrapper keeps
  // a live proxy running — mirror `ocx stop`'s identity-checked findLiveProxy fallback.
  // Cap multi-candidate discovery so stop cleanup cannot hang for three full retry budgets.
  const live = await findLiveProxy({
    ...SERVICE_STOP_LIVENESS,
    deadlineAt: Date.now() + 7000,
  });
  const liveKillPid = verifiedKillTarget(live?.pid);
  if (liveKillPid !== null) {
    await stopProxy(liveKillPid);
    removePid(liveKillPid);
    removeRuntimePort(liveKillPid);
    stopped = true;
  }
  if (stopped) return "stopped";
  if (pid) return "stale";
  return "none";
}

async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult> {
  try {
    return await stopTrackedProxyIfRunning();
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return "none";
  }
}

export interface ServiceInstallPreparationDeps {
  diagnose?: () => ServiceDiagnostic;
  managerOps?: (backend: ServiceBackend) => ServiceInstallCleanupOps | null;
  stopTrackedProxy?: () => Promise<unknown>;
  platform?: NodeJS.Platform;
}

/**
 * Stop every manager that could own the install port, then stop the tracked
 * standalone listener. Any unknown status or cleanup failure rejects, so callers
 * cannot write assets or report success over a surviving old listener.
 */
export async function prepareServiceInstall(
  requestedBackend: ServiceBackend,
  deps: ServiceInstallPreparationDeps = {},
): Promise<void> {
  const diagnostic = (deps.diagnose ?? diagnoseService)();
  const platform = deps.platform ?? process.platform;
  const resolveOps = deps.managerOps ?? platformServiceInstallCleanupOps;
  const backends: ServiceBackend[] = [];
  const addBackend = (backend: ServiceBackend) => {
    if (!backends.includes(backend)) backends.push(backend);
  };

  if (platform === "win32") {
    // The recorded backend owns the old installation and must be stopped first.
    // A conflicting diagnostic means both managers exist, so stop both even when
    // the requested backend happens to match the recorded one.
    if (diagnostic.backend === "scheduler" || diagnostic.backend === "native") {
      addBackend(diagnostic.backend);
      if (diagnostic.conflict) addBackend(diagnostic.backend === "scheduler" ? "native" : "scheduler");
    }
    addBackend(requestedBackend);
  } else {
    addBackend(requestedBackend);
  }

  for (const backend of backends) {
    const manager = resolveOps(backend);
    if (!manager) throw new Error(`Background service manager is unavailable for ${backend}.`);
    if (manager.status() !== null) manager.stop();
  }
  await (deps.stopTrackedProxy ?? stopTrackedProxyIfRunning)();
}

export async function installServiceSafely(
  requestedBackend: ServiceBackend,
  install: () => void | Promise<void>,
  deps: ServiceInstallPreparationDeps = {},
): Promise<void> {
  await prepareServiceInstall(requestedBackend, deps);
  await install();
}

export interface FreshWindowsSchedulerInstallDeps {
  stageRegistrationXml?: (attemptNonce: string) => string;
  register?: (xmlPath: string, attemptNonce: string) => Promise<void>;
  recordOwnership?: () => boolean;
  prepare?: () => Promise<void>;
  removeNativeService?: () => void;
  publishAssets?: () => void;
  runTask?: () => void;
  writeState?: () => void;
  rollbackTask?: (attemptNonce: string) => Promise<string | null>;
  removeStagedXml?: (xmlPath: string) => void;
}

/**
 * Fresh Windows scheduler install with UAC before the destructive commit.
 *
 * The registration is created but never run before `prepare`: UAC cancellation and
 * create failure therefore cannot stop the existing proxy or trigger its native-routing
 * cleanup. Rollback proves ownership from the live registration's attempt nonce before
 * deleting, because the fixed task name can be replaced by another process at any time.
 */
export async function installFreshWindowsSchedulerSafely(
  deps: FreshWindowsSchedulerInstallDeps = {},
): Promise<void> {
  const stage = deps.stageRegistrationXml ?? stageWindowsSchedulerRegistrationXml;
  const register = deps.register ?? registerFreshWindowsSchedulerTask;
  const recordOwnership = deps.recordOwnership ?? recordWindowsSchedulerOwnership;
  const prepare = deps.prepare ?? (() => prepareServiceInstall("scheduler"));
  const removeNativeService = deps.removeNativeService ?? removeNativeWindowsServiceForScheduler;
  const publishAssets = deps.publishAssets ?? writeWindowsSchedulerAssets;
  const runTask = deps.runTask ?? startWindows;
  const writeState = deps.writeState ?? (() => writeServiceInstallState("scheduler"));
  const rollbackTask = deps.rollbackTask ?? ((attemptNonce: string) => (
    rollbackWindowsSchedulerTaskOwnedByAttempt(attemptNonce, TASK)
  ));
  const removeStagedXml = deps.removeStagedXml ?? ((path: string) => {
    removeWindowsSchedulerRegistrationStage(path);
  });

  let stagedXml: string | null = null;
  const attemptNonce = randomUUID();
  const configRootWasAbsent = !existsSync(getConfigDir());
  let registered = false;
  let started = false;
  try {
    stagedXml = stage(attemptNonce);
    await register(stagedXml, attemptNonce);
    registered = true;

    // The destructive boundary begins only after Task Scheduler accepted the definition.
    // The registration has consumed its temporary XML. Remove it before claiming a newly
    // created config root, because ownership initialization intentionally requires emptiness.
    removeStagedXml(stagedXml);
    stagedXml = null;
    const ownershipRecorded = recordOwnership();
    if (!ownershipRecorded && configRootWasAbsent) {
      throw new Error(
        "The fresh OpenCodex config root could not be claimed for safe uninstall; "
        + "aborting before service-manager cleanup or asset publication.",
      );
    }
    await prepare();
    removeNativeService();
    publishAssets();
    runTask();
    started = true;
    writeState();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (registered && !started) {
      const rollback = await rollbackTask(attemptNonce);
      throw new Error(
        `${detail}\n`
        + (rollback
          ? `The new Task Scheduler registration may remain: ${rollback}`
          : "The new Task Scheduler registration was rolled back. The previous proxy/routing state was not assumed restored."),
      );
    }
    if (started) {
      throw new Error(
        `${detail}\nThe scheduler task started, but install state was not published. `
        + "The task was left in place; inspect `ocx service status` before retrying.",
      );
    }
    throw error;
  } finally {
    if (stagedXml) {
      try { removeStagedXml(stagedXml); } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
        console.error(
          `⚠️  Failed to remove the private Task Scheduler staging directory${code ? ` (${code})` : ""}.`,
        );
      }
    }
  }
}

/**
 * If a service is installed, stop it so the process manager doesn't respawn after `ocx stop`.
 * Returns true if a service was found and stopped.
 */
export function stopServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { stopLaunchd(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    // Query BOTH backends regardless of state: a failed switch or stale state can leave
    // two managers installed, and either one would respawn the proxy after `ocx stop`.
    let stopped = false;
    try {
      const q = schtasks(["/query", "/tn", TASK]);
      if (q.includes(TASK)) { stopWindows(); stopped = true; }
    } catch { /* task not found */ }
    if (statusWinswRaw() !== "nonexistent") {
      try { stopWinswService(); stopped = true; } catch { /* best-effort */ }
    }
    // `schtasks /end` ends the task instance but the cmd `:loop` wrapper survives and
    // respawns its child seconds later (issue #764), resurrecting the proxy during a
    // stop or a tray restart. Kill the launcher/wrapper processes outright.
    killWindowsServiceWrapperProcesses();
    if (stopped) return true;
  } else if (process.platform === "linux" && isSystemd() && existsSync(unitPath())) {
    try { stopSystemd(); return true; } catch { return false; }
  }
  return false;
}

/** Delete install-state files; stale state would make `ocx update` "reinstall" a service that no longer exists. */
function removeServiceInstallState(): void {
  for (const path of serviceStatePaths()) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
}

type UninstallServiceHooksForTests = {
  platform: typeof process.platform;
  assertEnvironment: () => void;
  probeWindowsTask: () => WindowsSchedulerTaskProbe;
  uninstallWindowsTask: () => void;
  nativeStatus: () => WinswStatus;
  uninstallNative: () => void;
  removeInstallState: () => void;
};

let uninstallServiceHooksForTests: UninstallServiceHooksForTests | null = null;

/** Test-only hooks for full-uninstall service removal. */
export function setUninstallServiceHooksForTests(hooks: UninstallServiceHooksForTests | null): void {
  uninstallServiceHooksForTests = hooks;
}

/**
 * Best-effort service removal for full uninstall. Unlike `ocx service uninstall`, this is quiet
 * when no service exists or the platform has no service manager. An installed native Windows
 * service or scheduler task that cannot be removed throws so the caller cannot erase state and
 * report success.
 */
export function uninstallServiceIfInstalled(): boolean {
  const hooks = uninstallServiceHooksForTests;
  (hooks?.assertEnvironment ?? assertServiceEnvironmentMatchesInstall)();
  const platform = hooks?.platform ?? process.platform;
  if (platform === "darwin") {
    if (existsSync(plistPath())) {
      try { uninstallLaunchd(); removeServiceInstallState(); return true; } catch { return false; }
    }
  } else if (platform === "win32") {
    let removed = false;
    const scheduler = (hooks?.probeWindowsTask ?? probeWindowsSchedulerTask)();
    if (scheduler.status === "unknown") {
      throw new Error(`Could not determine Task Scheduler state: ${scheduler.detail}`);
    }
    if (scheduler.status === "present") {
      (hooks?.uninstallWindowsTask ?? uninstallWindows)();
      removed = true;
    }
    if ((hooks?.nativeStatus ?? statusWinswRaw)() !== "nonexistent") {
      (hooks?.uninstallNative ?? uninstallWinswService)();
      removed = true;
    }
    if (removed) { (hooks?.removeInstallState ?? removeServiceInstallState)(); return true; }
  } else if (platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); removeServiceInstallState(); return true; } catch {
      try { unlinkSync(unitPath()); removeServiceInstallState(); return true; } catch { return false; }
    }
  }
  return false;
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return diagnoseService().installed;
}

/**
 * True when an installed background service can actually supervise the proxy.
 * Presence alone is not enough: stale/missing assets, conflicts, and disabled
 * registrations report `installed` but will not bring the proxy back after exit.
 */
export function isServiceViable(): boolean {
  return diagnoseService().viable;
}

export interface ServiceDiagnostic {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  startable: boolean;
  stale: boolean;
  conflict: boolean;
  backend: ServiceBackend | "launchd" | "systemd" | null;
  summary: string;
}

/** Windows tray may restart a healthy-but-stopped native service; stale/conflicting installs remain blocked. */
export function serviceStartableFromTray(service: ServiceDiagnostic): boolean {
  return service.startable && !service.stale && !service.conflict;
}

export interface WindowsServiceDiagnosticInputs {
  /**
   * Raw `schtasks /query /xml` output; empty when no task is registered. Passed as
   * XML rather than pre-computed booleans so every caller reads the document through
   * readWindowsSchedulerXmlState() — a second, stricter reading elsewhere would
   * silently reintroduce the stale-status false positive (#432).
   */
  schedulerXml: string;
  /** Whether the on-disk service assets exist. A filesystem concern, not an XML one. */
  schedulerAssetsPresent: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  recordedBackend: ServiceBackend | null;
  staleBakedPaths: boolean;
  nativeRepairAssetsOnly: boolean;
  diagnostics: string;
}

export function deriveWindowsServiceDiagnostic(inputs: WindowsServiceDiagnosticInputs): ServiceDiagnostic {
  const schedulerState = readWindowsSchedulerXmlState(inputs.schedulerXml);
  const schedulerInstalled = schedulerState.installed;
  const schedulerEnabled = schedulerState.enabled;
  const schedulerAssetsHealthy = inputs.schedulerAssetsPresent && schedulerState.registrationHealthy;
  const nativeInstalled = inputs.nativeStatus !== "nonexistent";
  const conflict = schedulerInstalled && nativeInstalled;
  const backendStateMismatch = schedulerInstalled
    ? inputs.recordedBackend !== "scheduler"
    : nativeInstalled && inputs.recordedBackend !== "native";
  const stale = inputs.staleBakedPaths
    || (schedulerInstalled && !schedulerAssetsHealthy)
    || backendStateMismatch
    || (inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly);
  const backend = schedulerInstalled ? "scheduler" : nativeInstalled ? "native" : null;
  const enabled = schedulerInstalled ? schedulerEnabled : inputs.nativeStatus === "started";
  const running = nativeInstalled ? inputs.nativeStatus === "started" : schedulerInstalled && schedulerEnabled;
  const viable = !conflict && !stale
    && (schedulerInstalled ? schedulerEnabled && schedulerAssetsHealthy : inputs.nativeStatus === "started");
  const startable = !conflict && !stale
    && (schedulerInstalled
      ? schedulerEnabled && schedulerAssetsHealthy
      : inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const detail = conflict
    ? "CONFLICT: Task Scheduler and native WinSW are both present — run 'ocx service uninstall' then reinstall one"
    : stale
      ? "stale or missing service assets — run 'ocx service repair'"
      : schedulerInstalled
        ? schedulerEnabled ? "Task Scheduler enabled" : "Task Scheduler disabled"
        : nativeInstalled
          ? `native (WinSW ${WINSW_VERSION}): ${inputs.nativeStatus}`
          : "not installed";
  const summary = backend ? `installed, ${detail} (${inputs.diagnostics})` : `not installed (${inputs.diagnostics})`;
  return {
    supported: true,
    installed: schedulerInstalled || nativeInstalled,
    enabled,
    running,
    viable,
    startable,
    stale,
    conflict,
    backend,
    summary,
  };
}

/**
 * Fail-closed restart diagnostic. Presence alone is never enough: conflicting
 * managers, stale baked paths, disabled registrations, and unknown/stopped
 * native managers cannot claim that Codex will reconnect after a reboot.
 */
export function diagnoseService(): ServiceDiagnostic {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    const installed = existsSync(plistPath());
    const running = installed && Boolean(statusLaunchd());
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (launchd; ${diagnostics})`
        : running ? `installed and loaded (launchd; ${diagnostics})`
          : `installed, not loaded (launchd; ${diagnostics})`;
    return { supported: true, installed, enabled: running, running, viable, startable: installed && !stale, stale, conflict: false, backend: "launchd", summary };
  }
  if (process.platform === "win32") {
    const schedulerXml = statusWindowsXml();
    const schedulerAssetsPresent = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()]
      .every(existsSync);
    const nativeStatus = statusWinswRaw();
    const installState = readServiceInstallState();
    const recordedBackend: ServiceBackend | null = !installState
      ? null
      : installState.backend === "native" ? "native" : "scheduler";
    return deriveWindowsServiceDiagnostic({
      schedulerXml,
      schedulerAssetsPresent,
      nativeStatus,
      recordedBackend,
      staleBakedPaths: bakedServicePathsDiagnostic() !== null,
      nativeRepairAssetsOnly: Boolean(winswStatusSummary()),
      diagnostics,
    });
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker" };
    if (!isSystemd()) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported: systemd not found" };
    const installed = existsSync(unitPath());
    const enabled = installed && (() => { try { return sh(`systemctl --user is-enabled ${TASK}`) === "enabled"; } catch { return false; } })();
    const running = installed && (() => { try { return sh(`systemctl --user is-active ${TASK}`) === "active"; } catch { return false; } })();
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && enabled && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (systemd user; ${diagnostics})`
        : viable ? `installed, enabled and running (systemd user; ${diagnostics})`
          : `installed, but ${!enabled ? "disabled" : "not running"} (systemd user; ${diagnostics})`;
    return { supported: true, installed, enabled, running, viable, startable: installed && !stale, stale, conflict: false, backend: "systemd", summary };
  }
  return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: `unsupported on ${process.platform}` };
}

export function serviceStatusSummary(): string {
  return diagnoseService().summary;
}

/**
 * Status a human can act on: registration state, whether a proxy actually answers,
 * and — when it does not — whether launchd is running the plist we have on disk.
 *
 * `launchctl list` membership cannot distinguish "serving", "bootstrapped from an
 * older plist", and "loaded but never bound"; the reported failure was the middle
 * one presented as the first.
 *
 * Resolves the port through `confirmServiceServing`, i.e. the same
 * `installedServiceListenPort()` path install/start/repair use, so those surfaces can
 * never disagree about one service. The budget is short (2 probes) because this is a
 * status read, not a post-install wait.
 */
export async function serviceStatusReport(
  deps: {
    diagnose?: () => ServiceDiagnostic;
    serving?: () => Promise<{ ok: boolean; port: number }>;
    matchesPlist?: () => { loaded: boolean; matchesPlist: boolean };
  } = {},
): Promise<string> {
  const diag = (deps.diagnose ?? diagnoseService)();
  if (!diag.installed) return `❌ ${diag.summary}`;

  const serving = await (deps.serving ?? (() => confirmServiceServing({ timeoutMs: 1_500 })))();
  if (serving.ok) return `✅ ${diag.summary}\n   Serving on port ${serving.port}.`;

  // The dep is consulted FIRST; the platform check only guards the default. Wrapping
  // the whole expression in a darwin check would discard an injected seam on
  // Linux/Windows and make the stale-plist case untestable there.
  const stalePlist = deps.matchesPlist?.() ?? (process.platform === "darwin"
    ? (() => {
        const entry = cliEntry();
        // Pass the INSTALLED port explicitly: the default third argument is
        // resolveServiceListenPort(), which reads OCX_BAKE_PORT/config.port, so after
        // a config edit the expected string would never match and every run would
        // print a false "OLDER plist".
        return launchdJobMatchesPlist(
          buildServiceShellCommand(entry.bun, entry.cli, installedServiceListenPort()),
        );
      })()
    : null);
  const staleLine = stalePlist && stalePlist.loaded && !stalePlist.matchesPlist
    ? "   launchd is running an OLDER plist than the one on disk.\n"
      + `   Fix:    launchctl bootout gui/$(id -u)/${LABEL} && ocx service repair\n`
    : "";

  return `⚠️  ${diag.summary}\n`
    + `   Registered, but no proxy is answering on port ${serving.port}.\n`
    + staleLine
    + `   Log:    ${serviceLogPath()}\n`
    + `   Repair: ${serviceRepairCommand()}\n`
    + "   Meanwhile: ocx start           (serves in the foreground)";
}

export function normalizeServiceSubcommand(sub?: string): string {
  if (sub === "restart") return "repair";
  return sub ?? "install";
}

export interface ParsedServiceArgs {
  sub: string;
  backend: ServiceBackend | null;
  invalid: string[];
}

export type ServiceInstallationState = "installed" | "absent" | "unknown";

export interface ServiceInstallationProbe {
  state: ServiceInstallationState;
  detail?: string;
}

export interface ServiceInstallationProbeHooks {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  probeWindowsTask?: () => WindowsSchedulerTaskProbe;
  nativeStatus?: () => WinswStatus;
}

/**
 * Read only enough registration state to choose between install and repair.
 * Windows must keep query failure distinct from proven absence: treating an
 * unreadable scheduler/SCM as absent would send a bare command into the
 * elevated registration path and recreate the original #2287 failure.
 */
export function probeServiceInstallation(
  hooks: ServiceInstallationProbeHooks = {},
): ServiceInstallationProbe {
  const platform = hooks.platform ?? process.platform;
  const exists = hooks.exists ?? existsSync;
  if (platform === "darwin") {
    return { state: exists(plistPath()) ? "installed" : "absent" };
  }
  if (platform === "linux") {
    return { state: exists(unitPath()) ? "installed" : "absent" };
  }
  if (platform !== "win32") return { state: "absent" };

  let scheduler: WindowsSchedulerTaskProbe;
  try {
    scheduler = (hooks.probeWindowsTask ?? probeWindowsSchedulerTask)();
  } catch (cause) {
    scheduler = { status: "unknown", detail: schtasksErrorDetail(cause) };
  }
  let native: WinswStatus;
  try {
    native = (hooks.nativeStatus ?? statusWinswRaw)();
  } catch {
    native = "unknown";
  }

  if (scheduler.status === "present" || native === "started" || native === "stopped") {
    return { state: "installed" };
  }
  if (scheduler.status === "unknown" || native === "unknown") {
    const parts = [
      scheduler.status === "unknown" ? `Task Scheduler: ${scheduler.detail}` : null,
      native === "unknown" ? "WinSW status could not be determined" : null,
    ].filter((part): part is string => Boolean(part));
    return { state: "unknown", detail: parts.join("; ") };
  }
  return { state: "absent" };
}

/**
 * A bare invocation is an idempotent "make the installed service current"
 * operation. First-time setup still installs, but an existing registration must
 * use the repair path so Windows does not re-run the elevated `schtasks /create`.
 * Backend flags remain an explicit install request because they select which
 * registration mechanism to create.
 */
export function selectServiceSubcommand(
  parsed: ParsedServiceArgs,
  options: { hasExplicitSubcommand: boolean; installed: boolean },
): string {
  if (!options.hasExplicitSubcommand && parsed.backend === null && options.installed) return "repair";
  return parsed.sub;
}

export type ServiceCommandPlan =
  | { ok: true; parsed: ParsedServiceArgs; command: string }
  | { ok: false; message: string };

export function planServiceCommand(
  args: string[],
  options: { platform?: NodeJS.Platform; probeInstallation?: () => ServiceInstallationProbe } = {},
): ServiceCommandPlan {
  const parsed = parseServiceArgs(args);
  if (parsed.invalid.length > 0) {
    return { ok: false, message: `Unknown service option: ${parsed.invalid.join(" ")}` };
  }
  if (parsed.backend && parsed.sub !== "install") {
    return { ok: false, message: "--native/--scheduler apply to `ocx service install` only; other subcommands use the installed backend." };
  }
  if (parsed.backend === "native" && (options.platform ?? process.platform) !== "win32") {
    return { ok: false, message: "--native (WinSW) is Windows-only." };
  }

  const hasExplicitSubcommand = args.some(arg => !arg.startsWith("--"));
  let installed = false;
  if (!hasExplicitSubcommand && parsed.backend === null) {
    const probe = (options.probeInstallation ?? probeServiceInstallation)();
    if (probe.state === "unknown") {
      const suffix = probe.detail ? ` (${probe.detail})` : "";
      return {
        ok: false,
        message: `Could not safely determine whether the service is installed${suffix}. Run 'ocx service status' and retry; use explicit 'ocx service install' only after confirming it is absent.`,
      };
    }
    installed = probe.state === "installed";
  }
  return {
    ok: true,
    parsed,
    command: selectServiceSubcommand(parsed, { hasExplicitSubcommand, installed }),
  };
}

/**
 * `ocx service [sub] [--native|--scheduler]`. The first non-flag token is the
 * subcommand; backend flags are only meaningful for `install` (validated by the caller).
 */
export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  let sub: string | undefined;
  let backend: ServiceBackend | null = null;
  const invalid: string[] = [];
  for (const arg of args) {
    if (arg === "--native") {
      if (backend === "scheduler") { invalid.push("--native (conflicts with --scheduler)"); continue; }
      backend = "native";
    }
    else if (arg === "--scheduler") {
      if (backend === "native") { invalid.push("--scheduler (conflicts with --native)"); continue; }
      backend = "scheduler";
    }
    else if (arg.startsWith("--")) invalid.push(arg);
    else if (sub === undefined) sub = arg;
    else invalid.push(arg);
  }
  return { sub: normalizeServiceSubcommand(sub), backend, invalid };
}

export async function serviceCommand(...args: (string | undefined)[]): Promise<void> {
  const filteredArgs = args.filter((a): a is string => Boolean(a));
  const plan = planServiceCommand(filteredArgs);
  if (!plan.ok) {
    console.error(plan.message);
    process.exit(1);
  }
  const { parsed, command } = plan;
  if (command === "repair") {
    assertServiceEnvironmentMatchesInstall();
    assertServiceAuthEnvironment();
    await repairService();
    // All three platforms: a repair that reports success while nothing serves is the
    // defect class this unit exists to close. Windows bakes its port into the
    // scheduler wrapper or the WinSW XML, both of which installedServiceListenPort()
    // now reads.
    await reportServiceServing("repaired");
    return;
  }
  // Non-install subcommands follow the backend recorded at install time (state v2).
  const backend: ServiceBackend = parsed.backend ?? (process.platform === "win32" ? readServiceBackend() : "scheduler");
  const ops = platformOps(backend);
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (command) {
    case "install":
      assertServiceEnvironmentMatchesInstall();
      assertServiceAuthEnvironment();
      // A manually started proxy can still own the configured port while the service
      // registration is absent or unloaded. Stop both the registered manager and any
      // tracked standalone listener before loading the freshly written service assets.
      // Otherwise launchd/Task Scheduler can register successfully while its child
      // restart-loops on EADDRINUSE, and the old standalone process makes the install
      // verification report a false success.
      try {
        if (process.platform === "win32" && backend === "scheduler") {
          const scheduler = probeWindowsSchedulerTask(TASK);
          if (scheduler.status === "unknown") {
            throw new Error(`Task Scheduler state could not be verified before install: ${scheduler.detail}`);
          }
          if (scheduler.status === "absent") {
            await installFreshWindowsSchedulerSafely();
          } else {
            await installServiceSafely(backend, ops.install);
          }
        } else {
          await installServiceSafely(backend, ops.install);
        }
      } catch (error) {
        console.error(`❌ Service install cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        break;
      }
      // The wrapper was written moments ago in this process, so the configured port
      // and the baked one cannot have diverged yet — unlike `start`, which reads the
      // installed artifact instead.
      await reportServiceServing("installed", { port: resolveServiceListenPort() });
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      // Service users never reach the `ocx start` prompt: the proxy they run is the
      // supervised child, which always carries OCX_SERVICE=1. This command, though, is
      // hand-typed in a real terminal, so it is the one interactive moment they get.
      // Same one-time marker and same guards (TTY, gh auth, agent deferral) apply.
      await maybeShowStarPrompt();
      break;
    case "start":
      ops.start();
      await reportServiceServing("started");
      break;
    case "stop": {
      assertServiceEnvironmentMatchesInstall();
      // Only stop what is actually installed. The unguarded call ran a real `launchctl unload`
      // (and its Windows/Linux twins) even with nothing installed.
      if (ops.status() !== null || isServiceInstalled()) {
        ops.stop();
      }
      await stopTrackedProxyForServiceCommand();
      {
        // Verify rather than trust the stop command: a surviving wrapper respawns its child
        // seconds later, and restoring native Codex on top of a live proxy is the failure #764
        // reports as "stop reports success without stopping the proxy".
        const survivor = await proxyStillLiveAfterStop();
        if (survivor) {
          console.error(
            `❌ service stop did not take effect: a proxy is still listening on port ${survivor.port}.`
            + "\nNative Codex was NOT restored, because doing so while the proxy is running leaves"
            + " both pointing at each other. Check for a second service backend (`ocx service status`)"
            + " or a manually started proxy, then re-run `ocx service stop`.",
          );
          process.exitCode = 1;
          break;
        }
        const restore = await restoreNativeCodexAsync();
        if (restore.success) console.log("✅ service stopped + native Codex restored.");
        else console.error(`⚠️ service stopped, but native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` (or check $CODEX_HOME/config.toml) before using native Codex.`);
        // The Grok fence is the other managed config this command owns. Leaving it behind
        // pointed grok at a dead endpoint while native Codex was already restored.
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) console.error(`⚠️  ${grok.message}`);
      }
      break;
    }
    case "status": {
      if (process.platform === "win32" && backend === "scheduler") {
        console.log(await inspectWindowsSchedulerServiceStatus());
      } else {
        // Replaces raw `ops.status()` output, which on darwin is a `launchctl list`
        // line: registration reported as if it were service. serviceStatusReport
        // subsumes the not-installed case and adds the serving / stale-plist split.
        console.log(await serviceStatusReport());
      }
      console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
      break;
    }
    case "uninstall":
    case "remove":
      assertServiceEnvironmentMatchesInstall();
      try { ops.stop(); } catch (err) {
        console.warn(`⚠️  Service stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await stopTrackedProxyForServiceCommand();
      try {
        ops.uninstall();
      } catch (err) {
        console.error(`❌ Service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("The service may still be installed. Check with 'ocx service status' or remove manually.");
        process.exit(1);
      }
      {
        const restore = await restoreNativeCodexAsync();
        if (!restore.success) {
          console.error(`⚠️ native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` before using native Codex.`);
        }
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) console.error(`⚠️  ${grok.message}`);
      }
      removeServiceInstallState();
      try { if (existsSync(serviceApiTokenFilePath())) unlinkSync(serviceApiTokenFilePath()); } catch { /* best-effort */ }
      console.log("✅ service uninstalled.");
      break;
    default:
      console.error("Usage: ocx service [install|repair|restart|start|stop|status|uninstall|remove] [--native|--scheduler]");
      console.error("       With no subcommand, installs when absent or repairs/restarts an existing service.");
      console.error("       repair: refresh assets and restart an already-installed service (no admin re-prompt).");
      console.error("       restart: alias of repair.");
      console.error("       --native (Windows only): register a real SCM service via WinSW instead of Task Scheduler.");
      process.exit(1);
  }
}
