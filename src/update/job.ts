import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteFile,
  getConfigDir,
  loadConfig,
} from "../config";
import {
  readPid,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  verifyPidIdentity,
} from "../config/process-state";
import { isProcessAlive, killProxy } from "../lib/process-control";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { killWindowsSchedulerWrappers } from "../lib/windows-service-wrappers";
import {
  buildWindowsElevatedArgumentList,
  resolveTrustedWindowsPowerShellExe,
} from "../lib/windows-elevation";
import { stopWinswService } from "../lib/winsw";
import { listListenPids, reclaimListenPort, scanListenPids, type ListenPidScan } from "../server/port-reclaim";
import { dropWindowsTcpRowsForLocalPort } from "../server/windows-tcp-drop";
import { isOpencodexHealthz, probeHostname, proxyIdentityAt, type HealthzIdentity } from "../server/proxy-liveness";
import { isServiceInstalled, isServiceViable, readServiceBackend, stopWindows } from "../service";
import {
  type Channel,
  type Installer,
  PKG,
  checkUpdatePackageIntegrity,
  currentVersion,
  defaultUpdateTag,
  detectInstall,
  latestVersion,
  updateCommand,
  updateCommandStr,
} from "./index";
import { isNewer } from "./notify";
import { isRealBunBinary } from "../lib/bun-binary-validator.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";
import {
  npmCachePreflightFailureMessage,
  runNpmCachePreflight,
  type NpmCachePreflightReason,
} from "./npm-cache-preflight.mjs";

const RELEASE_NOTES_URL = "https://github.com/lidge-jun/opencodex/releases/latest";
const UPDATE_JOB_FILENAME = "update-job.json";
const UPDATE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_HEALTH_TIMEOUT_MS = 30_000;
const RESTART_STABILITY_WINDOW_MS = 15_000;
/** Legacy active records did not persist a worker PID, so age is their only safe recovery signal. */
export const UPDATE_JOB_LEGACY_STALE_MS = 10 * 60_000;
/** How long update restart waits for the captured port to become bindable after stop. */
export const RESTART_PORT_RECLAIM_MS = 30_000;

export type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}

export interface UpdateJobState {
  id: string;
  status: UpdateJobStatus;
  startedAt: string;
  updatedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  restart: boolean;
  command: string;
  releaseNotesUrl: string;
  log: string[];
  pid?: number;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  restarted?: boolean;
}

export class UpdateJobError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "update_error") {
    super(message);
  }
}

export interface UpdateCheckDeps {
  currentVersion: () => string;
  detectInstall: () => Installer;
  latestVersion: (tag: Channel) => string | null;
}

interface UpdateWorkerProcess {
  pid?: number;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface StartUpdateJobDeps {
  checkForUpdateFn: (channel: Channel) => UpdateCheckResult;
  spawnWorkerFn: (jobId: string, channel: Channel, restart: boolean) => UpdateWorkerProcess;
  isProcessAliveFn: (pid: number) => boolean;
  nowMs: () => number;
}

const defaultCheckDeps: UpdateCheckDeps = {
  currentVersion,
  detectInstall,
  latestVersion,
};

function nodeBin(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * Strict bind script: exit 0 only after listen+close. Any listen error (including
 * Windows ghost-TCB failures under Bun) is busy — matches published `ocx start`
 * probes that treat every listen error as unavailable.
 */
function strictBindProbeScript(port: number, hostname: string): string {
  return [
    "const net=require('net');",
    "const s=net.createServer();",
    "s.once('error',()=>process.exit(2));",
    `s.listen(${Math.trunc(port)},${JSON.stringify(hostname)},()=>s.close(()=>process.exit(0)));`,
    "setTimeout(()=>process.exit(3),2500);",
  ].join("");
}

function spawnBindProbe(bin: string, script: string): boolean {
  try {
    const r = spawnSync(bin, ["-e", script], {
      windowsHide: true,
      timeout: 4000,
      stdio: "ignore",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Live global package Bun — not the npm rename tree the update worker may still
 * be executing from (`@bitkyc08/.opencodex-*`). Reject the tiny postinstall
 * stub so probes fall back to the worker runtime instead of failing forever.
 */
function livePackageBunPath(): string | null {
  const launcher = packageLauncherPath();
  const root = join(dirname(launcher), "..");
  for (const name of ["bun.exe", "bun"]) {
    const candidate = join(root, "node_modules", "bun", "bin", name);
    if (isRealBunBinary(candidate)) return candidate;
  }
  return null;
}

/**
 * Port is free for post-update `ocx start` only when the runtime that will
 * actually execute the start can bind. Prefer live package Bun; fall back to the
 * worker runtime. Do not require a separate `node` binary (Bun-only installs).
 */
async function strictRuntimePortAvailable(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  const script = strictBindProbeScript(port, hostname);
  const bun = livePackageBunPath();
  if (bun) return spawnBindProbe(bun, script);
  return spawnBindProbe(process.execPath, script);
}

/**
 * Wait until netstat reports no LISTEN owners on `port` AND the start runtime
 * can bind. Dead PIDs still appear as holders while the ghost TCB lives;
 * SetTcpEntry is a no-op without elevation (rc 317), so wait them out.
 */
async function waitForGhostListenClear(
  port: number,
  hostname: string,
  listPids: (port: number) => number[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  aliveFn: (pid: number) => boolean = isProcessAlive,
): Promise<{ ok: boolean; accessDenied: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let accessDenied = false;
  while (Date.now() < deadline) {
    const holders = listPids(port).filter(pid => pid !== process.pid);
    const liveHolders = holders.filter(pid => aliveFn(pid));
    // Never SetTcpEntry while a live process still owns the port (foreign or ocx).
    if (process.platform === "win32" && liveHolders.length === 0) {
      try {
        const drop = dropWindowsTcpRowsForLocalPort(port);
        if (drop.accessDenied > 0) accessDenied = true;
      } catch { /* best-effort */ }
    }
    if (holders.length === 0 && await strictRuntimePortAvailable(port, hostname)) {
      return { ok: true, accessDenied };
    }
    await sleep(500);
  }
  return { ok: false, accessDenied };
}

function packageLauncherPath(): string {
  // This module lives at src/update/job.ts — the launcher is <pkg-root>/bin/ocx.mjs.
  // After `npm install -g`, import.meta.url can still point at npm's renamed temp
  // tree (`@bitkyc08/.opencodex-*`). Prefer the live package path when that happens.
  const fromMeta = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ocx.mjs");
  if (!/[\\/]\.opencodex-/i.test(fromMeta) && existsSync(fromMeta)) return fromMeta;
  const live = fromMeta.replace(/[\\/]@bitkyc08[\\/]\.opencodex-[^\\/]+/i, `${sep}@bitkyc08${sep}opencodex`);
  if (live !== fromMeta && existsSync(live)) return live;
  return fromMeta;
}

function formatCommand(bin: string, args: string[]): string {
  return `${bin} ${args.join(" ")}`;
}

function manualSourceCommand(): string {
  return "git pull && bun install && bun run build:gui";
}

export function normalizeUpdateChannel(raw: string | null | undefined, current = currentVersion()): Channel {
  return raw === "latest" || raw === "preview" ? raw : defaultUpdateTag(current);
}

export function updateJobPath(): string {
  return join(getConfigDir(), UPDATE_JOB_FILENAME);
}

function ensureJobDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Describe external text without reproducing it.
 *
 * Use this wherever an `Error.message`, a vendor stream, or any string this module did not
 * compose would otherwise be interpolated into a persisted field. The result names the error's
 * TYPE and size — enough to tell a reader what class of failure occurred — and never its text,
 * which is where the paths and account names live.
 */
/**
 * A version string we are willing to repeat in a persisted field.
 *
 * Semver plus an optional prerelease/build tail, capped in length. Anything else is dropped
 * rather than logged: `/healthz` is answered by whatever holds the port, so its `version` is
 * external input on the same footing as an error message.
 */
function isVersionLike(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function withheldSummary(error: unknown): string {
  // `error.name` is writable, so it is external text like the message. A fixed classification
  // is the only part of an unknown error we can state without repeating something we were
  // handed: `new Error(...)` with `error.name = "Jane Doe"` was persisting the name verbatim.
  const name = error instanceof Error ? "Error" : typeof error;
  // NO MESSAGE TEXT, ever. An earlier version kept messages that carried no path, which sounds
  // reasonable and is wrong: `spawn denied for Jane Doe` has no path in it and still names a
  // person. There is no test on message CONTENT that separates a diagnostic from an identity,
  // so the message does not cross this boundary at all.
  const code = (error as { code?: unknown } | null)?.code;
  // Only recognized codes — an arbitrary uppercase `error.code` can be attacker-shaped too.
  const codeNote = typeof code === "string" && NPM_ERROR_CODES.has(code) ? ` ${code}` : "";
  const text = error instanceof Error ? error.message : String(error ?? "");
  // Node's own errors are structured the same way npm's output is: `syscall` and `errno` are
  // named properties, not prose. Reading those gives a user the actual cause —
  // `Error EACCES · syscall: mkdir · errno: -13` — without repeating a message that could name
  // a person or a path. Both are shape-validated: a syscall is a short lowercase identifier and
  // an errno is an integer, so neither can carry arbitrary text.
  const parts = [`${name}${codeNote}`];
  const syscall = (error as { syscall?: unknown } | null)?.syscall;
  // Same explicit vocabulary as the npm field: a shape check accepts `janedoe`.
  if (typeof syscall === "string" && POSIX_SYSCALLS.has(syscall)) parts.push(`syscall: ${syscall}`);
  const errno = (error as { errno?: unknown } | null)?.errno;
  if (typeof errno === "number" && Number.isInteger(errno)) parts.push(`errno: ${errno}`);
  parts.push(`${Buffer.byteLength(text, "utf8")} bytes withheld`);
  return parts.join(" · ");
}

/**
 * Decide, per field, whether the value is ours to keep.
 *
 * `log` and `error` are composed from this module's own templates; every place that would have
 * interpolated external text now calls `withheldSummary()` first, so the strings arriving here
 * are ours by construction. `releaseNotesUrl` is compared against the module constant rather
 * than pattern-matched, which is what stops a URL-shaped value from smuggling a path.
 * `command` is rendered from validated parts.
 */
function brandOwnComposedText(key: string, value: unknown): unknown {
  if (key === "releaseNotesUrl") {
    return value === RELEASE_NOTES_URL ? value : "";
  }
  if (key === "command") {
    // Render the command shape first, then apply the same path test as every other field. The
    // renderer only understands space-separated arguments; anything else reaching this field is
    // not a command we built and must not be trusted because of where it was stored.
    return typeof value === "string" ? withholdIfPathBearing(renderSafeCommand(value)) : value;
  }
  // `log` and `error` are ours by construction, but a caller can still slip external text in by
  // interpolating it. Withhold any value that carries an absolute path of any form — that is a
  // narrow, unambiguous test on strings we already control, not the free-text classification
  // that failed nine times.
  if (typeof value === "string") return withholdIfPathBearing(value);
  if (Array.isArray(value)) return value.map(item => (typeof item === "string" ? withholdIfPathBearing(item) : item));
  return value;
}

/** Absolute paths cannot appear in text this module composed; if one does, it came from outside. */
function withholdIfPathBearing(value: string): string {
  const pathBearing = /[A-Za-z]:[\\/]/.test(value)          // C:\ or C:/
    || /\\\\/.test(value)                                    // \\server\share
    || /\\/.test(value)                                      // any backslash
    || /~[\w.-]*\//.test(value)                              // ~/ or ~user/ anywhere
    || /[%$][A-Za-z_]/.test(value)                           // %APPDATA%, $HOME
    || /\/[\w.\-~%]+\//.test(value)                          // any two-segment path run
    || /\b(?:Users|home|Documents and Settings|AppData|Profiles)\b/i.test(value)
    || /\r?\n/.test(value);                                  // multi-line vendor output
  if (!pathBearing) return value;
  return `<withheld: ${Buffer.byteLength(value, "utf8")} bytes, may contain local paths>`;
}

/**
 * Keep a command readable without persisting the launcher path it contains.
 *
 * The real npm worker command is `node /Users/<name>/.../bin/ocx.mjs update --tag latest`, so
 * the account name is inside it by construction. Absolute path arguments are replaced with a
 * placeholder and everything else — the binary name, the flags, the tag — is kept, which is the
 * part a reader actually needs.
 */
function renderSafeCommand(value: string): string {
  if (!value) return value;
  // Rebuild from a recognized shape rather than filtering the string we were handed. Content
  // cannot distinguish `npm install Mary-Jane` — an account name — from a legitimate package
  // argument, so anything that is not this exact shape is withheld by the caller's path test.
  const parts = value.trim().split(/\s+/);
  const tool = parts[0] === "$" ? parts[1] : parts[0];
  if (tool !== undefined && /^(?:npm|bun|pnpm|yarn|node)$/.test(tool)) {
    const rendered = parts.map(part =>
      /^(?:[A-Za-z]:[\\/]|[\\/]|~|\\\\)/.test(part) ? "<path>" : part);
    // Only fixed flags, our own package spec, and placeholders survive; a bare word that is not
    // one of those is treated as unknown input and the whole value is withheld.
    const allowed = rendered.every(part =>
      part === "$" || part === "<path>"
      || /^(?:npm|bun|pnpm|yarn|node)$/.test(part)
      || /^-{1,2}[\w-]+$/.test(part)
      || /^(?:install|add|update|i)$/.test(part)
      || /^opencodex(?:@[\w.\-]+)?$/.test(part)
      || /^(?:latest|preview|next|beta)$/.test(part)
      || /^\d[\w.\-]*$/.test(part));
    if (allowed) return rendered.join(" ");
  }
  return `<withheld: ${Buffer.byteLength(value, "utf8")} bytes, unrecognized command shape>`;
}

/**
 * Fields that can carry free-form text and therefore need checking at the write boundary.
 *
 * The rest of the record is a closed vocabulary — statuses, channels, installers, versions, an
 * id, timestamps — so checking it only risks mangling values that were never a disclosure
 * route. Naming the risky fields keeps the boundary narrow and auditable.
 */
const FREE_TEXT_JOB_FIELDS = new Set(["command", "error", "log", "releaseNotesUrl"]);

/** Apply the per-field rule at the single point where a job reaches disk. */
function sanitizePersistedUpdateJob(job: UpdateJobState): UpdateJobState {
  return Object.fromEntries(
    Object.entries(job).map(([key, item]) => [
      key,
      FREE_TEXT_JOB_FIELDS.has(key) ? brandOwnComposedText(key, item) : item,
    ]),
  ) as UpdateJobState;
}

function writeJob(job: UpdateJobState): void {
  ensureJobDir();
  atomicWriteFile(updateJobPath(), `${JSON.stringify(sanitizePersistedUpdateJob(job), null, 2)}\n`);
}

export function readUpdateJob(jobId?: string | null): UpdateJobState | null {
  try {
    const parsed = JSON.parse(readFileSync(updateJobPath(), "utf8")) as UpdateJobState;
    if (jobId && parsed.id !== jobId) return null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Log lines are composed by this module, so brand them here rather than at nineteen call sites.
 *
 * The one thing a caller must never do is interpolate external text into a log line — an
 * `Error.message`, a vendor stream, a path we were handed. Those go through
 * `withheldSummary()`, which produces a branded description WITHOUT the text itself.
 */
function updateJob(job: UpdateJobState, patch: Partial<UpdateJobState>, logLine?: string): UpdateJobState {
  const current = readUpdateJob(job.id) ?? job;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    log: logLine ? [...current.log, logLine] : current.log,
  };
  writeJob(next);
  return next;
}

export function updateExecutionCommand(
  installer: Installer,
  channel: Channel,
  launcher = packageLauncherPath(),
  resolvedVersion?: string | null,
): { bin: string; args: string[]; display: string } {
  if (installer === "npm") {
    const bin = nodeBin();
    const args = [launcher, "update", "--tag", channel];
    // The Node launcher self-update re-resolves the tag at its own time — a residual
    // divergence window this path cannot close (documented, not claimed immutable).
    return { bin, args, display: formatCommand(bin, args) };
  }
  if (installer === "bun") {
    const command = updateCommand(installer, channel, resolvedVersion);
    const bin = process.platform === "win32" ? process.execPath : command.bin;
    const { args } = command;
    return { bin, args, display: updateCommandStr(installer, channel, resolvedVersion) };
  }
  return { bin: "sh", args: ["-lc", manualSourceCommand()], display: manualSourceCommand() };
}

export function restartCommand(
  serviceInstalled: boolean,
  installer: Installer,
  launcher = packageLauncherPath(),
  port?: number,
  serviceArgs?: string[],
): { mode: "service" | "proxy"; bin: string; args: string[]; display: string } {
  const mode = serviceInstalled ? "service" : "proxy";
  const pinPort = !serviceInstalled && typeof port === "number" && Number.isFinite(port) && port > 0;
  const startArgs = pinPort
    ? [launcher, "start", "--port", String(Math.trunc(port))]
    : [launcher, "start"];
  // Default to the in-place refresh: `install` always registers, while repair reuses a healthy
  // Windows scheduler definition and re-registers only when the live definition is stale.
  const svcArgs = serviceInstalled ? [launcher, ...(serviceArgs ?? ["service", "repair"])] : startArgs;
  if (installer === "npm") {
    const bin = nodeBin();
    const args = svcArgs;
    return { mode, bin, args, display: formatCommand(bin, args) };
  }
  // bun/source installs: restart via the current runtime executable + package launcher (both real
  // .exe files), NOT the `ocx.cmd` shim. Spawning a `.cmd` shell-less throws EINVAL on Windows
  // Node/Bun ≥18.20/20.12 (CVE-2024-27980 hardening) — the same class the npm path (nodeBin) avoids.
  const bin = process.execPath;
  const args = svcArgs;
  return { mode, bin, args, display: formatCommand(bin, args) };
}

export function checkForUpdate(
  requestedChannel?: Channel,
  deps: UpdateCheckDeps = defaultCheckDeps,
): UpdateCheckResult {
  const current = deps.currentVersion();
  const installer = deps.detectInstall();
  const channel = requestedChannel ?? normalizeUpdateChannel(null, current);
  const latest = installer === "source" ? null : deps.latestVersion(channel);
  const updateAvailable = !!latest && isNewer(latest, current, channel);
  let reason: string | undefined;
  let command = installer === "source" ? manualSourceCommand() : updateExecutionCommand(installer, channel).display;

  if (installer === "source") {
    reason = "source_checkout";
    command = manualSourceCommand();
  } else if (!latest) {
    reason = "latest_unavailable";
  } else if (!updateAvailable) {
    reason = "already_latest";
  }

  return {
    currentVersion: current,
    latestVersion: latest,
    channel,
    installer,
    updateAvailable,
    canUpdate: installer !== "source" && updateAvailable,
    command,
    releaseNotesUrl: RELEASE_NOTES_URL,
    ...(reason ? { reason } : {}),
  };
}

function newJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * [Decision Log]
 * - Purpose: recover dashboard updates after a detached worker dies without unlocking concurrent live updates.
 * - Existing constraints: legacy records have no PID, while a healthy update may legitimately run for minutes.
 * - Alternatives considered: clear every active record by age, or require operators to delete the file manually.
 * - Chosen approach: trust PID liveness first and use a conservative age limit only for legacy no-PID records.
 * - Why: age-only recovery can start two installers, while never recovering leaves the dashboard permanently blocked.
 * - Impact: live PID records remain locked regardless of age; dead PIDs recover immediately; legacy records recover after ten minutes.
 */
export function staleActiveUpdateJobReason(
  job: Pick<UpdateJobState, "status" | "pid" | "updatedAt">,
  now = Date.now(),
  isAlive: (pid: number) => boolean = isProcessAlive,
): string | null {
  if (job.status !== "running" && job.status !== "restarting") return null;
  if (typeof job.pid === "number" && Number.isSafeInteger(job.pid) && job.pid > 0) {
    return isAlive(job.pid) ? null : `update worker PID ${job.pid} is no longer running`;
  }
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAt) && now - updatedAt >= UPDATE_JOB_LEGACY_STALE_MS) {
    return "legacy active update record has no worker PID and exceeded the stale window";
  }
  return null;
}

/**
 * Spawn the GUI update worker without inheriting the proxy's LISTEN socket.
 *
 * On Windows, `spawn(..., { detached: true, stdio: "ignore" })` still inherits
 * inheritable handles — including Bun.serve's LISTEN socket. After stop-first
 * update kills the proxy PID, netstat keeps showing that dead PID as LISTENING
 * until every inheriting child exits. The update worker was that child, so the
 * port stayed busy for the whole job. Launch via PowerShell Start-Process so
 * the worker is a fresh process tree with no inherited LISTEN handle.
 */
export function spawnGuiUpdateWorker(
  jobId: string,
  channel: Channel,
  restart: boolean,
): UpdateWorkerProcess {
  const args = selfLaunchArgv([
    "__gui-update-worker",
    jobId,
    channel,
    restart ? "restart" : "no-restart",
  ]);
  if (process.platform !== "win32") {
    return spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OCX_SERVICE: "1" },
    });
  }

  // Single -ArgumentList string with CommandLineToArgvW quoting so paths with
  // spaces survive Start-Process's space-join (array elements lose outer quotes).
  const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const argumentList = buildWindowsElevatedArgumentList(args);
  const ps = [
    `$env:OCX_SERVICE = '1'`,
    `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argumentList)} -WindowStyle Hidden -PassThru`,
    `if (-not $p) { exit 1 }`,
    `Write-Output $p.Id`,
  ].join("; ");
  const launched = spawnSync(
    resolveTrustedWindowsPowerShellExe(),
    ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  const pid = Number(String(launched.stdout ?? "").trim().split(/\r?\n/).pop());
  if (launched.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    const detail = String(launched.stderr ?? launched.stdout ?? "").trim() || `status ${launched.status}`;
    throw new Error(`Windows update worker Start-Process failed: ${detail}`);
  }
  return {
    pid,
    unref() { /* Start-Process already detached */ },
    once() { /* startup errors are not wired across Start-Process */ },
  };
}

const defaultStartUpdateJobDeps: StartUpdateJobDeps = {
  checkForUpdateFn: channel => checkForUpdate(channel),
  spawnWorkerFn: spawnGuiUpdateWorker,
  isProcessAliveFn: isProcessAlive,
  nowMs: Date.now,
};

export function startUpdateJob(
  channel: Channel,
  restart: boolean,
  deps: Partial<StartUpdateJobDeps> = {},
): UpdateJobState {
  const resolvedDeps = { ...defaultStartUpdateJobDeps, ...deps };
  const running = readUpdateJob();
  if (running?.status === "running" || running?.status === "restarting") {
    const staleReason = staleActiveUpdateJobReason(
      running,
      resolvedDeps.nowMs(),
      resolvedDeps.isProcessAliveFn,
    );
    if (!staleReason) {
      throw new UpdateJobError("An update job is already running", 409, "update_already_running");
    }
    updateJob(
      running,
      { status: "failed", error: `Recovered stale update job: ${staleReason}.`, exitCode: null },
      `Recovered stale update job: ${staleReason}.`,
    );
  }

  const check = resolvedDeps.checkForUpdateFn(channel);
  if (!check.canUpdate) {
    throw new UpdateJobError(check.reason ?? "No update is available", 409, check.reason ?? "update_unavailable");
  }

  const id = newJobId();
  const now = new Date(resolvedDeps.nowMs()).toISOString();
  const job: UpdateJobState = {
    id,
    status: "running",
    startedAt: now,
    updatedAt: now,
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    channel: check.channel,
    installer: check.installer,
    restart,
    command: check.command,
    releaseNotesUrl: check.releaseNotesUrl,
    log: [`Update job queued for ${check.currentVersion} -> ${check.latestVersion}.`],
  };
  writeJob(job);

  let child: UpdateWorkerProcess;
  try {
    child = resolvedDeps.spawnWorkerFn(id, channel, restart);
  } catch (error) {
    updateJob(job, { status: "failed", error: `Could not start update worker: ${withheldSummary(error)}` }, "Update worker failed to start.");
    throw new UpdateJobError("Could not start update worker", 500, "update_worker_start_failed");
  }
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    updateJob(job, { status: "failed", error: "Could not start update worker: no worker PID was returned." }, "Update worker failed to start.");
    throw new UpdateJobError("Could not start update worker", 500, "update_worker_start_failed");
  }
  const startedJob = updateJob(job, { pid: child.pid }, `Update worker started as PID ${child.pid}.`);
  child.once("error", error => {
    const current = readUpdateJob(id);
    if (!current || current.pid !== child.pid || (current.status !== "running" && current.status !== "restarting")) return;
    updateJob(
      current,
      { status: "failed", error: `Update worker failed to start: ${withheldSummary(error)}` },
      "Update worker emitted a startup error.",
    );
  });
  child.unref();
  return startedJob;
}

/**
 * Run an update step and record WHAT HAPPENED, not what the tool printed.
 *
 * Raw installer output used to be persisted verbatim, which put local paths and account names
 * into a stored file. Six rounds of trying to sanitize it after the fact each produced a new
 * leak — a wrap inside the keyword, a wrap inside the account name, an indented continuation,
 * three consecutive wraps, an empty continuation line. Every fix was an attempt to reconstruct
 * arbitrary multi-line text well enough to match it, and that is not a problem a redactor can
 * win: the leak surface is whatever npm decides to print.
 *
 * So the raw stream is no longer persisted at all. The job keeps the command, its exit status,
 * and a bounded, structured summary — enough to tell a user which step failed and how, with no
 * free-form vendor text passing through the boundary. Detailed output stays ephemeral.
 */
function runLoggedCommand(job: UpdateJobState, bin: string, args: string[], timeout: number): { status: number | null; signal: NodeJS.Signals | null } {
  job = updateJob(job, {}, `$ ${formatCommand(bin, args)}`);
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const summary = summarizeCommandOutput(stdout, stderr, result.status, result.signal);
  if (summary) updateJob(job, {}, summary);
  return { status: result.status, signal: result.signal };
}

/**
 * Recognized npm/libc error codes, as an explicit set.
 *
 * A shape pattern like `E[A-Z]{3,}` is NOT a vocabulary: `C:\Users\ERROR\.npm` matches it, and
 * the summary then re-emits the username the withheld output was protecting. Only codes on this
 * list are surfaced, and only when they appear in npm's canonical `code <CODE>` position.
 */
const NPM_ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "EEXIST", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE",
  "ENOSPC", "EROFS", "EXDEV", "ELOOP", "ENAMETOOLONG", "ENOTEMPTY", "EBUSY",
  "EAGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EPROTO", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "E401", "E403", "E404", "E409", "E429", "E500", "E503",
  "EINTEGRITY", "ERESOLVE", "ETARGET", "EPUBLISHCONFLICT", "ENEEDAUTH",
  "EUSAGE", "EJSONPARSE", "EOTP", "EINVALIDTYPE", "ELIFECYCLE",
  "ERR_SOCKET_TIMEOUT", "ERR_INVALID_ARG_TYPE", "ERR_MODULE_NOT_FOUND",
]);

/** npm prints `npm ERR! code EACCES`; anchor on that position rather than scanning free text. */
const NPM_CODE_RECORD = /^\s*npm\s+ERR!\s+code\s+([A-Z][A-Z0-9_]{2,})\s*$/gm;

/**
 * npm's failure output is STRUCTURED, not prose: `npm error <field> <value>`, one field per
 * line (`npm ERR!` on npm 9 and earlier). That is what makes a useful summary possible without
 * reproducing text — we can read named fields and keep the ones whose value cannot be a path.
 *
 * Fields kept, with a real example of each:
 *   code     E404, EACCES, ETARGET      the single most useful line for diagnosis
 *   syscall  mkdir, open, getaddrinfo   what npm was doing
 *   errno    -13                        the OS errno
 *   notarget No matching version ...    version-resolution explanation, no path
 *   404      404 Not Found - GET <url>  registry URL, no local path
 *
 * Deliberately NOT kept: `path`, `dest`, `file`, `stack`, and the bare `Error: ...` line —
 * every one of those is a filesystem path by definition. `A complete log of this run can be
 * found in: <path>` is dropped for the same reason.
 */
const NPM_FIELD_LINE = /^\s*npm\s+(?:error|ERR!)\s+([a-z0-9]+)\s+(.*)$/gim;

/**
 * POSIX syscall names npm actually reports. An explicit vocabulary, not a shape.
 *
 * `^[a-z][a-z0-9_]{1,20}$` accepts `janedoe`, which is the whole problem: allowlisting the
 * FIELD NAME while leaving its VALUE free-form just moves the leak one level in.
 */
const POSIX_SYSCALLS = new Set([
  "open", "openat", "close", "read", "write", "stat", "lstat", "fstat", "mkdir", "rmdir",
  "unlink", "rename", "symlink", "readlink", "link", "chmod", "chown", "utimes", "access",
  "scandir", "readdir", "copyfile", "realpath", "futime", "ftruncate", "fchmod", "fchown",
  "connect", "getaddrinfo", "getnameinfo", "socket", "bind", "listen", "accept", "send",
  "recv", "shutdown", "spawn", "spawnSync", "kill", "watch", "lchown", "lutimes", "mkdtemp",
]);

/** Per-field value contracts. A field is only kept when its value satisfies its own rule. */
const KNOWN_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  "npm.pkg.github.com",
]);

const NPM_FIELD_VALIDATORS: Record<string, (value: string) => string | null> = {
  // A recognized code, nothing else.
  code: value => (NPM_ERROR_CODES.has(value) ? value : null),
  // A known syscall name, nothing else.
  syscall: value => (POSIX_SYSCALLS.has(value) ? value : null),
  // An integer, rendered from the parsed number so the original string never passes through.
  errno: value => (/^-?\d{1,10}$/.test(value) ? String(Number(value)) : null),
  // Version resolution: the FACT only.
  //
  // Two narrowing attempts failed here and the second is the instructive one. Extracting any
  // `name@version` also matched `jane.doe@example.com`. Pinning the NAME to our own package
  // still left the VERSION free: `@bitkyc08/opencodex@99.99.99-JaneDoe` is a valid-looking
  // spec, and a semver prerelease identifier can encode anything — the same lesson the
  // `/healthz` version taught in round 13.
  //
  // There is no trusted resolved version available at this call site, so the spec is not
  // rendered at all. `code: ETARGET` plus this fact already tells a user their requested
  // version does not exist, which is the diagnostic that matters.
  notarget: () => "no matching version",
};

/**
 * HTTP status lines carry a registry URL. Render it from parsed parts rather than echoing the
 * line: a URL can embed userinfo (`https://Jane:pw@host/`) or a path, and the raw text also
 * defeats the path test because `https:/` looks like a drive letter.
 */
function npmHttpStatusValue(field: string, value: string): string | null {
  const url = /\bhttps?:\/\/[^\s]+/.exec(value)?.[0];
  if (!url) return `HTTP ${field}`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return `HTTP ${field}`; }
  // Only hosts we can name in advance. A shape check (`^[\w.-]+$`) accepts
  // `janedoe.example`, a numeric host, or a punycode host — an arbitrary hostname is a
  // disclosure channel, not a diagnostic. Knowing it was the public registry versus "some
  // other host" is the part that helps, and that fits in an allowlist.
  return KNOWN_REGISTRY_HOSTS.has(parsed.hostname.toLowerCase()) && !parsed.username && !parsed.password
    ? `HTTP ${field} from ${parsed.hostname.toLowerCase()}`
    : `HTTP ${field}`;
}

/**
 * Extract the diagnostic fields npm names explicitly.
 *
 * Each kept value still passes `withholdIfPathBearing` before it is used: a registry URL is
 * fine, but `syscall` and friends are only safe by convention, and a convention is not a
 * guarantee. Values are length-capped so a hostile responder cannot pad the record.
 */
function npmDiagnosticFields(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(NPM_FIELD_LINE)) {
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (seen.has(field) || !value || value.length > 160) continue;
    // Every kept field is RENDERED from a validated value, never echoed. Allowlisting the field
    // name alone left the value free-form, so `npm error syscall janedoe` walked straight
    // through — the field was recognized and the value was never checked against anything.
    const validate = NPM_FIELD_VALIDATORS[field];
    const rendered = validate
      ? validate(value)
      : (/^(?:404|401|403|409|429)$/.test(field) ? npmHttpStatusValue(field, value) : null);
    if (rendered === null) continue;
    seen.set(field, rendered);
  }
  return [...seen].map(([field, value]) => `${field}: ${value}`);
}

/**
 * Build a structured, path-free summary of a command's result.
 *
 * Only three things cross the boundary: how the process ended, how much it printed, and any
 * recognized error codes. None of those can carry a filesystem path or an account name.
 */
export function summarizeCommandOutput(
  stdout: string,
  stderr: string,
  status: number | null,
  signal: NodeJS.Signals | null,
): string | null {
  if (!stdout && !stderr && status === 0) return null;

  const parts: string[] = [];
  parts.push(signal ? `terminated by ${signal}` : `exit ${status ?? "null"}`);

  // Read npm's own named fields rather than reproducing its text. This is what makes a failed
  // update diagnosable again: `code: E404 · 404: 404 Not Found - GET https://registry...` tells
  // a user exactly what happened, and none of it can be a local path.
  const fields = npmDiagnosticFields(`${stderr}\n${stdout}`);
  if (fields.length > 0) parts.push(...fields);

  const bytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
  if (bytes > 0) {
    parts.push(fields.length > 0
      ? `${bytes} bytes of full output withheld`
      : `${bytes} bytes of output withheld (no recognized diagnostic fields)`);
  }

  return parts.join(" · ");
}

/**
 * Tear down anything that would make `ocx start` exit 1 with "already running"
 * (service wrapper respawn, stale pidfile + live /healthz) before a pinned spawn.
 */
function preparePortForPinnedStart(
  job: UpdateJobState,
  port: number,
  listPids: (port: number) => number[],
  aliveFn: (pid: number) => boolean,
  verifyOcx: (pid: number) => number | null = verifyPidIdentity,
): void {
  stopWindowsServiceWrappersBestEffort();
  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Clearing pre-start proxy PID ${pid} before pinned start.`);
    try { killProxy(pid); } catch { /* best-effort */ }
    removePid(pid);
  } else {
    removePid();
  }
  removeRuntimePort();
  for (const holder of listPids(port)) {
    if (holder === process.pid || !aliveFn(holder)) continue;
    if (verifyOcx(holder) !== holder) {
      updateJob(
        job,
        {},
        `Leaving foreign listen holder PID ${holder} on port ${port}; refusing collateral kill.`,
      );
      continue;
    }
    updateJob(job, {}, `Stopping live ocx listen holder PID ${holder} on port ${port} before pinned start.`);
    try { killProxy(holder); } catch { /* best-effort */ }
  }
  // Match reclaimListenPort: never SetTcpEntry while a live holder remains.
  const liveRemain = listPids(port).filter(pid => pid !== process.pid && aliveFn(pid));
  if (process.platform === "win32" && liveRemain.length === 0) {
    try { dropWindowsTcpRowsForLocalPort(port); } catch { /* best-effort */ }
  }
}

function spawnDetachedStart(
  job: UpdateJobState,
  installer: Installer,
  port?: number,
): ChildProcess {
  const cmd = restartCommand(false, installer, packageLauncherPath(), port);
  const env = { ...process.env };
  delete env.OCX_SERVICE;
  updateJob(job, {}, `$ ${cmd.display}`);
  let stdio: "ignore" | [ "ignore", number, number ] = "ignore";
  let logFd: number | undefined;
  try {
    const logPath = join(getConfigDir(), "update-pinned-start.log");
    mkdirSync(getConfigDir(), { recursive: true });
    logFd = openSync(logPath, "a");
    writeSync(logFd, `\n--- ${new Date().toISOString()} ---\n$ ${cmd.display}\n`);
    stdio = ["ignore", logFd, logFd];
  } catch { /* fall back to ignored stdio */ }
  const child = spawn(cmd.bin, cmd.args, {
    detached: true,
    stdio,
    windowsHide: true,
    env,
  });
  child.once("error", err => {
    try {
      updateJob(job, {}, `Pinned start spawn error: ${withheldSummary(err)}`);
    } catch { /* best-effort */ }
  });
  // Foreground `ocx start` keeps the listen process; EADDRINUSE/ghost races exit quickly
  // with stdio ignored — surface that so the job log explains a silent miss.
  child.once("exit", (code, signal) => {
    if (code === 0 && !signal) return;
    try {
      updateJob(
        job,
        {},
        `Pinned start exited early (code=${code ?? "null"} signal=${signal ?? "null"}).`,
      );
    } catch { /* best-effort */ }
  });
  child.unref();
  return child;
}

/** Identity snapshot used to prove an npm self-update actually replaced the pre-update process. */
export interface RestartProxyIdentity {
  pid: number | null;
  version?: string;
}

/** Test seam: the wait/spawn pair is injectable so the restart path is verifiable. */
export interface RestartIo {
  waitForPort?: typeof reclaimListenPort;
  spawnStart?: (job: UpdateJobState, installer: Installer, port?: number) => void;
  serviceInstalledFn?: () => boolean;
  /**
   * After a service reinstall exits 0, only trust the service path when this is true.
   * Defaults to {@link isServiceViable} — installed-but-stale assets must fall through
   * to a direct proxy start so dashboard updates never leave /healthz dead.
   */
  serviceViableFn?: () => boolean;
  probeProxy?: (port: number, hostname?: string) => Promise<boolean>;
  /** Richer /healthz read for update-correlated restart evidence (pid + version). */
  probeProxyIdentity?: (port: number, hostname?: string) => Promise<RestartProxyIdentity | null>;
  /** Override the /healthz appearance window (default {@link RESTART_HEALTH_TIMEOUT_MS}). */
  healthTimeoutMs?: number;
  /**
   * Override the window for deciding whether a service-managed restart actually
   * served (default {@link SERVICE_RECOVERY_HEALTH_MS}). Distinct from
   * {@link healthTimeoutMs}, which is the FINAL /healthz appearance window consumed
   * by awaitRestartedProxyHealthy: this one only chooses whether to ALSO attempt a
   * direct start, so coupling them would let a test tightening one silently retune
   * the other.
   */
  serviceHealthTimeoutMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam — defaults to process.platform so the Windows-only branch is reachable off Windows. */
  platform?: NodeJS.Platform;
  /** Service-mode install/reinstall command (defaults to spawnSync via runLoggedCommand). */
  runService?: (
    job: UpdateJobState,
    bin: string,
    args: string[],
  ) => { status: number | null; signal?: NodeJS.Signals | null };
  /** Override the explicit restart path (used by finishGuiUpdateRestart tests). */
  restartAfterUpdateFn?: (
    job: UpdateJobState,
    captured?: { port: number; hostname: string; oldPid?: number },
    io?: RestartIo,
  ) => Promise<void>;
  /**
   * PIDs currently LISTENing on the captured port. Used to widen the post-update
   * kill allowlist beyond the pre-update PID (Windows often leaves a respawned
   * ocx child that would otherwise be treated as a protected listener).
   */
  listListenPidsFn?: (port: number) => number[];
  /**
   * Full listen-PID scan (ok/fail). When omitted, {@link scanListenPids} is used
   * so a probe failure is not mistaken for "no listeners".
   */
  scanListenPidsFn?: (port: number) => ListenPidScan;
  /** Identity check for listeners discovered via {@link listListenPidsFn}. */
  verifyOcxFn?: (pid: number) => number | null;
  /** Liveness check when deciding whether a reclaim timeout still has live holders. */
  isAliveFn?: (pid: number) => boolean;
}

/**
 * Health window for deciding whether a service-managed restart served, before
 * falling back to a direct start. Deliberately shorter than the final verdict
 * window: being wrong here costs one extra start attempt; being wrong the other way
 * leaves the user with no proxy at all.
 *
 * It runs AFTER the child's own 20s install probe (SERVICE_INSTALL_HEALTH_MS on
 * macOS/Linux), so a reinstall that exits 0 but never serves spends up to 45s before
 * the fallback — inside RESTART_TIMEOUT_MS of 60s. That is why this is 25s, not more.
 */
export const SERVICE_RECOVERY_HEALTH_MS = 25_000;

/**
 * Whether the reinstalled service actually produced a listener on the captured target.
 *
 * Not a duplicate of the child's own check: since WP2 the child asserts the port on
 * macOS/Linux, but Windows still reports success from registration alone, a flapping
 * supervisor can satisfy a single probe, and the child may be a CLI older than that
 * change. `isServiceViable()` cannot see any of those — it reads registration state.
 */
async function serviceRestartServed(
  job: UpdateJobState,
  port: number,
  hostname: string,
  io: RestartIo = {},
): Promise<boolean> {
  const probe = io.probeProxy ?? (async (p: number, h?: string) => (
    !!(await proxyIdentityAt(p, { hostname: h }))
  ));
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = io.now ?? (() => Date.now());
  const deadline = now() + (io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Service-managed proxy answered on ${hostname}:${port}.`);
      return true;
    }
    if (now() >= deadline) return false;
    await sleep(500);
  }
}

async function restartAfterUpdate(
  job: UpdateJobState,
  captured?: { port: number; hostname: string; oldPid?: number },
  io: RestartIo = {},
): Promise<void> {
  const serviceInstalled = (io.serviceInstalledFn ?? isServiceInstalled)();
  const config = loadConfig();
  // The stop-first update flow has already cleared pid/runtime state by the time we run,
  // so the pre-update capture (taken before the update command) is the authoritative
  // port to wait on; config is only the cold-start fallback.
  const port = captured?.port ?? config.port ?? 10100;
  const hostname = captured?.hostname ?? config.hostname ?? "127.0.0.1";
  const oldPid = typeof captured?.oldPid === "number" && captured.oldPid > 0
    ? captured.oldPid
    : undefined;
  let svcArgs: string[] | undefined;
  if (serviceInstalled) {
    try {
      const { serviceReinstallArgs } = await import("../service");
      svcArgs = serviceReinstallArgs();
    } catch { /* fallback to default service install */ }
  }
  const cmd = restartCommand(serviceInstalled, job.installer, packageLauncherPath(), port, svcArgs);
  const waitFn = io.waitForPort ?? reclaimListenPort;
  const listPids = io.listListenPidsFn ?? listListenPids;
  const verifyOcx = io.verifyOcxFn ?? verifyPidIdentity;
  const aliveFn = io.isAliveFn ?? isProcessAlive;
  // Pre-update PID plus any ocx still LISTENing on the captured port. After a
  // stop-first npm self-update Windows often leaves a respawned bun/node child
  // that is not the captured PID; treating it as protected blocks reclaim and
  // the direct-start fallback never binds.
  const reclaimKillAllowlist = (): number[] => {
    const allow = new Set<number>();
    if (oldPid != null) allow.add(oldPid);
    for (const pid of listPids(port)) {
      if (pid === process.pid) continue;
      if (verifyOcx(pid) === pid) allow.add(pid);
    }
    return [...allow];
  };
  const reclaimOptsFor = (onlyKillPids: number[]) => ({
    timeoutMs: RESTART_PORT_RECLAIM_MS,
    intervalMs: 100,
    scanIntervalMs: 500,
    killOcxHolders: true,
    // Windows scheduler wrappers can mint a *new* bun PID during the wait; keep
    // killing every ocx listener on this port, not only the pre-wait snapshot.
    // npm rename trees under `@bitkyc08/.opencodex-*` are classified as ocx by
    // isOcxStartCommandLine — never kill unknown foreign claimants on this port.
    killAllOcxOnPort: true,
    onlyKillPids,
  });

  if (serviceInstalled) {
    // schtasks /end often leaves the hidden cmd/wscript wrapper alive; its :loop
    // respawns `ocx start` a few seconds later and races port reclaim. End the
    // task again and best-effort kill those wrappers before we touch the socket.
    stopWindowsServiceWrappersBestEffort();
    // Stop-first update already unloaded the service; reclaim the socket, then
    // reinstall wrappers that bake `--port`.
    const preServiceAllow = reclaimKillAllowlist();
    const freed = await waitFn(port, hostname, reclaimOptsFor(preServiceAllow));
    let skipServiceInstall = false;
    // This skip existed because refresh ran `ocx service install`, whose Windows path always
    // registers. `service repair` normally reuses the live task and can refresh a stale
    // definition through its guarded create/elevation path, so the install-only skip no longer
    // applies and would leave the common dashboard update with stale service assets.
    //
    // Only a caller that still passes install argv keeps the old behavior.
    const refreshRegisters = (svcArgs ?? []).includes("install");
    if ((io.platform ?? process.platform) === "win32" && process.env.OCX_SERVICE === "1" && refreshRegisters) {
      updateJob(job, {}, "Skipping service re-registration from the non-elevated update worker; falling back to a direct proxy start.");
      skipServiceInstall = true;
    }
    if (!freed && !skipServiceInstall) {
      updateJob(
        job,
        {},
        `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s; refusing to hop — reinstall may fail until the port is free.`
          + ` ${formatPortHolders(port, listPids, verifyOcx, preServiceAllow)}`,
      );
      const liveScan: ListenPidScan = io.scanListenPidsFn
        ? io.scanListenPidsFn(port)
        : io.listListenPidsFn
          // Test seam: an injected list represents a successful scan.
          ? { ok: true, pids: io.listListenPidsFn(port) }
          : scanListenPids(port);
      const liveAfter = liveScan.ok
        ? liveScan.pids.filter(pid => pid !== process.pid && aliveFn(pid))
        : null;
      if (liveAfter !== null && liveAfter.length === 0) {
        // Non-elevated `service install` will UAC-fail anyway; skip straight to
        // the direct-start fallthrough instead of burning another minute on it.
        updateJob(job, {}, "Skipping service reinstall after reclaim timeout with no live holders; falling back to a direct proxy start.");
        skipServiceInstall = true;
      }
    }
    if (!skipServiceInstall) {
      const prevBake = process.env.OCX_BAKE_PORT;
      process.env.OCX_BAKE_PORT = String(Math.trunc(port));
      let serviceOk = false;
      try {
        const run = io.runService ?? ((j, bin, args) => runLoggedCommand(j, bin, args, RESTART_TIMEOUT_MS));
        const result = run(job, cmd.bin, cmd.args);
        serviceOk = result.status === 0;
        if (!serviceOk) {
          // The refresh that just failed was `ocx service repair` (serviceReinstallArgs).
          // It normally reuses a healthy registration, but a stale definition may have tried
          // guarded re-registration/elevation. Advising `install` here would unconditionally
          // send the user to re-registration — a UAC prompt on
          // Windows and a possible WinSW-to-scheduler backend switch — to fix a service
          // that is already registered. Point at the same command that failed so its
          // output explains why, on every platform.
          updateJob(
            job,
            {},
            `Service refresh failed (exit ${result.status ?? "?"}); falling back to a direct proxy start.`
            + " Run 'ocx service repair' by hand to see the reason, then 'ocx service status'.",
          );
        }
      } finally {
        if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
        else process.env.OCX_BAKE_PORT = prevBake;
      }
      if (serviceOk) {
        // Exit 0 is not enough, and neither is `viable`. Registration state cannot
        // distinguish a serving supervisor from one that registered and bound nothing:
        // `launchctl list` reports both, and `schtasks` reports a task whose child
        // exited immediately. Since WP2 the child asserts the port itself on
        // macOS/Linux, but Windows still reports success from registration alone, a
        // flapping supervisor can satisfy one probe, and the child may be an older CLI.
        // Ask the port before skipping the fallback this branch exists to protect.
        const viable = (io.serviceViableFn ?? isServiceViable)();
        if (viable) {
          if (await serviceRestartServed(job, port, hostname, io)) return;
          updateJob(
            job,
            {},
            `Service reinstall exited 0 and reported viable, but nothing answered on ${hostname}:${port} `
            + `within ${Math.trunc((io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS) / 1000)}s; `
            + "falling back to a direct proxy start.",
          );
        } else {
          updateJob(
            job,
            {},
            "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
          );
        }
      }
    }
    // Fall through to the direct proxy start below so the update never leaves the
    // proxy stopped when the service reinstall could not run or did not leave a
    // viable supervisor.
  }

  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Stopping current proxy PID ${pid}.`);
    try {
      killProxy(pid);
    } catch {
      // A PID that resists taskkill must not abort recovery: reclaim + pinned start
      // below are the path that repairs stuck Windows listeners.
    }
  }
  if (serviceInstalled) stopWindowsServiceWrappersBestEffort();
  // Reclaim the captured port before the pinned start. Spawning `--port` while the old
  // socket is still busy is how Windows updates used to fail health checks (or hop).
  // killAllOcxOnPort covers wrapper-respawned bun PIDs minted during the wait.
  const directAllow = reclaimKillAllowlist();
  const freed = await waitFn(port, hostname, reclaimOptsFor(directAllow));
  if (!freed) {
    const liveHolders = listPids(port).filter(pid => pid !== process.pid && aliveFn(pid));
    updateJob(
      job,
      {},
      `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s (reclaim could not free the socket).`
        + ` ${formatPortHolders(port, listPids, verifyOcx, directAllow)}`,
    );
    if (liveHolders.length > 0) {
      updateJob(job, {}, `Live holder(s) remain on port ${port}; not starting on another port. Retry 'ocx start --port ${port}'.`);
      return;
    }
    // Dead PIDs can still own LISTEN rows. SetTcpEntry needs elevation (rc 317 on a
    // normal update worker), so poll until netstat is empty and the start runtime can bind.
    updateJob(
      job,
      {},
      `No live holders on port ${port}; waiting for ghost LISTEN rows to clear before pinned start.`,
    );
    // Injected spawnStart is the unit-test seam — skip the long OS wait.
    if (!io.spawnStart) {
      const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
      const cleared = await waitForGhostListenClear(port, hostname, listPids, 90_000, sleep);
      if (cleared.accessDenied) {
        updateJob(job, {}, "SetTcpEntry is non-elevated (access denied); relying on OS ghost-LISTEN expiry.");
      }
      if (!cleared.ok) {
        updateJob(
          job,
          {},
          `Ghost LISTEN rows on port ${port} did not clear in time. `
            + `${formatPortHolders(port, listPids, verifyOcx, directAllow)} `
            + `Retry 'ocx start --port ${port}'.`,
        );
        return;
      }
    }
  }
  // Injected spawnStart keeps unit tests deterministic (one call). Production path
  // retries on missing /healthz after prepare + ghost-LISTEN clear.
  if (io.spawnStart) {
    io.spawnStart(job, job.installer, port);
    return;
  }
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = io.probeProxy ?? (async (p: number, host?: string) => (
    !!(await proxyIdentityAt(p, { hostname: host }))
  ));
  const probeIdentity = io.probeProxyIdentity ?? defaultProbeProxyIdentity;
  const expectedVersion = typeof job.latestVersion === "string" && job.latestVersion.length > 0
    ? job.latestVersion
    : null;
  // Service wrappers can respawn a listener during reclaim; if it already reports the
  // update target version, do not spawn a second start that exits "already running".
  {
    const identity = await probeIdentity(port, hostname);
    if (identity && expectedVersion && identity.version === expectedVersion) {
      updateJob(
        job,
        {},
        `Proxy already healthy on ${hostname}:${port} at ${expectedVersion}; skipping pinned start.`,
      );
      return;
    }
  }
  const attempts = 3;
  // Longer than published hard-pin reclaim (30s) so a slow start can still report healthy.
  const perAttemptHealthMs = 70_000;
  let lastChild: ChildProcess | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      updateJob(
        job,
        {},
        `Pinned start attempt ${attempt - 1} did not become healthy on port ${port}; `
          + `retrying (${attempt}/${attempts}).`,
      );
      if (lastChild?.pid && aliveFn(lastChild.pid)) {
        try { killProxy(lastChild.pid); } catch { /* best-effort */ }
      }
      lastChild = null;
    }
    preparePortForPinnedStart(job, port, listPids, aliveFn, verifyOcx);
    const ready = await waitForGhostListenClear(
      port,
      hostname,
      listPids,
      attempt === 1 ? (freed ? 15_000 : 5_000) : 30_000,
      sleep,
    );
    if (!ready.ok) {
      updateJob(
        job,
        {},
        `Port ${port} not bindable before pinned start attempt ${attempt}; `
          + `${formatPortHolders(port, listPids, verifyOcx, directAllow)}`,
      );
      continue;
    }
    lastChild = spawnDetachedStart(job, job.installer, port);
    const healthDeadline = Date.now() + perAttemptHealthMs;
    while (Date.now() < healthDeadline) {
      if (await probe(port, hostname)) return;
      await sleep(500);
    }
  }
  // Exhausted retries: do not leave a hung pinned-start child owning the port.
  if (lastChild?.pid && aliveFn(lastChild.pid)) {
    try { killProxy(lastChild.pid); } catch { /* best-effort */ }
  }
}

/** Compact listen-holder summary for update-job logs when reclaim fails. */
function formatPortHolders(
  port: number,
  listPids: (port: number) => number[],
  verifyOcx: (pid: number) => number | null,
  allow: number[],
): string {
  const allowSet = new Set(allow);
  const holders = listPids(port).map(pid => {
    const tags = [
      verifyOcx(pid) === pid ? "ocx" : "foreign",
      allowSet.has(pid) ? "allow" : "deny",
      isProcessAlive(pid) ? "live" : "dead",
    ];
    return `${pid}(${tags.join(",")})`;
  });
  return `holders=[${holders.join(", ") || "none"}] allow=[${allow.join(", ") || "none"}]`;
}

/** Stop the installed Windows backend and best-effort kill surviving :loop wrappers. */
function stopWindowsServiceWrappersBestEffort(): void {
  if (process.platform !== "win32") return;
  try {
    if (readServiceBackend() === "native") {
      stopWinswService();
      return;
    }
    stopWindows();
  } catch { /* already stopped */ }
  killWindowsServiceWrapperProcesses();
}

/**
 * Best-effort termination of surviving Windows scheduler launcher/wrapper processes.
 * `schtasks /end` ends the task instance but often leaves wscript/cmd running the
 * `:loop` batch, which brings the proxy back during post-update reclaim.
 *
 * This used to match the bare filenames with -like '*name*', which could stop a
 * wrapper belonging to a DIFFERENT OpenCodex home under the same account. The
 * shared killer scopes to this home's canonical paths as complete tokens.
 */
function killWindowsServiceWrapperProcesses(): void {
  killWindowsSchedulerWrappers({
    scriptPath: join(getConfigDir(), "opencodex-service.cmd"),
    launcherPath: join(getConfigDir(), "opencodex-service-launcher.vbs"),
  });
}

/** Exposed for tests: drives the non-service restart path with injected io. */
export function restartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  io: RestartIo,
): Promise<void> {
  return restartAfterUpdate(job, captured, io);
}

function restartFailureHint(port: number): string {
  return `Update installed, but the restarted proxy did not stay healthy on port ${port}. `
    + `Try 'ocx start --port ${port}'. `
    + "If the update log shows bun postinstall or EPERM warnings, "
    + "reinstall with 'npm install -g --allow-scripts=bun @bitkyc08/opencodex'.";
}

type AwaitHealthyResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "flapped" };

/**
 * Wait for an identity-checked /healthz on the captured listen target, then require a short
 * stability window. Soft: never marks the job failed (callers decide whether to fail or retry).
 */
async function awaitRestartedProxyHealthy(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo = {},
): Promise<AwaitHealthyResult> {
  // Fresh post-update starts are busy with catalog sync / OAuth; a single 750ms
  // /healthz miss must not fail the job. Use a longer probe and tolerate brief blips.
  const probe = io.probeProxy ?? (async (port: number, hostname?: string) => (
    !!(await proxyIdentityAt(port, { hostname }, { timeoutMs: 2_000, attempts: 3 }))
  ));
  const sleep = io.sleepMs ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  const now = io.now ?? (() => Date.now());
  const port = captured.port;
  const hostname = captured.hostname;
  const startDeadline = now() + (io.healthTimeoutMs ?? RESTART_HEALTH_TIMEOUT_MS);
  /** Consecutive failed probes before the stability window counts as a flap. */
  const stabilityMissLimit = 3;

  while (true) {
    // Always make one identity-aware probe at or after the boundary. A replacement
    // becoming healthy on the final tick must not be mistaken for a timeout.
    const finalProbe = now() >= startDeadline;
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Proxy reported healthy on ${hostname}:${port}; confirming it stays up...`);
      const stableUntil = now() + RESTART_STABILITY_WINDOW_MS;
      let misses = 0;
      while (now() < stableUntil) {
        if (await probe(port, hostname)) {
          misses = 0;
        } else {
          misses += 1;
          if (misses >= stabilityMissLimit) {
            updateJob(job, {}, `Proxy became unhealthy on ${hostname}:${port} during the stability window.`);
            return { ok: false, reason: "flapped" };
          }
        }
        await sleep(500);
      }
      updateJob(job, {}, `Proxy stayed healthy for ${Math.trunc(RESTART_STABILITY_WINDOW_MS / 1000)}s after restart.`);
      return { ok: true };
    }
    if (finalProbe) break;
    await sleep(Math.min(250, Math.max(0, startDeadline - now())));
  }

  return { ok: false, reason: "timeout" };
}

/**
 * Confirm that the detached/service restart really came back and stayed up. The GUI worker
 * used to mark success immediately after spawning the new process, which hid Windows cases
 * where npm left the bundled Bun runtime half-updated and the restarted proxy died seconds
 * later. A healthy /healthz must appear, then remain healthy for one short stability window.
 */
async function confirmRestartedProxy(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo = {},
): Promise<boolean> {
  /* [Decision Log]
  - 목적과 의도: GUI update job이 detached restart 요청만 보고 성공 처리하지 않도록, 실제 프록시 복귀 여부를 확인한다.
  - 기존 구현 및 제약 조건: update-job.json은 spawn/service reinstall 직후 `succeeded`로 끝났고, Windows npm/Bun 교체 실패처럼 몇 초 후 죽는 재시작을 잡지 못했다.
  - 검토한 주요 대안: (1) 포트 점유만 확인 — 외부 프로세스/죽기 직전 프로세스를 성공으로 오인할 수 있다. (2) 무기한 /healthz 폴링 — UX가 느려지고 worker 종료 시점이 불명확하다. (3) 짧은 healthy 등장 + 안정성 창 확인 — 실제 복귀를 확인하면서도 대기 시간을 제한할 수 있다.
  - 선택한 방식: identity-aware /healthz probe가 일정 시간 안에 나타나고, 추가 안정성 창 동안 유지되는지 확인한다.
  - 다른 대안 대신 이 방식을 선택한 이유: GUI는 "업데이트가 설치됐지만 재시작은 실패"를 분리해 알려줘야 하며, 이 방식이 가장 적은 오탐으로 그 경계를 만든다.
  - 장점, 단점 및 영향: 장점은 silent restart failure가 update-job 상태로 드러난다는 점이다. 단점은 설정상 성공 판정 창이 30초 도착 + 15초 안정성으로 늘어나고 경계 probe 지연이 추가될 수 있다는 점이며, 대신 실제 복귀를 더 정확히 반영한다.
  */
  const result = await awaitRestartedProxyHealthy(job, captured, io);
  if (result.ok) return true;
  const port = captured.port;
  const hostname = captured.hostname;
  const error = result.reason === "flapped"
    ? `proxy restart became unhealthy on ${hostname}:${port}`
    : `proxy restart never became healthy on ${hostname}:${port}`;
  updateJob(job, {
    status: "failed",
    restarted: false,
    error,
  }, restartFailureHint(port));
  return false;
}

export function confirmRestartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo,
): Promise<boolean> {
  return confirmRestartedProxy(job, captured, io);
}

async function defaultProbeProxyIdentity(
  port: number,
  hostname?: string,
): Promise<RestartProxyIdentity | null> {
  try {
    const res = await fetch(`http://${probeHostname(hostname)}:${port}/healthz`, {
      signal: AbortSignal.timeout(750),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
    if (!isOpencodexHealthz(body)) return null;
    return {
      pid: typeof body?.pid === "number" ? body.pid : null,
      // Validate the shape at the boundary where the value ENTERS, not where it is logged.
      // `/healthz` is answered by whatever is listening on that port, so a hostile or confused
      // responder can return any string here — and the restart-evidence reasons below
      // interpolate it into a persisted field. A version is a version or it is nothing.
      ...(isVersionLike(body?.version) ? { version: body.version } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Health alone is not enough to skip the GUI worker restart: a surviving pre-update
 * process is still identity-healthy. Require update-correlated evidence — a new PID
 * when the pre-update PID was captured, and/or /healthz reporting the job's target
 * version when PID evidence is unavailable.
 */
export function npmSelfUpdateRestartEvidence(
  job: Pick<UpdateJobState, "latestVersion">,
  captured: { oldPid?: number },
  identity: RestartProxyIdentity | null,
): { ok: true; detail: string } | { ok: false; reason: string } {
  if (!identity) return { ok: false, reason: "could not read proxy identity" };

  const oldPid = typeof captured.oldPid === "number" && captured.oldPid > 0
    ? captured.oldPid
    : undefined;
  const livePid = typeof identity.pid === "number" && identity.pid > 0 ? identity.pid : null;
  const expected = typeof job.latestVersion === "string" && job.latestVersion.length > 0
    ? job.latestVersion
    : null;
  const versionMatches = expected !== null && identity.version === expected;

  if (oldPid !== undefined) {
    if (livePid === oldPid) {
      return { ok: false, reason: "still the pre-update PID" };
    }
    if (livePid !== null) {
      if (expected !== null && identity.version && identity.version !== expected) {
        // Never echo the REPORTED version: `/healthz` is answered by whatever holds the port,
        // and `2.7.41-JaneDoe` is valid semver. Say that it mismatched, and name only the
        // version we expected — which is ours.
        return { ok: false, reason: `new pid but reported version did not match expected ${expected}` };
      }
      return { ok: true, detail: `pid changed ${oldPid}→${livePid}` };
    }
    // Pre-update PID known but healthz omitted pid — only accept matching target version.
    // On a match the reported value equals `expected`, so render the trusted one.
    if (versionMatches) return { ok: true, detail: `version ${expected}` };
    return { ok: false, reason: "no PID in healthz and version did not match the update target" };
  }

  if (versionMatches) return { ok: true, detail: `version ${expected}` };
  if (expected !== null && identity.version && identity.version !== expected) {
    return { ok: false, reason: `reported version did not match expected ${expected}` };
  }
  return { ok: false, reason: "no pre-update PID capture and no expected-version match" };
}

/**
 * Post-install restart for the GUI worker.
 *
 * npm installs run `node ocx.mjs update`, which already stops the proxy and reinstalls /
 * starts the service (or falls back to a direct start). A second `service install` here
 * calls `stopWindows()` on that healthy listener, then often fails elevation from the
 * non-interactive worker — leaving the captured port (default 10100) dead until a manual
 * restart. Prefer confirming the npm self-update's own restart first; only re-run restart
 * when that probe fails. Bun/source installs still always take the explicit restart path.
 *
 * Probe-first applies only to service-managed npm installs: without a service, `ocx.mjs`
 * only prints `ocx start` and never brings the proxy back, so waiting would always burn
 * the full health timeout. Skipping also requires update-correlated evidence (PID change
 * and/or target version) so a surviving pre-update process cannot look like success.
 * After an explicit npm restart the same evidence is required again — health alone is
 * not enough when a no-op restart or failed port reclaim leaves the old proxy up.
 *
 * Browser-dashboard update recovery must not require a viable Background Service: when
 * no service is installed (or reinstall leaves a non-viable/stale manager), the explicit
 * path always falls through to a direct `ocx start --port` so /healthz can recover.
 */
export async function finishGuiUpdateRestart(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  installer: Installer,
  io: RestartIo = {},
): Promise<boolean> {
  if (installer === "npm") {
    const serviceInstalled = (io.serviceInstalledFn ?? isServiceInstalled)();
    if (serviceInstalled) {
      // Stop-first npm update leaves a dead PID's LISTEN row. Polling /healthz for the
      // full 30s against that zombie keeps ESTABLISHED TCBs alive and blocks bind.
      // If nothing live owns the port, skip straight to explicit restart. A failed
      // listener scan must not look like "no listeners" — fall back to /healthz.
      const aliveFn = io.isAliveFn ?? isProcessAlive;
      const scan: ListenPidScan = io.scanListenPidsFn
        ? io.scanListenPidsFn(captured.port)
        : io.listListenPidsFn
          // Test seam: injected list is always a successful scan.
          ? { ok: true, pids: io.listListenPidsFn(captured.port) }
          : scanListenPids(captured.port);
      const liveListeners = scan.ok
        ? scan.pids.filter(pid => pid !== process.pid && aliveFn(pid))
        : null;
      if (liveListeners !== null && liveListeners.length === 0) {
        updateJob(job, {}, "npm self-update did not leave a live listener; performing explicit restart...");
      } else {
        if (!scan.ok) {
          updateJob(
            job,
            {},
            "Listener scan inconclusive after npm self-update; probing /healthz before deciding on explicit restart...",
          );
        }
        const already = await awaitRestartedProxyHealthy(job, captured, io);
        if (already.ok) {
          const identity = await (io.probeProxyIdentity ?? defaultProbeProxyIdentity)(
            captured.port,
            captured.hostname,
          );
          const evidence = npmSelfUpdateRestartEvidence(job, captured, identity);
          if (evidence.ok) {
            updateJob(
              job,
              {},
              `Proxy already healthy on ${captured.hostname}:${captured.port} after npm self-update (${evidence.detail}); skipping redundant restart.`,
            );
            return true;
          }
          updateJob(
            job,
            {},
            `npm self-update left a healthy proxy but ${evidence.reason}; performing explicit restart...`,
          );
        } else {
          updateJob(job, {}, "npm self-update did not leave a healthy proxy; performing explicit restart...");
        }
      }
    }
  }
  const restartFn = io.restartAfterUpdateFn ?? restartAfterUpdate;
  await restartFn(job, captured, io);
  if (installer !== "npm") {
    // Bun/source: health alone remains enough unless a richer identity probe is supplied.
    if (!io.probeProxyIdentity) return confirmRestartedProxy(job, captured, io);
  }
  return confirmNpmExplicitRestart(job, captured, io);
}

/**
 * After an explicit npm (or identity-aware) restart, require update-correlated
 * evidence — not merely a healthy OpenCodex listener. A no-op restart or a
 * failed port reclaim can leave the pre-update process on the captured port;
 * `confirmRestartedProxy` alone would treat that as success.
 */
async function confirmNpmExplicitRestart(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  io: RestartIo = {},
): Promise<boolean> {
  const healthy = await awaitRestartedProxyHealthy(job, captured, io);
  if (!healthy.ok) {
    const port = captured.port;
    const hostname = captured.hostname;
    const error = healthy.reason === "flapped"
      ? `proxy restart became unhealthy on ${hostname}:${port}`
      : `proxy restart never became healthy on ${hostname}:${port}`;
    updateJob(job, {
      status: "failed",
      restarted: false,
      error,
    }, restartFailureHint(port));
    return false;
  }

  const identity = await (io.probeProxyIdentity ?? defaultProbeProxyIdentity)(
    captured.port,
    captured.hostname,
  );
  const evidence = npmSelfUpdateRestartEvidence(job, captured, identity);
  if (!evidence.ok) {
    updateJob(job, {
      status: "failed",
      restarted: false,
      error: `proxy restart did not show update-correlated identity (${evidence.reason})`,
    }, restartFailureHint(captured.port));
    return false;
  }

  updateJob(
    job,
    {},
    `Proxy restart confirmed on ${captured.hostname}:${captured.port} (${evidence.detail}).`,
  );
  return true;
}

/**
 * Test seams for the GUI update worker.
 *
 * The cache pre-flight and the install/stop step were previously reached only through module
 * globals, so "the gate runs before the stop" could only be asserted by comparing source-string
 * positions — a test that stays green even if the call is unreachable. These make the ordering
 * observable: a failed pre-flight must leave `runCommand` untouched.
 */
export interface GuiUpdateWorkerIo {
  cachePreflightFn?: () => { ok: boolean; reason: string };
  /** Force the resolved update target. A source checkout otherwise aborts before the npm branch. */
  checkForUpdateFn?: (channel: Channel) => ReturnType<typeof checkForUpdate>;
  /** Bypass the registry integrity probe, which runs before the cache gate and needs network. */
  integrityFn?: (version: string | null) => ReturnType<typeof checkUpdatePackageIntegrity>;
  runCommandFn?: (
    job: UpdateJobState,
    bin: string,
    args: string[],
    timeout: number,
  ) => { status: number | null; signal: NodeJS.Signals | null };
}

export async function runGuiUpdateWorker(
  jobId: string,
  channel: Channel,
  restart: boolean,
  io: GuiUpdateWorkerIo = {},
): Promise<void> {
  let job = readUpdateJob(jobId);
  const check = (io.checkForUpdateFn ?? checkForUpdate)(channel);
  const now = new Date().toISOString();
  // Capture the live listen target BEFORE the update command runs: the stop-first update
  // flow clears pid/runtime state, so this is the last moment the real port is knowable.
  // Only trust runtime-port.json when its pid matches the live pidfile process.
  const rt = readRuntimePort();
  const livePid = readPid();
  const preUpdateConfig = loadConfig();
  const runtimeTrusted = !!(rt && livePid && rt.pid === livePid);
  const configPort = typeof preUpdateConfig.port === "number" && preUpdateConfig.port > 0
    ? preUpdateConfig.port
    : 10100;
  const captured = {
    port: runtimeTrusted ? rt.port : configPort,
    hostname: (runtimeTrusted ? rt.hostname : undefined) ?? preUpdateConfig.hostname ?? "127.0.0.1",
    ...(runtimeTrusted && livePid ? { oldPid: livePid } : {}),
  };
  let trayWasInstalled = false;
  let trayWasRunning = false;
  if (!job) {
    job = {
      id: jobId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      channel: check.channel,
      installer: check.installer,
      restart,
      command: check.command,
      releaseNotesUrl: check.releaseNotesUrl,
      log: [],
    };
    writeJob(job);
  }

  try {
    if (!check.canUpdate) {
      throw new Error(check.reason ?? "No update is available");
    }

    // Pre-flight integrity metadata check (same lanes as the CLI): anomalous registry
    // metadata for a resolved version fails the job BEFORE anything is spawned or the
    // proxy is stopped; transient registry failure degrades to a logged skip.
    const integrity = (io.integrityFn ?? checkUpdatePackageIntegrity)(check.latestVersion);
    if (integrity.ok === false) {
      updateJob(job, { status: "failed", error: integrity.reason });
      return;
    }
    const integrityLine = integrity.ok === "skipped"
      ? `Integrity pre-flight skipped: ${integrity.reason}. Proceeding best-effort.`
      : `Verified ${PKG}@${check.latestVersion} integrity metadata ${integrity.integrity.slice(0, 24)}…`;

    const cmd = updateExecutionCommand(check.installer, channel, undefined, check.latestVersion);
    job = updateJob(job, {
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      installer: check.installer,
      command: cmd.display,
    }, integrityLine);

    if (check.installer === "npm") {
      const cachePreflight = (io.cachePreflightFn ?? runNpmCachePreflight)();
      if (!cachePreflight.ok) {
        updateJob(job, {
          status: "failed",
          error: npmCachePreflightFailureMessage(cachePreflight.reason as NpmCachePreflightReason),
        }, "Update aborted before stopping the proxy because the npm cache pre-flight failed.");
        return;
      }
    }

    if (process.platform === "win32") {
      try {
        const { getWindowsTrayStatus, startWindowsTray, stopWindowsTray } = await import("../tray/windows");
        const tray = getWindowsTrayStatus();
        const trayPlan = handoffWindowsTrayForUpdate(tray, {
          stop: () => {
            const stopped = stopWindowsTray();
            return { exitStatus: 0, running: stopped.running };
          },
          start: () => startWindowsTray(),
        });
        trayWasInstalled = trayPlan.refreshAfterReplacement;
        trayWasRunning = trayPlan.restoreOnFailure;
      } catch (error) {
        updateJob(job, {
          status: "failed",
          error: `Could not stop the Windows tray; aborting before package replacement: ${withheldSummary(error)}`,
        });
        return;
      }
    }

    /* [Decision Log]
    - 목적: GUI 요청 처리 프로세스가 자신이 실행 중인 패키지를 직접 덮어쓰지 않도록 업데이트를 별도 worker에서 수행한다.
    - 대안 분석: (1) 서버에서 runUpdate 직접 호출: process.exit/stdio/실행 파일 교체 위험. (2) GUI에서 CLI 명령 안내만 제공: 자동 업데이트 UX 부족. (3) 숨은 worker가 Node launcher/Bun 전역 명령을 실행: 상태 추적과 안전한 재시작이 가능.
    - 선택 근거: 현재 CLI의 npm self-update 우회를 재사용하면서도 GUI 서버 요청 생명주기와 설치 작업을 분리할 수 있어 가장 안정적이다.
    */
    const result = (io.runCommandFn ?? runLoggedCommand)(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);
    if (result.status !== 0) {
      if (trayWasRunning) {
        try {
          const { startWindowsTray } = await import("../tray/windows");
          startWindowsTray();
        } catch { /* retain the primary update failure */ }
      }
      updateJob(job, {
        status: "failed",
        exitCode: result.status,
        signal: result.signal,
        error: `update command failed (${result.status ?? "?"})`,
      });
      return;
    }

    if (trayWasInstalled) {
      const trayArgs = selfLaunchArgv(planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs);
      const tray = runLoggedCommand(job, process.execPath, trayArgs, 20_000);
      if (tray.status !== 0) {
        updateJob(job, {}, "Windows tray refresh failed; run 'ocx tray install'.");
        if (trayWasRunning) runLoggedCommand(job, process.execPath, selfLaunchArgv(["tray", "start"]), 15_000);
      }
    }

    if (restart) {
      job = updateJob(job, { status: "restarting" }, "Update installed. Restarting proxy...");
      if (!(await finishGuiUpdateRestart(job, captured, check.installer))) return;
      updateJob(job, { status: "succeeded", restarted: true }, "Restart requested and proxy is healthy.");
      return;
    }

    updateJob(job, { status: "succeeded", restarted: false }, "Update installed. Restart the proxy to use the new version.");
  } catch (err) {
    if (trayWasRunning) {
      try {
        const { startWindowsTray } = await import("../tray/windows");
        startWindowsTray();
      } catch { /* retain the primary worker failure */ }
    }
    updateJob(job, {
      status: "failed",
      error: withheldSummary(err),
    });
  }
}
