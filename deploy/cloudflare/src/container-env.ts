// Kept free of Workers-only imports so tests/service/cloudflare-deploy.test.ts can drive it.

export type SecretSource = {
  OPENCODEX_API_AUTH_TOKEN?: string;
  OPENCODEX_ADMIN_AUTH_TOKEN?: string;
  OCX_BOOTSTRAP_CONFIG_JSON?: string;
  OCX_SNAPSHOT_INTERVAL_SECONDS?: string;
  /** Comma-separated names of further Worker secrets to expose to ocx, e.g. provider API keys. */
  OCX_PASSTHROUGH_SECRETS?: string;
};

/** The environment the container starts with. Named secrets are forwarded only when they are strings, never bindings. */
export function containerEnv(env: SecretSource): Record<string, string> {
  const values = env as Record<string, unknown>;
  const passthrough = (env.OCX_PASSTHROUGH_SECRETS ?? "").split(",").map(name => name.trim())
    .filter(name => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof values[name] === "string")
    .map(name => [name, values[name] as string] as const);
  const fixed = {
    OPENCODEX_API_AUTH_TOKEN: env.OPENCODEX_API_AUTH_TOKEN,
    OPENCODEX_ADMIN_AUTH_TOKEN: env.OPENCODEX_ADMIN_AUTH_TOKEN,
    OCX_BOOTSTRAP_CONFIG_JSON: env.OCX_BOOTSTRAP_CONFIG_JSON,
    OCX_SNAPSHOT_INTERVAL_SECONDS: env.OCX_SNAPSHOT_INTERVAL_SECONDS,
  };
  return Object.fromEntries([...passthrough, ...Object.entries(fixed)].filter((entry): entry is [string, string] => !!entry[1]));
}

/** Changes whenever any value the container was started with changes; stores no secret. */
export async function envFingerprint(env: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export type EdgeDecision = { forward: true } | { forward: false; status: number; message: string };

/**
 * A presence check, not authentication: ocx still decides every credential. It keeps anonymous
 * scanners from starting a billed container, and keeps the management API off the internet
 * unless the operator opted in with their own admin token.
 */
export function edgeDecision(req: Request, env: SecretSource & { OCX_EXPOSE_MANAGEMENT_API?: string }): EdgeDecision {
  if (!env.OPENCODEX_API_AUTH_TOKEN) {
    return { forward: false, status: 503, message: "OPENCODEX_API_AUTH_TOKEN is not set. Run `wrangler secret put OPENCODEX_API_AUTH_TOKEN`." };
  }
  const { pathname } = new URL(req.url);
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    // Without an operator-chosen token ocx generates one into its home, which is then in R2.
    if (env.OCX_EXPOSE_MANAGEMENT_API !== "1" || !env.OPENCODEX_ADMIN_AUTH_TOKEN) {
      return { forward: false, status: 404, message: "The management API is not exposed on this deployment." };
    }
  }
  // ocx answers CORS preflights without credentials; browsers never attach them to one.
  if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) return { forward: true };
  const presented = ["x-opencodex-api-key", "authorization", "x-api-key"].some(name => req.headers.get(name)?.trim())
    // Browser WebSockets cannot set headers; the audio stream carries its key as a subprotocol
    // (KEY_PROTOCOL_PREFIX in src/server/audio-client.ts).
    || (req.headers.get("sec-websocket-protocol") ?? "").split(",").some(value => value.trim().startsWith("opencodex-key."));
  if (!presented) return { forward: false, status: 401, message: "opencodex API key required" };
  return { forward: true };
}
