import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { durableBunPath } from "../lib/bun-runtime";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_PARENT_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
const TRAY_STATE_VERSION = 1;
const FOREIGN_RUN_VALUE = "<foreign-or-unreadable-registry-value>";

export interface WindowsTrayEntry {
  bun: string;
  cli: string;
  script: string;
  codexHome: string;
  opencodexHome: string;
}

interface WindowsTrayState extends WindowsTrayEntry {
  version: 1;
  launcherPath?: string;
  runValue: string;
  runCommand: string;
}

export interface WindowsTrayStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  stale: boolean;
  summary: string;
}

function trayStatePath(): string {
  return join(getConfigDir(), "tray-state.json");
}

function trayHeartbeatPath(): string {
  return join(getConfigDir(), "tray-heartbeat.json");
}

function installedTrayScriptPath(): string {
  return join(getConfigDir(), "opencodex-tray.ps1");
}

export function windowsTrayStatePathsOwned(
  state: Pick<WindowsTrayEntry, "script" | "opencodexHome"> & { launcherPath?: string },
  configDir = getConfigDir(),
): boolean {
  if (resolve(state.opencodexHome) !== resolve(configDir)) return false;
  if (resolve(state.script) !== resolve(join(configDir, "opencodex-tray.ps1"))) return false;
  return state.launcherPath === undefined
    || resolve(state.launcherPath) === resolve(join(configDir, "opencodex-tray.vbs"));
}

function sourceTrayScriptPath(): string {
  return join(import.meta.dir, "windows-tray.ps1");
}

function currentCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

function currentEntry(): WindowsTrayEntry {
  return {
    bun: durableBunPath(),
    cli: join(import.meta.dir, "..", "cli", "index.ts"),
    script: installedTrayScriptPath(),
    codexHome: currentCodexHome(),
    opencodexHome: getConfigDir(),
  };
}

export function windowsTrayRunValue(opencodexHome: string): string {
  const normalized = resolve(opencodexHome).replace(/[\\/]+$/, "").toLowerCase();
  return `OpenCodexTray-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export function windowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const candidate = join(
    systemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function registryExe(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return existsSync(candidate) ? candidate : "reg.exe";
}

function runRegistry(args: string[]): string {
  return execFileSync(registryExe(), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function safePath(value: string): string {
  if (/[\u0000-\u001f\"]/.test(value)) {
    throw new Error("Windows tray paths cannot contain quotes or control characters.");
  }
  return value;
}

export function windowsTrayProcessArgs(entry: WindowsTrayEntry, mode: "Run" | "Stop" = "Run", hostPid?: number): string[] {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", safePath(entry.script),
    "-BunPath", safePath(entry.bun),
    "-CliPath", safePath(entry.cli),
    "-CodexHome", safePath(entry.codexHome),
    "-OpenCodexHome", safePath(entry.opencodexHome),
    "-Mode", mode,
  ];
  if (Number.isSafeInteger(hostPid) && (hostPid ?? 0) > 0) args.push("-HostPid", String(hostPid));
  return args;
}

function quoteRunValue(value: string): string {
  safePath(value);
  return `\"${value}\"`;
}

/** Command persisted under HKCU Run. Every value is an owned absolute package/home path. */
export function buildWindowsTrayRunCommand(entry: WindowsTrayEntry, powershell = windowsPowerShellPath()): string {
  return [
    quoteRunValue(powershell),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", quoteRunValue(entry.script),
    "-BunPath", quoteRunValue(entry.bun),
    "-CliPath", quoteRunValue(entry.cli),
    "-CodexHome", quoteRunValue(entry.codexHome),
    "-OpenCodexHome", quoteRunValue(entry.opencodexHome),
    "-Mode", "Run",
  ].join(" ");
}

function readState(): WindowsTrayState | null {
  try {
    const state = JSON.parse(readFileSync(trayStatePath(), "utf8")) as Partial<WindowsTrayState>;
    if (state.version !== TRAY_STATE_VERSION) return null;
    for (const key of ["bun", "cli", "script", "codexHome", "opencodexHome", "runValue", "runCommand"] as const) {
      if (typeof state[key] !== "string" || state[key].length === 0) return null;
    }
    if (state.launcherPath !== undefined && typeof state.launcherPath !== "string") return null;
    const valid = state as WindowsTrayState;
    for (const value of [valid.bun, valid.cli, valid.script, valid.codexHome, valid.opencodexHome]) safePath(value);
    // State is advisory, not an authority for executable or deletion paths. In
    // particular, never let a forged state file redirect PowerShell -File.
    if (!windowsTrayStatePathsOwned(valid)) return null;
    if (valid.runValue !== windowsTrayRunValue(valid.opencodexHome)) return null;
    return valid;
  } catch {
    return null;
  }
}

function replaceOwnedFile(path: string, contents: string | Buffer): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  try {
    try { chmodSync(temporary, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") {
      const hardened = hardenSecretPath(temporary, { required: true });
      if (!hardened.ok) throw new Error("Windows tray ACL hardening did not complete; refusing to persist executable state.");
    }
    renameSync(temporary, path);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best-effort */ }
  }
}

function writeState(entry: WindowsTrayEntry, runValue: string, runCommand: string): void {
  const path = trayStatePath();
  replaceOwnedFile(path, JSON.stringify({ version: TRAY_STATE_VERSION, ...entry, runValue, runCommand }, null, 2) + "\n");
}

export function parseWindowsTrayRunValue(output: string, runValue: string): string | null {
  const escaped = runValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s+(\\S+)\\s*(.*)$`, "mi").exec(output);
  if (!match || match[1] !== "REG_SZ" || !match[2]?.trim()) return FOREIGN_RUN_VALUE;
  return match[2].trim();
}

export function windowsRegistryParentShowsRunKey(output: string): boolean {
  const expected = RUN_KEY.toLowerCase();
  return output.split(/\r?\n/).some(line => line.trim().toLowerCase()
    .replace(/^hkey_current_user\\/, "hkcu\\") === expected);
}

function syncRegistryAbsenceIsProven(): boolean {
  try {
    runRegistry(["query", RUN_KEY, "/reg:64"]);
    return true;
  } catch (runError) {
    if ((runError as { status?: unknown })?.status !== 1) return false;
    try {
      const parent = runRegistry(["query", RUN_PARENT_KEY, "/reg:64"]);
      return !windowsRegistryParentShowsRunKey(parent);
    } catch {
      return false;
    }
  }
}

function readOwnedRunValue(runValue = windowsTrayRunValue(getConfigDir())): string | null {
  try {
    const output = runRegistry(["query", RUN_KEY, "/v", runValue, "/reg:64"]);
    return parseWindowsTrayRunValue(output, runValue);
  } catch (error) {
    if ((error as { status?: unknown })?.status === 1) {
      // reg.exe also uses exit 1 for access/query failures. Only treat the
      // value as absent after proving Run is readable or does not exist under
      // a readable CurrentVersion parent.
      if (syncRegistryAbsenceIsProven()) return null;
    }
    throw new Error("Unable to verify the owned Windows tray registry value; refusing to change persistence.");
  }
}

function runRegistryAsync(args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(registryExe(), args, {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout.trim());
    });
  });
}

async function readOwnedRunValueAsync(runValue = windowsTrayRunValue(getConfigDir())): Promise<string | null> {
  try {
    const output = await runRegistryAsync(["query", RUN_KEY, "/v", runValue, "/reg:64"]);
    return parseWindowsTrayRunValue(output, runValue);
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 1) {
      try {
        await runRegistryAsync(["query", RUN_KEY, "/reg:64"]);
        return null;
      } catch (runError) {
        if (Number((runError as { code?: unknown }).code) === 1) {
          try {
            const parent = await runRegistryAsync(["query", RUN_PARENT_KEY, "/reg:64"]);
            if (!windowsRegistryParentShowsRunKey(parent)) return null;
          } catch { /* fall through to the fail-closed error */ }
        }
      }
    }
    throw new Error("Unable to verify Windows tray registry status.");
  }
}

function readHeartbeat(): { pid: number; hostPid?: number; timestamp: number } | null {
  try {
    const heartbeat = JSON.parse(readFileSync(trayHeartbeatPath(), "utf8").replace(/^\uFEFF/, "")) as { pid?: unknown; hostPid?: unknown; timestamp?: unknown };
    if (!Number.isSafeInteger(heartbeat.pid) || (heartbeat.pid as number) <= 0 || typeof heartbeat.timestamp !== "number") return null;
    const hostPid = Number.isSafeInteger(heartbeat.hostPid) && (heartbeat.hostPid as number) > 0 ? heartbeat.hostPid as number : undefined;
    return { pid: heartbeat.pid as number, hostPid, timestamp: heartbeat.timestamp };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function heartbeatProcessAlive(heartbeat = readHeartbeat()): boolean {
  return Boolean(heartbeat && processAlive(heartbeat.pid));
}

function heartbeatRunning(): boolean {
  const heartbeat = readHeartbeat();
  return Boolean(heartbeat && Date.now() - heartbeat.timestamp <= 15_000 && heartbeatProcessAlive(heartbeat));
}

function waitForHeartbeat(expected: boolean, timeoutMs = 8_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heartbeatRunning() === expected) return true;
    Bun.sleepSync(100);
  }
  return heartbeatRunning() === expected;
}

function waitForTrayExit(previous: ReturnType<typeof readHeartbeat>, timeoutMs = 15_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const powershellExited = !previous || !processAlive(previous.pid);
    const hostExited = !previous?.hostPid || !processAlive(previous.hostPid);
    if (!heartbeatProcessAlive() && powershellExited && hostExited) return true;
    Bun.sleepSync(100);
  }
  const powershellExited = !previous || !processAlive(previous.pid);
  const hostExited = !previous?.hostPid || !processAlive(previous.hostPid);
  return !heartbeatProcessAlive() && powershellExited && hostExited;
}

export function windowsTrayRegistrationIsStale(inputs: {
  registered: boolean;
  registrationOwned: boolean;
  running: boolean;
  heartbeatFresh: boolean;
}): boolean {
  if (!inputs.registered && inputs.running) return true;
  if (inputs.registered && !inputs.registrationOwned) return true;
  return inputs.running && !inputs.heartbeatFresh;
}

function trayStatusFrom(registered: string | null): WindowsTrayStatus {
  const state = readState();
  const heartbeat = readHeartbeat();
  const running = heartbeatProcessAlive(heartbeat);
  const registrationOwned = state !== null
    && registered === state.runCommand
    && [state.bun, state.cli, state.script].every(path => existsSync(path));
  const stale = windowsTrayRegistrationIsStale({
    registered: registered !== null,
    registrationOwned,
    running,
    heartbeatFresh: Boolean(heartbeat && Date.now() - heartbeat.timestamp <= 15_000),
  });
  const installed = registered !== null && state !== null && registered === state.runCommand && !stale;
  const summary = registered === null
    ? running ? "unregistered tray process is still running" : "not installed"
    : stale
      ? "startup registration is foreign, stale, or points to missing package files"
      : running
        ? "installed and running"
        : "installed, not currently running";
  return { supported: true, installed, running, stale, summary };
}

export function getWindowsTrayStatus(): WindowsTrayStatus {
  if (process.platform !== "win32") {
    return { supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` };
  }
  return trayStatusFrom(readOwnedRunValue());
}

export async function getWindowsTrayStatusAsync(): Promise<WindowsTrayStatus> {
  if (process.platform !== "win32") {
    return { supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` };
  }
  const runValue = windowsTrayRunValue(getConfigDir());
  const registered = await readOwnedRunValueAsync(runValue);
  return trayStatusFrom(registered);
}

function assertWindows(): void {
  if (process.platform !== "win32") throw new Error(`The opencodex tray is Windows-only (current platform: ${process.platform}).`);
}

function spawnTray(state: WindowsTrayEntry): void {
  const child = spawn(state.bun, [state.cli, "__tray-host"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      OCX_TRAY_ENTRY_B64: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
    },
  });
  child.unref();
}

function parseTrayHostEntry(): WindowsTrayEntry {
  const encoded = process.env.OCX_TRAY_ENTRY_B64;
  if (!encoded) throw new Error("Missing tray host entry.");
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Partial<WindowsTrayEntry>;
  for (const key of ["bun", "cli", "script", "codexHome", "opencodexHome"] as const) {
    if (typeof value[key] !== "string") throw new Error(`Invalid tray host field: ${key}`);
    safePath(value[key]);
  }
  return value as WindowsTrayEntry;
}

/** Detached Bun host keeps the attached WinForms PowerShell process alive. */
export async function runWindowsTrayHost(): Promise<void> {
  assertWindows();
  const entry = parseTrayHostEntry();
  delete process.env.OCX_TRAY_ENTRY_B64;
  const child = spawn(windowsPowerShellPath(), windowsTrayProcessArgs(entry, "Run", process.pid), {
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", code => {
      if (code && code !== 0) rejectPromise(new Error(`Windows tray host exited with code ${code}.`));
      else resolvePromise();
    });
  });
}

function signalTrayStop(): ReturnType<typeof readHeartbeat> {
  const previous = readHeartbeat();
  // The stop event name depends only on the current home. Never execute paths
  // recovered from tray-state.json while attempting cleanup or repair.
  execFileSync(windowsPowerShellPath(), windowsTrayProcessArgs(currentEntry(), "Stop"), {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
  });
  return previous;
}

export function installWindowsTray(startNow = true): WindowsTrayStatus {
  assertWindows();
  const entry = currentEntry();
  const sourceScript = sourceTrayScriptPath();
  for (const path of [entry.bun, entry.cli, sourceScript]) {
    if (!existsSync(path)) throw new Error(`Cannot install the tray because a required file is missing: ${path}`);
  }
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const runCommand = buildWindowsTrayRunCommand(entry);
  const runValue = windowsTrayRunValue(entry.opencodexHome);
  const existing = readOwnedRunValue(runValue);
  const state = readState();
  if (existing && (!state || existing !== state.runCommand)) {
    throw new Error(`Refusing to replace a foreign or unowned HKCU Run value named ${runValue}.`);
  }
  if (existsSync(entry.script) && (!state || resolve(state.script) !== resolve(entry.script))) {
    throw new Error(`Refusing to overwrite an unowned tray script at ${entry.script}.`);
  }
  const wasRunning = heartbeatProcessAlive();
  if (wasRunning && !state) {
    throw new Error("Refusing to replace an unowned running tray process. Exit it before installing.");
  }
  if (wasRunning && state) {
    const previous = signalTrayStop();
    if (!waitForTrayExit(previous)) throw new Error("The old tray did not exit; refusing to replace its persistent script.");
  }

  const previousStateBytes = existsSync(trayStatePath()) ? readFileSync(trayStatePath()) : null;
  const previousScriptBytes = existsSync(entry.script) ? readFileSync(entry.script) : null;
  const restorePreviousInstall = () => {
    try {
      if (previousScriptBytes) replaceOwnedFile(entry.script, previousScriptBytes);
      else if (existsSync(entry.script)) unlinkSync(entry.script);
    } catch { /* rollback best-effort */ }
    try {
      if (previousStateBytes) replaceOwnedFile(trayStatePath(), previousStateBytes);
      else if (existsSync(trayStatePath())) unlinkSync(trayStatePath());
    } catch { /* rollback best-effort */ }
    try {
      if (existing !== null) runRegistry(["add", RUN_KEY, "/v", runValue, "/t", "REG_SZ", "/d", existing, "/f", "/reg:64"]);
      else runRegistry(["delete", RUN_KEY, "/v", runValue, "/f", "/reg:64"]);
    } catch { /* rollback best-effort */ }
    if (wasRunning && state && !heartbeatRunning()) {
      try {
        spawnTray(currentEntry());
        waitForHeartbeat(true);
      } catch { /* retain the primary installation failure */ }
    }
  };

  try {
    const hardenedDir = hardenSecretDir(getConfigDir(), { required: true });
    if (!hardenedDir.ok) throw new Error("Windows tray directory ACL hardening did not complete; refusing to install persistence.");
    replaceOwnedFile(entry.script, readFileSync(sourceScript));
    runRegistry(["add", RUN_KEY, "/v", runValue, "/t", "REG_SZ", "/d", runCommand, "/f", "/reg:64"]);
    writeState(entry, runValue, runCommand);
  } catch (error) {
    restorePreviousInstall();
    throw error;
  }
  if (startNow && !heartbeatRunning()) spawnTray(entry);
  if (startNow && !waitForHeartbeat(true)) {
    restorePreviousInstall();
    throw new Error("The tray startup registration was installed, but the tray process did not become healthy.");
  }
  if (state?.launcherPath && existsSync(state.launcherPath)) {
    try { unlinkSync(state.launcherPath); } catch { /* old owned VBS is inert after a committed Run replacement */ }
  }
  return getWindowsTrayStatus();
}

export function startWindowsTray(): WindowsTrayStatus {
  assertWindows();
  const state = readState();
  if (!state || readOwnedRunValue(state.runValue) !== state.runCommand) throw new Error("The tray is not installed. Install it first.");
  // Persisted state proves registration ownership but never selects an
  // executable. Resolve every launch path from the running installation.
  if (!heartbeatRunning()) spawnTray(currentEntry());
  if (!waitForHeartbeat(true)) throw new Error("The tray process did not become healthy after launch.");
  return getWindowsTrayStatus();
}

export function stopWindowsTray(): WindowsTrayStatus {
  assertWindows();
  let previous = readHeartbeat();
  if (previous) {
    previous = signalTrayStop();
  }
  if (!waitForTrayExit(previous)) throw new Error("The tray did not exit after the stop signal. Its login registration was preserved.");
  return getWindowsTrayStatus();
}

export function uninstallWindowsTray(): WindowsTrayStatus {
  assertWindows();
  const state = readState();
  const existing = state ? readOwnedRunValue(state.runValue) : readOwnedRunValue();
  if (existing && (!state || existing !== state.runCommand)) {
    throw new Error(`Refusing to remove a foreign or unowned HKCU Run value named ${state?.runValue ?? windowsTrayRunValue(getConfigDir())}.`);
  }
  let previous = readHeartbeat();
  if (previous) {
    previous = signalTrayStop();
  }
  if (!waitForTrayExit(previous)) throw new Error("The tray did not exit; refusing to remove its owned registration or state.");
  if (existing) runRegistry(["delete", RUN_KEY, "/v", state?.runValue ?? windowsTrayRunValue(getConfigDir()), "/f", "/reg:64"]);
  const ownedPaths = [trayStatePath(), trayHeartbeatPath(), ...(state?.launcherPath ? [state.launcherPath] : [])];
  if (state?.script && resolve(state.script) === resolve(installedTrayScriptPath())) ownedPaths.push(state.script);
  for (const path of ownedPaths) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
  return getWindowsTrayStatus();
}

/** Update hook: refresh trusted paths and relaunch only when the tray was already installed. */
export function repairWindowsTrayIfInstalled(startNow = true): WindowsTrayStatus | null {
  if (process.platform !== "win32" || !readState()) return null;
  return installWindowsTray(startNow);
}

export async function windowsTrayCommand(args: string[]): Promise<void> {
  const wantsJson = args.includes("--json");
  const startNow = !args.includes("--no-start");
  const values = args.filter(value => value !== "--json" && value !== "--no-start");
  const sub = values[0] ?? "status";
  if (args.includes("--no-start") && sub !== "install" || values.length > 1 || !["install", "start", "stop", "status", "uninstall", "remove"].includes(sub)) {
    console.error("Usage: ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]");
    process.exitCode = 1;
    return;
  }
  try {
    const status = sub === "install" ? installWindowsTray(startNow)
      : sub === "start" ? startWindowsTray()
        : sub === "stop" ? stopWindowsTray()
          : sub === "uninstall" || sub === "remove" ? uninstallWindowsTray()
            : getWindowsTrayStatus();
    console.log(wantsJson ? JSON.stringify(status) : `Windows tray: ${status.summary}`);
  } catch (error) {
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    else console.error(`Windows tray error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
