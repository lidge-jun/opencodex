/**
 * Port contract for the client side of a link: the loopback port P that the client's
 * `ssh -L` tunnel listens on. Privileged ports are refused so that an ordinary user
 * process can always bind it. The hub listener port L is chosen by the OS and keeps the
 * plain 1-65535 range; it does not use this contract.
 */
export const MIN_LINK_PORT = 1024;
export const MAX_LINK_PORT = 65535;

/**
 * A Child joining from its dashboard picks its tunnel port from this range. It sits below the
 * common OS ephemeral ranges (macOS and Windows 49152-65535, Linux 32768-60999), so an outgoing
 * connection that happens to hold the port rarely blocks the tunnel when it comes back after a
 * reboot. The persisted port of an existing link is never rewritten.
 */
export const JOIN_TUNNEL_PORT_MIN = 20_000;
export const JOIN_TUNNEL_PORT_MAX = 29_999;

export function isLinkPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_LINK_PORT && value <= MAX_LINK_PORT;
}
