import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, getConfigDir, readPid } from "../config";
import { killProxy } from "../lib/process-control";
import { isServiceInstalled } from "../service";
import {
  type Channel,
  type Installer,
  PKG,
  assertUpdatePackageIntegrity,
  currentVersion,
  defaultUpdateTag,
  detectInstall,
  latestVersion,
  updateCommand,
  updateCommandStr,
} from "./index";
import { isNewer } from "./notify";

const RELEASE_NOTES_URL = "https://github.com/lidge-jun/opencodex/releases/latest";
const UPDATE_JOB_FILENAME = "update-job.json";
const UPDATE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;

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
): { bin: string; args: string[]; display: string } {
  if (installer === "npm") {
    const bin = nodeBin();
    const args = [launcher, "update", "--tag", channel];
    return { bin, args, display: formatCommand(bin, args) };
  }
  if (installer === "bun") {
    const { bin, args } = updateCommand(installer, channel);
    return { bin, args, display: updateCommandStr(installer, channel) };
  }
  return { bin: "sh", args: ["-lc", manualSourceCommand()], display: manualSourceCommand() };
}

export function restartCommand(
  serviceInstalled: boolean,
  installer: Installer,
  launcher = packageLauncherPath(),
): { mode: "service" | "proxy"; bin: string; args: string[]; display: string } {
  const mode = serviceInstalled ? "service" : "proxy";
  if (installer === "npm") {
    const bin = nodeBin();
    const args = serviceInstalled ? [launcher, "service", "install"] : [launcher, "start"];
    return { mode, bin, args, display: formatCommand(bin, args) };
  }
  // bun/source installs: restart via the current runtime executable + package launcher (both real
  // .exe files), NOT the `ocx.cmd` shim. Spawning a `.cmd` shell-less throws EINVAL on Windows
  // Node/Bun ≥18.20/20.12 (CVE-2024-27980 hardening) — the same class the npm path (nodeBin) avoids.
  const bin = process.execPath;
  const args = serviceInstalled ? [launcher, "service", "install"] : [launcher, "start"];
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

function spawnDetachedStart(job: UpdateJobState, installer: Installer): void {
  const cmd = restartCommand(false, installer);
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

function restartAfterUpdate(job: UpdateJobState): void {
  const serviceInstalled = isServiceInstalled();
  const cmd = restartCommand(serviceInstalled, job.installer);
  if (serviceInstalled) {
    const result = runLoggedCommand(job, cmd.bin, cmd.args, RESTART_TIMEOUT_MS);
    if (result.status !== 0) {
      throw new Error(`service restart failed (${cmd.display}, exit ${result.status ?? "?"})`);
    }
    return;
  }

  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Stopping current proxy PID ${pid}.`);
    killProxy(pid);
  }
  spawnDetachedStart(job, job.installer);
}

export function runGuiUpdateWorker(jobId: string, channel: Channel, restart: boolean): void {
  let job = readUpdateJob(jobId);
  const check = checkForUpdate(channel);
  const now = new Date().toISOString();
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

    const cmd = updateExecutionCommand(check.installer, channel);
    const EXPECTED_SHA = assertUpdatePackageIntegrity(channel, check.latestVersion);
    job = updateJob(job, {
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      installer: check.installer,
      command: cmd.display,
    }, `Verified ${PKG}@${check.latestVersion} integrity ${EXPECTED_SHA.slice(0, 24)}…`);

    /* [Decision Log]
    - 목적: GUI 요청 처리 프로세스가 자신이 실행 중인 패키지를 직접 덮어쓰지 않도록 업데이트를 별도 worker에서 수행한다.
    - 대안 분석: (1) 서버에서 runUpdate 직접 호출: process.exit/stdio/실행 파일 교체 위험. (2) GUI에서 CLI 명령 안내만 제공: 자동 업데이트 UX 부족. (3) 숨은 worker가 Node launcher/Bun 전역 명령을 실행: 상태 추적과 안전한 재시작이 가능.
    - 선택 근거: 현재 CLI의 npm self-update 우회를 재사용하면서도 GUI 서버 요청 생명주기와 설치 작업을 분리할 수 있어 가장 안정적이다.
    */
    const result = runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);
    if (result.status !== 0) {
      updateJob(job, {
        status: "failed",
        exitCode: result.status,
        signal: result.signal,
        error: `update command failed (${result.status ?? "?"})`,
      });
      return;
    }

    if (restart) {
      job = updateJob(job, { status: "restarting" }, "Update installed. Restarting proxy...");
      restartAfterUpdate(job);
      updateJob(job, { status: "succeeded", restarted: true }, "Restart requested.");
      return;
    }

    updateJob(job, { status: "succeeded", restarted: false }, "Update installed. Restart the proxy to use the new version.");
  } catch (err) {
    updateJob(job, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
