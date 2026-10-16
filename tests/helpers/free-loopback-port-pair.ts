type PortProbe = { port: number; stop(force: boolean): void };
type BindProbe = (port: number) => PortProbe;

const MAX_ATTEMPTS = 100;

/** Probe adjacent loopback ports without leaking listeners or hiding bind failures. */
export function freeLoopbackPortPair(bind: BindProbe = port => Bun.listen({
  hostname: "127.0.0.1", port, socket: { data() {} },
})): number {
  let lastCollision: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let origin: PortProbe | undefined;
    let entry: PortProbe | undefined;
    try {
      try {
        origin = bind(0);
        if (origin.port >= 65535) continue;
        entry = bind(origin.port + 1);
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EADDRINUSE") throw error;
        lastCollision = error;
        continue;
      }
      return origin.port;
    } finally {
      // Cleanup failures must propagate, not be mistaken for another bind collision.
      try { entry?.stop(true); } finally { origin?.stop(true); }
    }
  }
  throw new Error(`Could not find a free loopback port pair after ${MAX_ATTEMPTS} attempts`, { cause: lastCollision });
}
