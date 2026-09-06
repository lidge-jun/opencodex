/**
 * Optional Go sidecar supervision for the first incremental-takeover seam
 * (ADR-0008, devlog/_plan/260905_go_sidecar_takeover).
 *
 * The TypeScript front door keeps owning dispatch for every management route;
 * this module spawns, supervises, and forwards declared Go-owned management routes to a fresh Go
 * binary (`go/cmd/ocx-sidecar`) that serves them with byte-identical HTTP semantics.
 * Which routes are forwarded is DATA, not code: the ownership markers live in
 * `src/server/management/route-registry.ts`, and `management-api.ts` consults them
 * before asking this module's forwarder. The Go body carries the sidecar's own pid and
 * uptime; status, service, and version equal the TypeScript values because the parent
 * passes the package version at spawn time.
 *
 * Strictly optional and default-OFF. A process that never activates the
 * sidecar (no `OPENCODEX_GO_SIDECAR_BIN`) executes no spawn and imports no
 * runtime state beyond this module's own: core route files consult the
 * core-owned slot in `./go-sidecar-slot.ts`, which is empty unless this module
 * registered its forwarder at activation (the AGENTS.md optional-subsystem
 * pattern, same shape as `passive-route-linker.ts`).
 *
 * The supervision model is deliberately small for the first increments: spawn,
 * wait for the ready line, register the forwarder, and on an unexpected child
 * exit deregister (falling back to the in-process TypeScript handler) and log.
 * There is no respawn loop yet; that is a later increment once the seam has
 * live evidence.
 */
import { existsSync } from "node:fs";
import { directLocalHttpFetch } from "./direct-local-http";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { setGoOwnedRouteForwarder } from "./go-sidecar-slot";
import { HOT_PATH_SEAM_PATH, HOT_PATH_SIDECAR_REQUEST_HEADER } from "./hot-path-seam";
import { forwardGoWebSocketFrames } from "./go-sidecar-ws-bridge";

/** Environment variable naming the ocx-sidecar binary to spawn. */
export const GO_SIDECAR_BIN_ENV = "OPENCODEX_GO_SIDECAR_BIN";

/** Environment variable the parent uses to pass the installed package version. */
export const GO_SIDECAR_VERSION_ENV = "OCX_SIDECAR_VERSION";

/** Parent loopback endpoint used only by the sidecar live-state bridge. */
export const GO_SIDECAR_PARENT_URL_ENV = "OCX_SIDECAR_PARENT_URL";

/** Capability presented by the child when reading parent-owned live state. */
export const GO_SIDECAR_BRIDGE_TOKEN_ENV = "OCX_SIDECAR_BRIDGE_TOKEN";

/** Capability presented by the parent when forwarding to the sidecar. */
export const GO_SIDECAR_REQUEST_TOKEN_ENV = "OCX_SIDECAR_REQUEST_TOKEN";

/** HMAC secret for parent-admission claims on Go-owned write routes. */
export const GO_SIDECAR_WRITE_RELAY_SECRET_ENV = "OCX_SIDECAR_WRITE_RELAY_SECRET";

/** Readiness marker the Go binary prints on stdout after binding. */
export const GO_SIDECAR_READY_PREFIX = "ocx-sidecar-ready";

/** How long the front door waits for the child's ready line before giving up. */
export const GO_SIDECAR_READY_TIMEOUT_MS = 10_000;

/** Quota aggregation may await provider probes; keep one refresh attempt alive. */
export const GO_SIDECAR_QUOTA_ROUTE_TIMEOUT_MS = 30_000;

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
let bridgeStopped: (() => void) | null = null;

// Data-plane hot-path seam state (ticket #24, devlog 034). Set once the ready
// line lands, independently of the seam env: the front door decides whether to
// use it (OPENCODEX_GO_HOTPATH_SEAM) so an operator flipping the env at runtime
// is honoured, while the capability pair below stays fixed per activation.
let dataPlaneSeam: { baseUrl: string; requestToken: string } | null = null;

export type GoSidecarSupervisorConfig = {
  parentUrl: string;
  bridgeToken: string;
  requestToken: string;
  writeRelaySecret: string;
  /** Mints a proof bound to one admitted write's method, path and body bytes. */
  createWriteRelayHeaders?: (request: {
    method: string;
    pathname: string;
    body: Uint8Array;
    principal?: import("./management-auth").ManagementPrincipal;
  }) => HeadersInit | null;
  onStopped(): void;
};

/** Test-only reset so an isolated harness does not inherit a live child. */
export function resetGoSidecarForTests(): void {
  if (!stopped) stopSidecar();
}

/** Base URL of the attached sidecar, or null when none is attached and ready. */
export function activeGoSidecarBaseUrl(): string | null {
  return stopped ? null : readyBaseUrl || null;
}

/**
 * True when the sidecar is attached AND ready to serve the data-plane seam.
 * The front door consults this only after its own env gate, and only before
 * reading the request body: a seam that is not attached must never consume a
 * body it cannot fall back from.
 */
export function isDataPlaneSeamAttached(): boolean {
  return !stopped && dataPlaneSeam !== null && readyBaseUrl !== "";
}

export async function forwardGoResponsesWebSocket(
  frame: Record<string, unknown>,
  admission: unknown,
  onFrame: (text: string) => void,
): Promise<boolean> {
  const seam = dataPlaneSeam;
  if (!seam || stopped) return false;
  let sent = false;
  try {
    await forwardGoWebSocketFrames(seam.baseUrl, seam.requestToken, frame, admission, text => {
      sent = true;
      onFrame(text);
    });
    return true;
  } catch {
    // Once the child has started a turn its frames are observable. Do not
    // synthesize a second error turn after a partial relay.
    return sent;
  }
}

/**
 * Forward one seam-gated POST /v1/responses request to the attached sidecar
 * with the parent request token and the front-door claim headers. Returns the
 * sidecar's Response (status and stream verbatim) or null when the seam is not
 * attached or the hop failed. Never throws.
 */
export async function forwardHotPathSeam(
  request: Request,
  body: Uint8Array<ArrayBuffer>,
  claimHeaders: Headers,
): Promise<Response | null> {
  const seam = dataPlaneSeam;
  if (!seam || stopped) return null;
  const target = new URL(HOT_PATH_SEAM_PATH, seam.baseUrl);
  try {
    const headers = new Headers(claimHeaders);
    headers.set(HOT_PATH_SIDECAR_REQUEST_HEADER, seam.requestToken);
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    // This is a non-credential surface attribution marker. It must survive the
    // tightly allowlisted seam so the Go relay can decline Grok traffic and the
    // TypeScript bridge can preserve the request's observable surface.
    if (request.headers.get("x-opencodex-grok") === "1") {
      headers.set("x-opencodex-grok", "1");
    }
    const upstream = await directLocalHttpFetch(target, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
    // A 4xx/5xx from the seam is its observable result (the bridge ran the
    // pipeline); it must reach the client rather than being swallowed.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        ...(upstream.headers.has("retry-after")
          ? { "retry-after": upstream.headers.get("retry-after")! }
          : {}),
      },
    });
  } catch {
    return null;
  }
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
    // other host on the ready line instead of forwarding management reads to it.
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

/** Build sidecar headers without forwarding browser credentials or cookies. */
export function goSidecarRelayHeaders(request: Request, requestToken: string, relayHeaders: HeadersInit | null | undefined): Headers {
  const headers = new Headers(relayHeaders ?? undefined);
  headers.set("accept", "application/json");
  headers.set("x-ocx-go-sidecar-request", requestToken);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

/** Forward one declared Go-owned route request to a ready sidecar, or null on any failure. */
async function forwardTo(
  baseUrl: string,
  requestToken: string,
  createWriteRelayHeaders: GoSidecarSupervisorConfig["createWriteRelayHeaders"],
  request: Request,
  pathAndSearch: string,
  principal?: import("./management-auth").ManagementPrincipal,
): Promise<Response | null> {
  try {
    const target = new URL(pathAndSearch, baseUrl);
    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    const body = isWrite ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const relayHeaders = isWrite
      ? createWriteRelayHeaders?.({ method: request.method, pathname: target.pathname, body: body!, principal }) ?? null
      : undefined;
    // Go writes require a parent-minted, body-bound proof; otherwise use the
    // in-process handler, which still owns the original request body.
    if (isWrite && relayHeaders === null) return null;
    const upstream = await directLocalHttpFetch(target, {
      method: request.method,
      headers: goSidecarRelayHeaders(request, requestToken, relayHeaders ?? undefined),
      body,
      signal: request.signal,
    }, pathAndSearch.startsWith("/api/provider-quotas") || pathAndSearch.startsWith("/api/usage")
      ? { timeoutMs: GO_SIDECAR_QUOTA_ROUTE_TIMEOUT_MS }
      : undefined);
    // A Go-owned write's 4xx/5xx response is its observable result. Falling
    // through on it would execute the legacy mutation a second time. Reads
    // retain the existing fallback-on-non-2xx supervision behavior.
    if (!upstream.ok && !isWrite) return null;
    // Relay the sidecar's response with the in-process handler's header shape:
    // Content-Type plus the body verbatim. The management-API CORS wrapper adds
    // the shared headers downstream exactly as it does for an in-process route.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...(upstream.headers.has("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}),
      },
    });
  } catch {
    return null;
  }
}

function stopSidecar(): void {
  if (stopped) return;
  stopped = true;
  const notifyBridgeStopped = bridgeStopped;
  bridgeStopped = null;
  notifyBridgeStopped?.();
  if (forwardDetach) {
    forwardDetach();
    forwardDetach = null;
  }
  const proc = childProc;
  childProc = null;
  readyBaseUrl = "";
  dataPlaneSeam = null;
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
export function activateGoSidecar(
  version: string,
  liveStateBridge: GoSidecarSupervisorConfig,
): { stop(): void } | null {
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
        [GO_SIDECAR_PARENT_URL_ENV]: liveStateBridge.parentUrl,
        [GO_SIDECAR_BRIDGE_TOKEN_ENV]: liveStateBridge.bridgeToken,
        [GO_SIDECAR_REQUEST_TOKEN_ENV]: liveStateBridge.requestToken,
        [GO_SIDECAR_WRITE_RELAY_SECRET_ENV]: liveStateBridge.writeRelaySecret,
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
  bridgeStopped = liveStateBridge.onStopped;
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
    // The data-plane seam is armed whenever the sidecar is attached; whether
    // the front door uses it is the seam env gate's decision, read per request.
    dataPlaneSeam = { baseUrl, requestToken: liveStateBridge.requestToken };
    const detach = setGoOwnedRouteForwarder((request, pathAndSearch, principal) => (
      forwardTo(baseUrl, liveStateBridge.requestToken, liveStateBridge.createWriteRelayHeaders, request, pathAndSearch, principal)
    ));
    if (stopped || myGeneration !== generation) {
      detach();
      return;
    }
    forwardDetach = detach;
    console.log(`[go-sidecar] ocx-sidecar attached at ${parsed}; declared Go-owned routes served by Go`);
  });

  return { stop: stopSidecar };
}
