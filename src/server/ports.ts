import { createServer } from "node:net";

/**
 * True when an error means "this port/address is already bound" — the only bind failure
 * that is safe to answer with a retry on another port. Bun/Node surface it as
 * `code: "EADDRINUSE"` or an EADDRINUSE / "address in use" message depending on the API.
 */
export function isAddrInUse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "EADDRINUSE") return true;
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return text.includes("eaddrinuse") || text.includes("in use");
}

export async function isPortAvailable(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  return await new Promise(resolve => {
    const server = createServer();
    // Fail closed: EACCES / EADDRNOTAVAIL / EPERM / unknown listen errors mean the
    // requested bind is not available. Only the listening event reports free.
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: hostname });
  });
}

export type WaitForPortOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

/** Poll until `port` accepts a bind, or until the timeout elapses. */
export async function waitForPortAvailable(
  port: number,
  hostname = "127.0.0.1",
  opts: WaitForPortOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortAvailable(port, hostname)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export type FindAvailablePortOptions = {
  /** How long to keep retrying the preferred port before falling back to an ephemeral port. */
  preferRetryMs?: number;
  preferRetryIntervalMs?: number;
  /**
   * When false, never bind `port: 0` — prefer-retry then throw if the preferred port
   * stays busy. Used for explicit `ocx start --port N` and service-baked pins so an
   * update restart cannot hop to a random ephemeral listener (PR #152 gap).
   */
  allowEphemeralFallback?: boolean;
  /**
   * A port this selection must never return, even when it is free (#1102).
   *
   * The unauthenticated loopback listener binds a fixed port from config. If the public
   * listener took that port first — via an explicit `--port`, a `config.port` of 0, or the
   * ephemeral fallback happening to land on it — the loopback bind would then fail with
   * EADDRINUSE, and the startup transaction would roll back a public listener that had
   * nothing wrong with it. Excluding the port here fails the right thing at the right time.
   */
  reservedPort?: number;
};

export class PortUnavailableError extends Error {
  readonly port: number;
  constructor(port: number, hostname: string) {
    super(`Port ${port} on ${hostname} is still busy after prefer-retry; refusing ephemeral fallback.`);
    this.name = "PortUnavailableError";
    this.port = port;
  }
}

export async function findAvailablePort(
  preferredPort: number,
  hostname = "127.0.0.1",
  opts: FindAvailablePortOptions = {},
): Promise<number> {
  const preferRetryMs = opts.preferRetryMs ?? 0;
  const allowEphemeral = opts.allowEphemeralFallback !== false;
  const reserved = opts.reservedPort;
  // An explicit preference for the reserved port is a configuration mistake, not a busy
  // socket: retrying or hopping would hide it. Refuse before probing anything.
  if (reserved !== undefined && preferredPort === reserved) {
    throw new PortUnavailableError(preferredPort, hostname);
  }
  // Port 0 asks the OS to select an ephemeral port. Resolve it to that concrete
  // port here so callers never persist or advertise an unusable `:0` endpoint.
  if (preferredPort > 0 && preferRetryMs > 0) {
    if (await waitForPortAvailable(preferredPort, hostname, {
      timeoutMs: preferRetryMs,
      intervalMs: opts.preferRetryIntervalMs ?? 50,
    })) {
      return preferredPort;
    }
  } else if (preferredPort > 0 && (await isPortAvailable(preferredPort, hostname))) {
    return preferredPort;
  }

  if (!allowEphemeral) {
    throw new PortUnavailableError(preferredPort, hostname);
  }

  // Bounded, not recursive. The OS can hand back the reserved port, and a redraw practically
  // always differs — but "practically always" is not a termination argument, and an unbounded
  // async recursion has no way to stop if the assumption is ever wrong.
  for (let attempt = 0; attempt < EPHEMERAL_REDRAW_LIMIT; attempt += 1) {
    const port = await allocateEphemeralPort(hostname);
    if (port !== reserved) return port;
  }
  throw new Error("failed to allocate an available port");
}

/** How many times an ephemeral draw may come back reserved before we give up. */
const EPHEMERAL_REDRAW_LIMIT = 8;

/** Test seam: replace the OS ephemeral allocator so the redraw path is reachable. */
let ephemeralAllocator: ((hostname: string) => Promise<number>) | null = null;

export function setEphemeralPortAllocatorForTests(
  allocator: ((hostname: string) => Promise<number>) | null,
): void {
  ephemeralAllocator = allocator;
}

async function allocateEphemeralPort(hostname: string): Promise<number> {
  if (ephemeralAllocator) return ephemeralAllocator(hostname);
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("failed to allocate an available port"));
      });
    });
    server.listen({ port: 0, host: hostname });
  });
}

export function shouldPersistSelectedPort(
  configPort: number | undefined,
  selectedPort: number,
  preferredPort: number,
): boolean {
  return selectedPort === preferredPort && configPort !== selectedPort;
}
