import { spawn as spawnProcess, type ChildProcess } from "node:child_process";

export type KeychainChild = ChildProcess;
export type KeychainReadResult = { status: "present"; value: string } | { status: "absent" } | { status: "unavailable" };
export type KeychainProbeResult = { status: "present" | "absent" | "unavailable" };
export interface ClaudeKeychainService {
  read(options?: { fresh?: boolean }): Promise<KeychainReadResult>;
  probe(): Promise<KeychainProbeResult>;
}
export interface ClaudeKeychainOptions {
  platform?: string;
  maxBytes?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  spawn?: (args: readonly string[], capture: boolean) => KeychainChild;
}

const SERVICE = "Claude Code-credentials";
const READ_DEADLINE_MS = 5000;
const PROBE_DEADLINE_MS = 1500;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FLIGHT_CALLERS = 256;
const unavailable = { status: "unavailable" } as const;
type Result = KeychainReadResult | KeychainProbeResult;
type Waiter = { resolve: (result: Result) => void; timer: unknown };
type Flight = {
  kind: "read" | "probe";
  spawned: boolean;
  exited: boolean;
  outputClosed: boolean;
  code: number | null;
  failed: boolean;
  quarantined: boolean;
  chunks: Buffer[];
  size: number;
  waiter?: Waiter;
  promise?: Promise<Result>;
  callers: number;
};

/** A process-local admission slot; an unavailable result is never evidence of absence. */
export function createClaudeKeychainService(options: ClaudeKeychainOptions = {}): ClaudeKeychainService {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const spawn = options.spawn ?? ((args, capture) => spawnProcess("/usr/bin/security", [...args], {
    stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
    shell: false,
  }));
  let slot: Flight | undefined;
  let cooldownUntil = 0;

  function settle(flight: Flight, result: Result): void {
    const waiter = flight.waiter;
    if (!waiter) return;
    flight.waiter = undefined;
    flight.callers = 0;
    clearTimer(waiter.timer);
    waiter.resolve(result);
  }
  function discard(flight: Flight): void {
    flight.chunks = [];
    flight.size = 0;
  }
  function finish(flight: Flight): void {
    if (!flight.exited || !flight.outputClosed || slot !== flight) return;
    let result: Result = unavailable;
    if (!flight.failed && !flight.quarantined) {
      if (flight.code === 44) result = { status: "absent" };
      else if (flight.code === 0) {
        result = flight.kind === "read"
          ? { status: "present", value: Buffer.concat(flight.chunks, flight.size).toString("utf8") }
          : { status: "present" };
      }
    }
    discard(flight);
    slot = undefined;
    if (result.status === "unavailable") cooldownUntil = now() + FAILURE_COOLDOWN_MS;
    settle(flight, result);
  }
  function fail(flight: Flight): void {
    flight.failed = true;
    discard(flight);
    settle(flight, unavailable);
  }
  function wait(flight: Flight): Promise<Result> {
    if (flight.callers >= MAX_FLIGHT_CALLERS) return Promise.resolve(unavailable);
    flight.callers++;
    if (flight.promise) return flight.promise;
    flight.promise = new Promise(resolve => {
      const waiter: Waiter = { resolve, timer: undefined };
      waiter.timer = setTimer(() => {
        flight.quarantined = true;
        discard(flight);
        settle(flight, unavailable);
      }, flight.kind === "read" ? READ_DEADLINE_MS : PROBE_DEADLINE_MS);
      flight.waiter = waiter;
    });
    return flight.promise;
  }
  function request(kind: "read" | "probe", fresh = false): Promise<Result> {
    if (platform !== "darwin") return Promise.resolve({ status: "absent" });
    if (slot) {
      if (fresh || slot.kind !== kind || slot.quarantined || slot.failed) return Promise.resolve(unavailable);
      return wait(slot);
    }
    if (now() < cooldownUntil) return Promise.resolve(unavailable);
    const flight: Flight = {
      kind, spawned: false, exited: false, outputClosed: kind === "probe", code: null,
      failed: false, quarantined: false, chunks: [], size: 0, callers: 0,
    };
    slot = flight;
    const result = wait(flight);
    let child: KeychainChild;
    try {
      child = spawn(["find-generic-password", "-s", SERVICE, ...(kind === "read" ? ["-w"] : [])], kind === "read");
    } catch {
      fail(flight);
      flight.exited = true;
      flight.outputClosed = true;
      finish(flight);
      return result;
    }
    // The caller timer owns the wait. A blocked system command and its pipes must not
    // keep the parent process alive after that wait has ended.
    child.unref?.();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as (typeof stream & { unref?: () => void }))?.unref?.();
    }
    child.once("spawn", () => { flight.spawned = true; });
    child.on("error", () => {
      fail(flight);
      // A spawn error with no PID means no child exists. After spawn, only exit proves termination.
      if (!flight.spawned && child.pid === undefined) {
        flight.exited = true;
        flight.outputClosed = true;
        finish(flight);
      }
    });
    child.once("exit", (code, signal) => {
      flight.exited = true;
      flight.code = signal === null ? code : null;
      finish(flight);
    });
    if (kind === "read") {
      const stdout = child.stdout;
      if (!stdout) {
        fail(flight);
        // No captured stream exists to hold open; still wait for child exit.
        flight.outputClosed = true;
      } else {
        let ended = false;
        stdout.on("data", (chunk: Buffer) => {
          if (flight.failed || flight.quarantined) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (bytes.length > maxBytes - flight.size) {
            fail(flight);
            return;
          }
          flight.chunks.push(bytes);
          flight.size += bytes.length;
        });
        stdout.on("error", () => { fail(flight); });
        stdout.once("end", () => { ended = true; });
        stdout.once("close", () => {
          if (!ended) fail(flight);
          flight.outputClosed = true;
          finish(flight);
        });
      }
    }
    return result;
  }
  return {
    read: options => request("read", options?.fresh) as Promise<KeychainReadResult>,
    probe: () => request("probe") as Promise<KeychainProbeResult>,
  };
}

/** Credential and metadata callers must use this same instance. */
export const claudeKeychain: ClaudeKeychainService = createClaudeKeychainService();
