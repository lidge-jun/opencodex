import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, getConfigDir, loadConfig, readPid, readRuntimePort } from "../config";
import { killProxy } from "../lib/process-control";
import { reclaimListenPort } from "../server/port-reclaim";
import { isOpencodexHealthz, probeHostname, proxyIdentityAt, type HealthzIdentity } from "../server/proxy-liveness";
import { isServiceInstalled } from "../service";
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
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";

const RELEASE_NOTES_URL = "https://github.com/lidge-jun/opencodex/releases/latest";
const UPDATE_JOB_FILENAME = "update-job.json";
const UPDATE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_HEALTH_TIMEOUT_MS = 15_000;
const RESTART_STABILITY_WINDOW_MS = 15_000;
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

const defaultCheckDeps: UpdateCheckDeps = {
  currentVersion,
  detectInstall,
  latestVersion,
};

function nodeBin(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function packageLauncherPath(): string {
  // This module lives at src/update/job.ts — the launcher is <pkg-root>/bin/ocx.mjs.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ocx.mjs");
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

function writeJob(job: UpdateJobState): void {
  ensureJobDir();
  atomicWriteFile(updateJobPath(), `${JSON.stringify(job, null, 2)}\n`);
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
    const { bin, args } = updateCommand(installer, channel, resolvedVersion);
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
  const svcArgs = serviceInstalled ? [launcher, ...(serviceArgs ?? ["service", "install"])] : startArgs;
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

export function startUpdateJob(channel: Channel, restart: boolean): UpdateJobState {
  const running = readUpdateJob();
  if (running?.status === "running" || running?.status === "restarting") {
    throw new UpdateJobError("An update job is already running", 409, "update_already_running");
  }

  const check = checkForUpdate(channel);
  if (!check.canUpdate) {
    throw new UpdateJobError(check.reason ?? "No update is available", 409, check.reason ?? "update_unavailable");
  }

  const id = newJobId();
  const now = new Date().toISOString();
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

  const child = spawn(process.execPath, [process.argv[1], "__gui-update-worker", id, channel, restart ? "restart" : "no-restart"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
  return { ...job, pid: child.pid };
}

function runLoggedCommand(job: UpdateJobState, bin: string, args: string[], timeout: number): { status: number | null; signal: NodeJS.Signals | null } {
  job = updateJob(job, {}, `$ ${formatCommand(bin, args)}`);
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) job = updateJob(job, {}, stdout.slice(-4000));
  if (stderr) updateJob(job, {}, stderr.slice(-4000));
  return { status: result.status, signal: result.signal };
}

function spawnDetachedStart(job: UpdateJobState, installer: Installer, port?: number): void {
  const cmd = restartCommand(false, installer, packageLauncherPath(), port);
  const env = { ...process.env };
  delete env.OCX_SERVICE;
  updateJob(job, {}, `$ ${cmd.display}`);
  const child = spawn(cmd.bin, cmd.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
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
  probeProxy?: (port: number, hostname?: string) => Promise<boolean>;
  /** Richer /healthz read for update-correlated restart evidence (pid + version). */
  probeProxyIdentity?: (port: number, hostname?: string) => Promise<RestartProxyIdentity | null>;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
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
  const reclaimOpts = {
    timeoutMs: RESTART_PORT_RECLAIM_MS,
    intervalMs: 100,
    scanIntervalMs: 500,
    killOcxHolders: oldPid != null,
    onlyKillPids: oldPid != null ? [oldPid] : [],
  };

  if (serviceInstalled) {
    // Stop-first update already unloaded the service; reclaim the socket (only the
    // captured old PID when trusted), then reinstall wrappers that bake `--port`.
    const freed = await waitFn(port, hostname, reclaimOpts);
    if (!freed) {
      updateJob(job, {}, `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s; refusing to hop — reinstall may fail until the port is free.`);
    }
    const prevBake = process.env.OCX_BAKE_PORT;
    process.env.OCX_BAKE_PORT = String(Math.trunc(port));
    let serviceOk = false;
    try {
      const run = io.runService ?? ((j, bin, args) => runLoggedCommand(j, bin, args, RESTART_TIMEOUT_MS));
      const result = run(job, cmd.bin, cmd.args);
      serviceOk = result.status === 0;
      if (!serviceOk) {
        // On Windows, `schtasks /create` requires an elevated token. The update worker
        // inherits the (non-admin) proxy's privileges, so a service-managed install
        // updated from the GUI or a normal terminal fails here with access denied.
        // Falling back to a direct proxy start keeps the update from leaving the proxy
        // stopped; the stale service manager can be refreshed later with an admin
        // `ocx service install`.
        updateJob(job, {}, `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start. Run 'ocx service install' as administrator to refresh the background service manager.`);
      }
    } finally {
      if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prevBake;
    }
    if (serviceOk) return;
    // Fall through to the direct proxy start below so the update never leaves the
    // proxy stopped when the service reinstall could not run.
  }

  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Stopping current proxy PID ${pid}.`);
    killProxy(pid);
  }
  // Reclaim the captured port before the pinned start. Spawning `--port` while the old
  // socket is still busy is how Windows updates used to fail health checks (or hop).
  // Only the trusted pre-update PID may be killed; never an arbitrary ocx listener.
  const freed = await waitFn(port, hostname, reclaimOpts);
  if (!freed) {
    updateJob(job, {}, `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s (reclaim could not free the socket); not starting on another port. Retry 'ocx start --port ${port}'.`);
    return;
  }
  (io.spawnStart ?? spawnDetachedStart)(job, job.installer, port);
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
  const probe = io.probeProxy ?? (async (port: number, hostname?: string) => (
    !!(await proxyIdentityAt(port, { hostname }))
  ));
  const sleep = io.sleepMs ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  const now = io.now ?? (() => Date.now());
  const port = captured.port;
  const hostname = captured.hostname;
  const startDeadline = now() + RESTART_HEALTH_TIMEOUT_MS;

  while (now() < startDeadline) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Proxy reported healthy on ${hostname}:${port}; confirming it stays up...`);
      const stableUntil = now() + RESTART_STABILITY_WINDOW_MS;
      while (now() < stableUntil) {
        if (!(await probe(port, hostname))) {
          updateJob(job, {}, `Proxy became unhealthy on ${hostname}:${port} during the stability window.`);
          return { ok: false, reason: "flapped" };
        }
        await sleep(500);
      }
      updateJob(job, {}, `Proxy stayed healthy for ${Math.trunc(RESTART_STABILITY_WINDOW_MS / 1000)}s after restart.`);
      return { ok: true };
    }
    await sleep(250);
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
  - 장점, 단점 및 영향: 장점은 silent restart failure가 update-job 상태로 드러난다는 점이다. 단점은 성공 판정이 최대 30초 늦어질 수 있다는 점이며, 대신 실제 복귀를 더 정확히 반영한다.
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
      ...(typeof body?.version === "string" ? { version: body.version } : {}),
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
        return { ok: false, reason: `new pid but version ${identity.version} !== expected ${expected}` };
      }
      return { ok: true, detail: `pid changed ${oldPid}→${livePid}` };
    }
    // Pre-update PID known but healthz omitted pid — only accept matching target version.
    if (versionMatches) return { ok: true, detail: `version ${identity.version}` };
    return { ok: false, reason: "no PID in healthz and version did not match the update target" };
  }

  if (versionMatches) return { ok: true, detail: `version ${identity.version}` };
  if (expected !== null && identity.version && identity.version !== expected) {
    return { ok: false, reason: `version ${identity.version} !== expected ${expected}` };
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

export async function runGuiUpdateWorker(jobId: string, channel: Channel, restart: boolean): Promise<void> {
  let job = readUpdateJob(jobId);
  const check = checkForUpdate(channel);
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
    const integrity = checkUpdatePackageIntegrity(check.latestVersion);
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
          error: `Could not stop the Windows tray; aborting before package replacement: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }

    /* [Decision Log]
    - 목적: GUI 요청 처리 프로세스가 자신이 실행 중인 패키지를 직접 덮어쓰지 않도록 업데이트를 별도 worker에서 수행한다.
    - 대안 분석: (1) 서버에서 runUpdate 직접 호출: process.exit/stdio/실행 파일 교체 위험. (2) GUI에서 CLI 명령 안내만 제공: 자동 업데이트 UX 부족. (3) 숨은 worker가 Node launcher/Bun 전역 명령을 실행: 상태 추적과 안전한 재시작이 가능.
    - 선택 근거: 현재 CLI의 npm self-update 우회를 재사용하면서도 GUI 서버 요청 생명주기와 설치 작업을 분리할 수 있어 가장 안정적이다.
    */
    const result = runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);
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
      const trayArgs = [process.argv[1], ...planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs];
      const tray = runLoggedCommand(job, process.execPath, trayArgs, 20_000);
      if (tray.status !== 0) {
        updateJob(job, {}, "Windows tray refresh failed; run 'ocx tray install'.");
        if (trayWasRunning) runLoggedCommand(job, process.execPath, [process.argv[1], "tray", "start"], 15_000);
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
