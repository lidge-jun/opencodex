/**
 * DNS-free endpoint fingerprint for routing-time route subject construction.
 * Mirrors the snapshot fields hashed in `createLabDestination` without resolution.
 */
import { localFingerprint } from "../../lab/digest";

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface EndpointFingerprintParts {
  scheme: "http" | "https";
  host: string;
  port: number;
  basePath: string;
}

/** Parse and normalize a provider base URL without network I/O. */
export function parseEndpointFingerprintParts(baseUrl: string): EndpointFingerprintParts | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const scheme = parsed.protocol === "https:" ? "https" as const : "http" as const;
    const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      scheme,
      host: parsed.hostname.toLowerCase(),
      port,
      basePath: normalizeBasePath(parsed.pathname),
    };
  } catch {
    return null;
  }
}

export function endpointFingerprintFromBaseUrl(
  baseUrl: string,
  installationSalt: Uint8Array | string,
): string | null {
  const parts = parseEndpointFingerprintParts(baseUrl);
  if (!parts) return null;
  return localFingerprint("endpoint", {
    scheme: parts.scheme,
    host: parts.host,
    port: parts.port,
    basePath: parts.basePath,
  }, installationSalt);
}
