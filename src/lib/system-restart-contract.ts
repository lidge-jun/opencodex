import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const SYSTEM_RESTART_METHOD = "POST";
export const SYSTEM_RESTART_PATH = "/api/system/restart";
export const SYSTEM_RESTART_CAPABILITY_VERSION = "v1";
export const SYSTEM_RESTART_EXPECTED_PID_HEADER = "x-opencodex-restart-expected-pid";
export const SYSTEM_RESTART_NONCE_HEADER = "x-opencodex-restart-nonce";
export const SYSTEM_RESTART_CAPABILITY_HEADER = "x-opencodex-restart-capability";

/** Fixed drain and replacement budgets shared by the server, CLI, and tray. */
export const MEMORY_DRAIN_RESTART_MS = 60_000;
export const REPLACEMENT_READY_TIMEOUT_MS = 70_000;

/**
 * A connected client runtime's whole restart, from accepting the request to serving again on the
 * old process after a failed replacement (OCX-6). The CLI sends the request only while this budget
 * still fits before its own replacement observation ends, so a rollback is never raced by the
 * CLI's recovery start. The phases are measured from acceptance.
 */
export const CLIENT_RESTART_BUDGET_MS = 90_000;
/** In-flight requests on the client listener get this long before the listener closes them. */
export const CLIENT_RESTART_DRAIN_MS = 20_000;
/** The replacement must answer by this point; a later one is stopped and the old runtime resumes. */
export const CLIENT_RESTART_READY_BY_MS = 70_000;
/** How long a rollback waits for the port the stopped replacement released. */
export const CLIENT_RESTART_REBIND_WAIT_MS = 10_000;
/** The 409 code a supervised client runtime answers a bound restart with. */
export const RESTART_SUPERVISED_ERROR = "restart_supervised";
/** `ocx restart` stops waiting for a replacement this long before its overall deadline. */
export const RESTART_REOBSERVE_RESERVE_MS = 10_000;
/**
 * Room `ocx restart` must still have before it may ask a client runtime to restart: the client's
 * whole budget, the reobserve reserve and a margin for the request itself. A later request is
 * refused before it is sent, so a rollback always finishes while the CLI is still observing.
 */
export const CLIENT_RESTART_REQUEST_MIN_REMAINING_MS = CLIENT_RESTART_BUDGET_MS + RESTART_REOBSERVE_RESERVE_MS + 5_000;

/**
 * The env var a restarting process hands its replacement `ocx start`: the restarting (parent) pid.
 *
 * The replacement can probe while its parent still answers on the port it is about to take over
 * (a deadline or listener-stop-fallback handoff spawns before the old listener is gone). Without
 * the marker that answer reads as "a proxy is already running" and the replacement refuses, which
 * leaves no proxy at all once the parent exits. `handleStart` consumes the marker before any probe
 * (`src/cli/restart-handoff.ts`), so no later child of the replacement inherits it.
 */
export const RESTART_PARENT_PID_ENV = "OCX_RESTART_PARENT_PID";

type RestartEnv = Record<string, string | undefined>;

/** A copy of `env` for this process's own replacement, naming `parentPid` as its restart parent. */
export function withRestartParentMarker<T extends RestartEnv>(env: T, parentPid: number): T {
  const next: RestartEnv = { ...env };
  next[RESTART_PARENT_PID_ENV] = String(parentPid);
  return next as T;
}

/**
 * Consume an inherited restart-parent marker. The marker is removed from `env` either way, and the
 * pid is honored only when it is this process's actual parent: a stale or hand-set value names a
 * process that did not spawn this start and never earns the wait.
 */
export function takeRestartParentMarker(
  env: RestartEnv,
  actualParentPid: number = process.ppid,
  ownPid: number = process.pid,
): number | null {
  const raw = env[RESTART_PARENT_PID_ENV]?.trim() ?? "";
  delete env[RESTART_PARENT_PID_ENV];
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid === ownPid || pid !== actualParentPid) return null;
  return pid;
}

/**
 * The env var the desktop app sets on the `ocx start` it spawns and waits on
 * (`desktop/src-tauri/src/sidecar.rs`). Under it a restart spawns no detached replacement: it marks
 * recycling and exits {@link DESKTOP_RESTART_EXIT_CODE}, and the app starts the replacement itself.
 * A detached grandchild is a process the app can neither see nor stop, and one that failed to start
 * left no proxy until somebody relaunched the app. `handleStart` consumes the marker before its
 * first probe, so no child of the runtime inherits it.
 */
export const DESKTOP_SUPERVISED_ENV = "OCX_DESKTOP_SUPERVISED";
/** EX_TEMPFAIL, "run me again": the desktop's supervisor restarts promptly on exactly this code. */
export const DESKTOP_RESTART_EXIT_CODE = 75;
/**
 * The link-mode port-reclaim budget under the desktop app. With the pinned port's prefer-retry after
 * it (`PINNED_PREFER_RETRY_MS` in `src/client/runtime.ts`) a start that cannot bind gives up within
 * 25 seconds, inside the app's 30-second startup deadline, so the app sees it exit instead of giving
 * up on it while it still waits.
 */
export const DESKTOP_SUPERVISED_PORT_WAIT_MS = 20_000;

/** The desktop app's pid, recorded when the marker was taken; null when nothing supervises this process. */
let desktopParentPid: number | null = null;

/**
 * Consume an inherited desktop-supervision marker, removing it from `env` either way. It is recorded
 * only against a real parent process, so {@link isDesktopSupervised} can later check that the same
 * app is still there.
 */
export function takeDesktopSupervisedMarker(env: RestartEnv, actualParentPid: number = process.ppid): boolean {
  const raw = env[DESKTOP_SUPERVISED_ENV]?.trim();
  delete env[DESKTOP_SUPERVISED_ENV];
  desktopParentPid = raw === "1" && Number.isSafeInteger(actualParentPid) && actualParentPid > 1
    ? actualParentPid
    : null;
  return desktopParentPid !== null;
}

export interface DesktopSupervisionIo {
  parentPid?: () => number;
  isAlive?: (pid: number) => boolean;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Whether the desktop app that started this process is still there to start its replacement: the
 * marker was taken, the parent recorded then is still this process's parent, and it is alive. An app
 * that crashed leaves the runtime re-parented (POSIX) or its parent dead (Windows), and a restart then
 * falls back to the detached replacement instead of exiting into nothing. Read only when a restart
 * or a link-mode start needs it, never on the request path.
 */
export function isDesktopSupervised(io: DesktopSupervisionIo = {}): boolean {
  if (desktopParentPid === null) return false;
  if ((io.parentPid ?? (() => process.ppid))() !== desktopParentPid) return false;
  return (io.isAlive ?? processExists)(desktopParentPid);
}

/** Test seam: forget a marker a test took. */
export function resetDesktopSupervisionForTests(): void {
  desktopParentPid = null;
}

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export type ExpectedSystemRestartPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedSystemRestartPid(value: string | null): ExpectedSystemRestartPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

function restartCapabilityPayload(
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== SYSTEM_RESTART_METHOD || path !== SYSTEM_RESTART_PATH) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `opencodex-system-restart-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}`;
}

/** Process-scoped, operation-only authorization. It is not a reusable management credential. */
export function createSystemRestartCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = restartCapabilityPayload(nonce, method, path, pid, port);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifySystemRestartCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  pid: number,
  port: number,
  capability: string | null,
): boolean {
  if (!nonce || !capability || !BASE64URL_256.test(capability)) return false;
  const expected = createSystemRestartCapability(secret, nonce, method, path, pid, port);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
