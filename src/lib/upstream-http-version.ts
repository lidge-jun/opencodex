import type { OcxProviderConfig, UpstreamHttpVersion } from "../types";

/** True when a provider explicitly selected the HTTP/1.1 compatibility path. */
export function isPinnedHttp1(version: UpstreamHttpVersion | undefined): boolean {
  return version === "http1.1" || version === "h1";
}

/**
 * Bun's fetch accepts a non-standard `protocol` init to pin the HTTP version
 * (BunFetchRequestInit.protocol). The DOM lib types do not include it, so the
 * value is represented through a RequestInit cast at this shared boundary.
 */
const UPSTREAM_HTTP_VERSION_PROTOCOL: Record<Exclude<UpstreamHttpVersion, "auto">, string> = {
  "http1.1": "http1.1",
  h1: "h1",
  http2: "http2",
  h2: "h2",
};

/** Raised before I/O when a fixed Bun HTTP-version pin cannot apply to the target URL. */
export class UpstreamHttpVersionTargetError extends Error {
  readonly code = "upstream_http_version_target";

  constructor(readonly observedProtocol: string) {
    super(`upstream HTTP version pin requires an HTTPS target (received ${observedProtocol})`);
    this.name = "UpstreamHttpVersionTargetError";
  }
}

/** Attach Bun's `protocol` pin for one explicit version value. */
export function withUpstreamHttpVersionValue(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  version: UpstreamHttpVersion | undefined,
): RequestInit | undefined {
  if (!version || version === "auto") return init;
  // Bun's protocol pin requires an https: target. An explicit fixed-version request must fail
  // locally when the pin cannot be honored instead of silently negotiating another transport.
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    throw new UpstreamHttpVersionTargetError("unparseable");
  }
  if (targetUrl.protocol !== "https:") throw new UpstreamHttpVersionTargetError(targetUrl.protocol);
  return { ...(init ?? {}), protocol: UPSTREAM_HTTP_VERSION_PROTOCOL[version] } as RequestInit;
}

/** Attach Bun's `protocol` pin when the provider opted into a fixed HTTP version. */
export function withUpstreamHttpVersion(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  provider: Pick<OcxProviderConfig, "upstreamHttpVersion">,
): RequestInit | undefined {
  return withUpstreamHttpVersionValue(input, init, provider.upstreamHttpVersion);
}
