import { canonicalHttpOrigin } from "./gui-pair-capability";

export const desktopGuiBinding = (config: { runtimeRole?: string; hostname?: string; port: number }): string =>
  JSON.stringify([config.runtimeRole ?? "standalone", config.hostname ?? "127.0.0.1", config.port]);

/**
 * Consent is only for this process's configured literal loopback origin, the same bind set
 * `standaloneGuiPairingOrigin` admits: `127.0.0.1` or `::1`. The page may be opened through
 * `localhost`, which is the browser's alias for that literal listener, but a `localhost` BIND is
 * not admitted: `startServer` canonicalizes it to `127.0.0.1` before listening
 * (`src/server/bind-host.ts`), so the configured spelling never names the origin that is served
 * and the printed command could not succeed. No alias is ever normalized into another origin:
 * the returned value is exactly `value`, so every caller's exact-origin, session and CSRF
 * comparison keeps its meaning.
 */
export function desktopGuiOrigin(config: { runtimeRole?: string; hostname?: string; port: number }, value: string): string | null {
  const bind = config.hostname ?? "127.0.0.1";
  if ((config.runtimeRole ?? "standalone") !== "standalone" || (bind !== "127.0.0.1" && bind !== "::1")) return null;
  if (canonicalHttpOrigin(value) !== value) return null;
  const origin = new URL(value);
  if (origin.protocol !== "http:" || Number(origin.port || "80") !== config.port) return null;
  return origin.hostname === "localhost" || origin.hostname === (bind === "::1" ? "[::1]" : bind) ? value : null;
}

export function hasDesktopForwardingHeaders(req: Request): boolean {
  return [...req.headers.keys()].some(name => name === "forwarded" || name === "x-real-ip"
    || name.startsWith("x-forwarded-") || name.startsWith("tailscale-"));
}
