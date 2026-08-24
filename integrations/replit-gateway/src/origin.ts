export function canonicalizePublicOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("public origin must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("public origin must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("public origin must not include credentials");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("public origin must not include a path");
  }
  if (parsed.search) {
    throw new Error("public origin must not include a query");
  }
  if (parsed.hash) {
    throw new Error("public origin must not include a hash");
  }
  if (!parsed.hostname) {
    throw new Error("public origin must include a hostname");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function isAllowedPublicOrigin(origin: string): boolean {
  try {
    canonicalizePublicOrigin(origin);
    return true;
  } catch {
    return false;
  }
}

function normalizeUpstreamPathname(pathname: string): string {
  let normalized = pathname;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function validateUpstreamBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("upstream base URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("upstream base URL must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("upstream base URL must not include credentials");
  }
  if (parsed.search) {
    throw new Error("upstream base URL must not include a query");
  }
  if (parsed.hash) {
    throw new Error("upstream base URL must not include a hash");
  }
  const pathname = normalizeUpstreamPathname(parsed.pathname);
  return `${parsed.protocol}//${parsed.host}${pathname === "/" ? "" : pathname}`;
}

export function joinUpstreamEndpoint(baseUrl: string, endpointPath: string): string {
  const normalizedBase = validateUpstreamBaseUrl(baseUrl);
  const path = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  return `${normalizedBase}${path}`;
}
