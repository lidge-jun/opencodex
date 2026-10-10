import { existsSync } from "node:fs";
import { getRuntimePortPath, readRuntimePort } from "../config/process-state";
import { packageVersion } from "../lib/package-version";
import { parseStrictSemver } from "../lib/strict-semver";
import { acquireOwnershipMutationLease, OWNERSHIP_MUTATION_LEASE_TOKEN_ENV } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";
import { assertUpdateRestartConfiguration, assertUpdateRestartHome, type UpdateRestartHome } from "./update-restart-home";

export const UPDATE_RESTART_CHILD_ENV = "OCX_UPDATE_RESTART_CHILD";
export interface UpdateRestartChildMarker { home: UpdateRestartHome; version: string; port: number; hostname: string; deadlineAt: number }
export interface UpdateRestartChildGuard { check(port?: number, hostname?: string): void; complete(): void }

function parseMarker(raw: string): UpdateRestartChildMarker {
  if (raw.length > 8192) throw new Error("update_restart_child_marker_invalid");
  const value = JSON.parse(raw) as UpdateRestartChildMarker;
  if (!value || !Number.isSafeInteger(value.deadlineAt) || !Number.isInteger(value.port)
    || typeof value.hostname !== "string" || value.port < 1 || value.port > 65535 || typeof value.version !== "string"
    || value.version === "0.0.0" || !parseStrictSemver(value.version) || !value.home
    || !Number.isSafeInteger(value.home.revision) || value.home.serviceRecord?.schema !== 1
    || typeof value.home.serviceRecord.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.home.serviceRecord.digest)) throw new Error("update_restart_child_marker_invalid");
  for (const directory of [value.home.config, value.home.codex]) {
    // Windows reports 64-bit NTFS file ids (MFT sequence in the high 16 bits) as doubles above
    // 2^53. Parent and child read them through the same stat API, so any finite integer is a
    // faithful identity token; assertUpdateRestartHome still compares path, dev and ino exactly.
    if (!directory || typeof directory.path !== "string" || !directory.path
      || !Number.isInteger(directory.dev) || !Number.isInteger(directory.ino)) {
      throw new Error("update_restart_child_marker_invalid");
    }
  }
  return value;
}

export interface UpdateRestartChildIo {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  version?: () => string;
  checkHome?: (home: UpdateRestartHome) => void;
  acquire?: (waitMs: number) => { release(): void };
  onExit?: (release: () => void) => void;
  checkState?: (marker: UpdateRestartChildMarker) => void;
  armDeadline?: (remainingMs: number) => () => void;
}

/** Admit the replacement before CLI preflight; custody belongs to this child PID. */
export function admitUpdateRestartChild(argv: string[], io: UpdateRestartChildIo = {}): UpdateRestartChildGuard | undefined {
  const env = io.env ?? process.env;
  const raw = env[UPDATE_RESTART_CHILD_ENV];
  if (raw === undefined) return undefined;
  delete env[UPDATE_RESTART_CHILD_ENV];
  delete env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  const marker = parseMarker(raw);
  if (argv.length !== 3 || argv[0] !== "start" || argv[1] !== "--port" || argv[2] !== String(marker.port)) {
    throw new Error("update_restart_child_command_changed");
  }
  const now = io.now ?? Date.now;
  const check = (port = marker.port, hostname = marker.hostname) => {
    if (now() >= marker.deadlineAt) throw new Error("update_restart_deadline_expired");
    const bindHost = (host: string) => !host.trim() || /^localhost\.?$/i.test(host.trim()) ? "127.0.0.1" : host.trim();
    if (port !== marker.port || bindHost(hostname) !== bindHost(marker.hostname) || (io.version ?? packageVersion)() !== marker.version) throw new Error("update_restart_child_identity_changed");
    (io.checkHome ?? (home => assertUpdateRestartHome(home, marker.deadlineAt)))(marker.home);
    (io.checkState ?? (expected => {
      assertUpdateRestartConfiguration(expected.hostname);
      const current = readRuntimePort();
      if (existsSync(getRuntimePortPath()) && (!current || current.pid !== process.pid
        || current.port !== expected.port || current.siblingOfPort !== undefined)) {
        throw new Error("update_restart_competing_runtime");
      }
    }))(marker);
    if (now() >= marker.deadlineAt) throw new Error("update_restart_deadline_expired");
  };
  check();
  const lease = (io.acquire ?? (waitMs => acquireOwnershipMutationLease(serviceStatePaths(), { waitMs })))(Math.min(2000, marker.deadlineAt - now()));
  let released = false;
  let cancelDeadline: (() => void) | undefined;
  const release = () => { if (!released) { released = true; cancelDeadline?.(); lease.release(); } };
  try {
    check();
    cancelDeadline = (io.armDeadline ?? (remainingMs => {
      const timer = setTimeout(() => process.exit(1), remainingMs);
      timer.unref();
      return () => clearTimeout(timer);
    }))(marker.deadlineAt - now());
    (io.onExit ?? (callback => { process.once("exit", callback); }))(release);
    return { check, complete: () => { check(); release(); } };
  } catch (error) { release(); throw error; }
}
