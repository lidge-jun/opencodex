/** A failed connect cannot distinguish an absent loopback address from a slow owner. */
export type LoopbackFamilyAvailability = "available" | "unavailable" | "unknown";

function bindLoopback(hostname: string): { stop(): void } {
  return Bun.listen({ hostname, port: 0, socket: { data(socket) { socket.end(); } } });
}

/**
 * Ask the kernel whether the concrete local address can be bound, independently of
 * routing/connect timeouts. Only address/family absence permits skipping discovery;
 * permissions, resource exhaustion and other failures leave owner evidence unknown.
 * The ephemeral listener is closed synchronously and never accepts client traffic.
 */
export function loopbackFamilyAvailability(
  hostname: string,
  bindFn: (hostname: string) => { stop(): void } = bindLoopback,
): LoopbackFamilyAvailability {
  const address = hostname === "[::1]" ? "::1" : hostname;
  if (address !== "::1" && address !== "127.0.0.1") return "unknown";
  let listener: { stop(): void };
  try {
    listener = bindFn(address);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT"
      || code === "EPROTONOSUPPORT"
      ? "unavailable" : "unknown";
  }
  listener.stop();
  return "available";
}
