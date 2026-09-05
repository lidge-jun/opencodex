/**
 * Optional Go sidecar supervision for the first incremental-takeover seam
 * (ADR-0008, devlog/_plan/260905_go_sidecar_takeover).
 *
 * The TypeScript front door keeps owning `GET /api/system/health`; this module
 * spawns, supervises, and forwards to a fresh Go binary (`go/cmd/ocx-sidecar`)
 * that serves that one route with byte-identical HTTP semantics. The Go body
 * carries the sidecar's own pid and uptime; status, service, and version equal
 * the TypeScript values because the parent passes the package version at spawn
 * time.
 *
 * Strictly optional and default-OFF. A process that never activates the
 * sidecar (no `OPENCODEX_GO_SIDECAR_BIN`) executes no spawn and imports no
 * runtime state beyond this module's own: core route files consult the
 * core-owned slot in `./go-sidecar-slot.ts`, which is empty unless this module
 * registered its forwarder at activation (the AGENTS.md optional-subsystem
 * pattern, same shape as `passive-route-linker.ts`).
 *
 * The supervision model is deliberately small for a first increment: spawn,
 * wait for the ready line, register the forwarder, and on an unexpected child
 * exit deregister (falling back to the in-process TypeScript handler) and log.
 * There is no respawn loop yet; that is a later increment once the seam has
 * live evidence.
 */
import { existsSync } from "node:fs";
import { directLocalHttpFetch } from "./direct-local-http";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { setGoSidecarHealthForwarder } from "./go-sidecar-slot";

/** Environment variable naming the ocx-sidecar binary to spawn. */
export const GO_SIDECAR_BIN_ENV = "OPENCODEX_GO_SIDECAR_BIN";

/** Environment variable the parent uses to pass the installed package version. */
export const GO_SIDECAR_VERSION_ENV = "OCX_SIDECAR_VERSION";

/** Readiness marker the Go binary prints on stdout after binding. */
export const GO_SIDECAR_READY_PREFIX = "ocx-sidecar-ready";

/** How long the front door waits for the child's ready line before giving up. */
export const GO_SIDECAR_READY_TIMEOUT_MS = 10_000;

/**
 * The declared volatile field set of the health payload. Byte comparisons of
 * the two implementations must normalise exactly these fields and nothing else,
 * so the oracle cannot silently widen what "equal" means. Mirrored by the Bun
 * differential harness in tests/go-sidecar-parity.test.ts.
 */
export const GO_SIDECAR_VOLATILE_FIELDS = ["pid", "uptime"] as const;

type KillableChild = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  kill(): unknown;
  unref?(): unknown;
};

let childProc: KillableChild | null = null;
let stopped = true;
let readyBaseUrl = "";
let generation = 0;
let forwardDetach: (() => void) | null = null;

/** Test-only reset so an isolated harness does not inherit a live child. */
export function resetGoSidecarForTests(): void {
  if (!stopped) stopSidecar();
}

/** Base URL of the attached sidecar, or null when none is attached and ready. */
export function activeGoSidecarBaseUrl(): string | null {
  return stopped ? null : readyBaseUrl || null;
}

function parseReadyLine(line: string): string | null {
  const trimmed = line.trim();
  const prefix = `${GO_SIDECAR_READY_PREFIX} http://`;
  if (!trimmed.startsWith(prefix)) return null;
  const url = trimmed.slice(prefix.length).trim();
  if (!url) return null;
  try {
    const parsed = new URL(`http://${url}`);
    // Loopback-only by construction: the sidecar binds 127.0.0.1. Refuse any
    // other host on the ready line instead of forwarding health to it.
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    return `http://${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * Read the child's stdout until its ready line or the deadline. Resolves to
 * the parsed base URL, or null when the child exited or timed out without
 * announcing. Called off the activation call stack, never inside the
 * synchronous startServer window.
 */
async function waitForReadyLine(proc: KillableChild, timeoutMs: number): Promise<string | null> {
  if (!proc.stdout) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    const reader = proc.stdout.getReader();
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        return null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<{ done: true; value: undefined }>(resolve => {
        timer = setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, remaining));
        // The deadline must not keep the process alive if a read settles first.
        if (typeof timer.unref === "function") timer.unref();
      });
      let outcome: { done: true; value?: undefined } | { done: false; value?: Uint8Array };
      try {
        outcome = await Promise.race([
          reader.read(),
          proc.exited.then(() => ({ done: true as const, value: undefined })),
          timedOut,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (outcome.done) {
        await reader.cancel().catch(() => {});
        return null;
      }
      const chunk = outcome.value;
      if (chunk === undefined || chunk.byteLength === 0) continue;
      buffer += decoder.decode(chunk, { stream: true });
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const parsed = parseReadyLine(buffer.slice(0, newline));
        if (parsed) {
          // Detach; the rest of the child's stdout is not ours to interpret.
          await reader.cancel().catch(() => {});
          return parsed;
        }
      }
    }
  } catch {
    return null;
  }
}

function warnActivation(message: string): void {
  console.warn(`[go-sidecar] ${message}; serving health in-process`);
}

/** Forward one health request to a ready sidecar, or null on any failure. */
async function forwardTo(baseUrl: string): Promise<Response | null> {
  try {
    const upstream = await directLocalHttpFetch(new URL("/api/system/health", baseUrl), {
      headers: { accept: "application/json" },
    });
    if (!upstream.ok) return null;
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return null;
  }
}

function stopSidecar(): void {
  if (stopped) return;
  stopped = true;
  if (forwardDetach) {
    forwardDetach();
    forwardDetach = null;
  }
  const proc = childProc;
  childProc = null;
  readyBaseUrl = "";
  if (proc) {
    try {
      proc.kill();
    } catch { /* already exited */ }
    try {
      proc.unref?.();
    } catch { /* already gone */ }
  }
}

/**
 * Activate the Go sidecar: spawn the binary named by OPENCODEX_GO_SIDECAR_BIN
 * and start supervising it. Returns a stop handle when a child was spawned, or
 * null when the env var is absent or the binary is unusable (a warned no-op,
 * so a misconfigured opt-in never takes the proxy down at startup).
 *
 * Synchronous by contract: `startServer` calls this inside its synchronous
 * activation window (see tests/core-lab-boundary.test.ts), so readiness is
 * awaited off the call stack and the forwarder is registered into the
 * core-owned slot (`go-sidecar-slot.ts`) once the ready line lands. Until then
 * — and after any unexpected exit — the slot is empty and the in-process
 * handler answers, byte-identically to a build without Go.
 */
export function activateGoSidecar(version: string): { stop(): void } | null {
  const binary = process.env[GO_SIDECAR_BIN_ENV]?.trim();
  if (!binary) return null;
  if (!existsSync(binary)) {
    warnActivation(`${GO_SIDECAR_BIN_ENV}=${binary} does not exist`);
    return null;
  }

  let proc: KillableChild;
  try {
    proc = Bun.spawn([binary], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        [GO_SIDECAR_VERSION_ENV]: version,
      },
    });
  } catch (error) {
    warnActivation(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (!stopped) stopSidecar();
  const myGeneration = ++generation;
  stopped = false;
  childProc = proc;
  readyBaseUrl = "";
  // The optional-subsystem shutdown hook is keyed, so a re-activation replaces
  // the previous registration instead of accumulating duplicate teardown.
  registerOptionalShutdownHook("go-sidecar", stopSidecar);

  // Child-exit supervision: an unexpected exit deregisters the forwarder so
  // the front door falls back to the in-process handler, and logs once.
  const onExit = (reason: string): void => {
    if (stopped || myGeneration !== generation) return;
    stopSidecar();
    warnActivation(`sidecar ${reason}`);
  };
  void proc.exited.then(
    () => onExit("exited unexpectedly"),
    () => onExit("terminated unexpectedly"),
  );

  void waitForReadyLine(proc, GO_SIDECAR_READY_TIMEOUT_MS).then(parsed => {
    if (stopped || myGeneration !== generation) return;
    if (!parsed) {
      stopSidecar();
      warnActivation(`no ready line within ${GO_SIDECAR_READY_TIMEOUT_MS}ms`);
      return;
    }
    if (stopped || myGeneration !== generation) return;
    readyBaseUrl = parsed;
    const baseUrl = parsed;
    const detach = setGoSidecarHealthForwarder(() => forwardTo(baseUrl));
    if (stopped || myGeneration !== generation) {
      detach();
      return;
    }
    forwardDetach = detach;
    console.log(`[go-sidecar] ocx-sidecar attached at ${parsed}; GET /api/system/health served by Go`);
  });

  return { stop: stopSidecar };
}
