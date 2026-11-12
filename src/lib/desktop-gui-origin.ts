import { canonicalHttpOrigin } from "./gui-pair-capability";

export const desktopGuiBinding = (config: { runtimeRole?: string; hostname?: string; port: number }): string =>
  JSON.stringify([config.runtimeRole ?? "standalone", config.hostname ?? "127.0.0.1", config.port]);

/** Desktop consent supports the ordinary localhost dashboard without widening remote pairing. */
export function desktopGuiOrigin(config: { runtimeRole?: string; hostname?: string; port: number }, value: string): string | null {
  const bind = config.hostname ?? "127.0.0.1";
  if ((config.runtimeRole ?? "standalone") !== "standalone" || !["127.0.0.1", "::1", "localhost"].includes(bind)) return null;
  if (canonicalHttpOrigin(value) !== value) return null;
  const origin = new URL(value);
  if (origin.protocol !== "http:" || Number(origin.port || "80") !== config.port) return null;
  const host = origin.hostname;
  return host === "localhost" || host === (bind === "::1" ? "[::1]" : bind)
    || bind === "localhost" && ["127.0.0.1", "[::1]"].includes(host) ? value : null;
}

export function hasDesktopForwardingHeaders(req: Request): boolean {
  return [...req.headers.keys()].some(name => name === "forwarded" || name === "x-real-ip"
    || name.startsWith("x-forwarded-") || name.startsWith("tailscale-"));
}
