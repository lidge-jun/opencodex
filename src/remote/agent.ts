import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { chmod, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../config";
import {
  REMOTE_AGENT_PUBLIC_KEY_PEM,
  remoteAgentPackageForRuntime,
  verifyRemoteAgentArtifact,
} from "./agent-bundle";

interface AgentPidFile {
  pid: number;
  binary: string;
  startedAt: string;
}

export interface RemoteRelayAgentStatus {
  supported: boolean;
  running: boolean;
  pid?: number;
  error?: string;
}

function pidPath(): string {
  return join(getConfigDir(), "remote-agent.pid.json");
}

function logPath(): string {
  return join(getConfigDir(), "remote-agent.log");
}

function statePath(): string {
  return join(getConfigDir(), "remote.json");
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedProcessAlive(recorded: AgentPidFile): boolean {
  if (!processAlive(recorded.pid)) return false;
  if (process.platform !== "linux") return true;
  try {
    // A stale pidfile must never make OCX signal an unrelated process after PID
    // reuse. Linux exposes the actual executable without parsing a shell command.
    const runningBinary = readlinkSync(`/proc/${recorded.pid}/exe`).replace(/ \(deleted\)$/, "");
    return resolve(runningBinary) === realpathSync(recorded.binary);
  } catch {
    return false;
  }
}

function readPidFile(): AgentPidFile | null {
  try {
    const parsed = JSON.parse(readFileSync(pidPath(), "utf8")) as Partial<AgentPidFile>;
    if (
      !Number.isInteger(parsed.pid)
      || typeof parsed.binary !== "string"
      || typeof parsed.startedAt !== "string"
    ) return null;
    return parsed as AgentPidFile;
  } catch {
    return null;
  }
}

function executableName(): string {
  return process.platform === "win32" ? "opencodex-remote-agent.exe" : "opencodex-remote-agent";
}

function installedPackageVersion(packageRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) throw new Error("missing version");
    return parsed.version;
  } catch {
    throw new Error("OpenCodex package version is unavailable for Remote Agent verification");
  }
}

function resolveAgentBinary(): string | null {
  const override = process.env.OPENCODEX_REMOTE_AGENT_BIN?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("OPENCODEX_REMOTE_AGENT_BIN must be an absolute path");
    return override;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const name = executableName();
  const bundleRoot = join(packageRoot, "bin", "remote-agent");
  const packageName = remoteAgentPackageForRuntime();
  if (existsSync(bundleRoot)) {
    if (!packageName) throw new Error("Remote Agent is not available for this platform");
    // A present release bundle is a trust boundary. Never fall back to an
    // unsigned development binary when that bundle is partial or tampered.
    const binary = verifyRemoteAgentArtifact(
      bundleRoot,
      packageName,
      REMOTE_AGENT_PUBLIC_KEY_PEM,
      installedPackageVersion(packageRoot),
    );
    if (process.platform !== "win32") accessSync(binary, constants.X_OK);
    return binary;
  }

  const candidates = [
    join(packageRoot, "remote-agent", "target", "release", name),
    join(packageRoot, "remote-agent", "target", "debug", name),
  ];
  return candidates.find(candidate => {
    try {
      if (!existsSync(candidate)) return false;
      // Windows does not use POSIX execute bits; existence is sufficient there.
      if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

export function remoteRelayAgentStatus(): RemoteRelayAgentStatus {
  const recorded = readPidFile();
  if (recorded && recordedProcessAlive(recorded)) {
    return { supported: true, running: true, pid: recorded.pid };
  }
  if (recorded) {
    try { unlinkSync(pidPath()); } catch { /* stale PID cleanup is best-effort */ }
  }
  try {
    const binary = resolveAgentBinary();
    return binary
      ? { supported: true, running: false }
      : { supported: false, running: false, error: "Remote Agent binary is not installed for this platform" };
  } catch (error) {
    return { supported: false, running: false, error: error instanceof Error ? error.message : "Remote Agent unavailable" };
  }
}

/**
 * [Decision Log]
 * - 목적과 의도: 사용자가 별도 root 설치나 페어링 코드를 다루지 않고 로컬 GUI 승인 뒤 동일 사용자 권한으로 outbound Agent를 시작한다.
 * - 기존 구현 및 제약 조건: 기존 Agent는 root network 준비와 cloudflared를 전제로 했으며 npm 패키지에는 Agent source/binary가 포함되지 않았다.
 * - 검토한 주요 대안: root systemd 서비스, 런타임 cargo build, Bun child pipe, 사전 빌드된 사용자 권한 Rust Agent.
 * - 선택한 방식: 현재 플랫폼의 사전 빌드 binary만 명시적 argv로 detached 실행하고 remote.json은 0600 파일 경로로 전달한다.
 * - 다른 대안 대신 이 방식을 선택한 이유: 포트·root·shell interpolation 없이 portable-pty와 WSS를 쓸 수 있고 런타임 컴파일 부하를 만들지 않는다.
 * - 장점, 단점 및 영향: GUI에서 즉시 시작되고 기존 OCX 프로세스와 분리되지만 릴리스가 플랫폼별 서명 binary를 반드시 동봉해야 한다.
 */
export async function startRemoteRelayAgent(): Promise<RemoteRelayAgentStatus> {
  const current = remoteRelayAgentStatus();
  if (current.running || !current.supported) return current;
  if (!existsSync(statePath())) return { supported: true, running: false, error: "Remote is not connected on this computer" };
  const binary = resolveAgentBinary();
  if (!binary) return { supported: false, running: false, error: "Remote Agent binary is not installed for this platform" };

  await chmod(getConfigDir(), 0o700).catch(() => undefined);
  const lock = await open(pidPath(), "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  });
  if (!lock) return remoteRelayAgentStatus();
  const logFd = openSync(logPath(), "a", 0o600);
  try {
    const child = spawn(binary, ["relay", "--state", statePath()], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    if (!child.pid) throw new Error("Remote Agent did not start");
    const record: AgentPidFile = { pid: child.pid, binary, startedAt: new Date().toISOString() };
    await lock.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await lock.sync();
    child.unref();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
    return processAlive(child.pid)
      ? { supported: true, running: true, pid: child.pid }
      : { supported: true, running: false, error: "Remote Agent exited during startup" };
  } catch (error) {
    await lock.close().catch(() => undefined);
    try { unlinkSync(pidPath()); } catch { /* best effort */ }
    return { supported: true, running: false, error: error instanceof Error ? error.message : "Remote Agent failed to start" };
  } finally {
    closeSync(logFd);
    await lock.close().catch(() => undefined);
  }
}

export function stopRemoteRelayAgent(): void {
  const recorded = readPidFile();
  if (recorded && recordedProcessAlive(recorded)) {
    try { process.kill(recorded.pid, "SIGTERM"); } catch { /* already exited */ }
  }
  try { unlinkSync(pidPath()); } catch { /* already absent */ }
}
