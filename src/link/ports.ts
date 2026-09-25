/**
 * Port contract for the client side of a link: the loopback port P that the client's
 * `ssh -L` tunnel listens on. Privileged ports are refused so that an ordinary user
 * process can always bind it. The hub listener port L is chosen by the OS and keeps the
 * plain 1-65535 range; it does not use this contract.
 */
export const MIN_LINK_PORT = 1024;
export const MAX_LINK_PORT = 65535;

export function isLinkPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_LINK_PORT && value <= MAX_LINK_PORT;
}
