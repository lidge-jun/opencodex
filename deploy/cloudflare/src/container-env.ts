// Kept free of Workers-only imports so tests/service/cloudflare-deploy.test.ts can drive it.

export type SecretSource = {
  OPENCODEX_API_AUTH_TOKEN?: string;
  OPENCODEX_ADMIN_AUTH_TOKEN?: string;
  OCX_BOOTSTRAP_CONFIG_JSON?: string;
  OCX_SNAPSHOT_INTERVAL_SECONDS?: string;
  /** Comma-separated names of further Worker secrets to expose to ocx, e.g. provider API keys. */
  OCX_PASSTHROUGH_SECRETS?: string;
};

// Names that steer the process instead of carrying a credential: a passthrough entry must not be
// able to move the state roots, preload code, or reroute outbound traffic.
const REFUSED_PASSTHROUGH = new Set([
  "HOME", "OPENCODEX_HOME", "CODEX_HOME", "TMPDIR", "PATH", "NODE_ENV", "NODE_OPTIONS", "BUN_OPTIONS",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
]);
const warnedRefusals = new Set<string>();

function passthroughAllowed(name: string): boolean {
  if (!REFUSED_PASSTHROUGH.has(name) && !name.startsWith("LD_")) return true;
  // containerEnv runs on every request; one warning per name is enough.
  if (!warnedRefusals.has(name)) {
    warnedRefusals.add(name);
    console.warn(`OCX_PASSTHROUGH_SECRETS: refusing ${name}, which controls the process rather than carrying a secret.`);
  }
  return false;
}

/** The environment the container starts with. Named secrets are forwarded only when they are strings, never bindings. */
export function containerEnv(env: SecretSource): Record<string, string> {
  const values = env as Record<string, unknown>;
  const passthrough = (env.OCX_PASSTHROUGH_SECRETS ?? "").split(",").map(name => name.trim())
    .filter(name => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof values[name] === "string" && passthroughAllowed(name))
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

export type EdgeEnv = SecretSource & { OCX_EXPOSE_MANAGEMENT_API?: string; OCX_EDGE_KEY_CHECK?: string };

// Browser WebSockets cannot set headers; the audio stream carries its key as a subprotocol
// (KEY_PROTOCOL_PREFIX in src/server/audio-client.ts), base64url-encoded without padding.
const KEY_PROTOCOL_PREFIX = "opencodex-key.";

/** The credentials a request presents, in the forms ocx reads them (src/server/auth-cors.ts). */
function presentedKeys(req: Request): string[] {
  const keys = [
    req.headers.get("x-opencodex-api-key")?.trim(),
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim(),
    req.headers.get("x-api-key")?.trim(),
  ].filter((key): key is string => !!key);
  for (const value of (req.headers.get("sec-websocket-protocol") ?? "").split(",")) {
    const protocol = value.trim();
    if (protocol.startsWith(KEY_PROTOCOL_PREFIX)) keys.push(protocol);
  }
  return keys;
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Comparing digests keeps the time independent of where, or whether, the strings differ in length.
async function secretEquals(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Keeps unauthenticated requests from starting a billed container: by default a request must carry
 * the data token. ocx still decides every credential. Keys issued through config.apiKeys live in the
 * saved state where the Worker cannot see them, so a hub that hands those out sets
 * OCX_EDGE_KEY_CHECK=presence and accepts any non-empty key here instead.
 */
export async function edgeDecision(req: Request, env: EdgeEnv): Promise<EdgeDecision> {
  if (!env.OPENCODEX_API_AUTH_TOKEN) {
    return { forward: false, status: 503, message: "OPENCODEX_API_AUTH_TOKEN is not set. Run `wrangler secret put OPENCODEX_API_AUTH_TOKEN`." };
  }
  const { pathname } = new URL(req.url);
  const management = pathname === "/api" || pathname.startsWith("/api/");
  if (management) {
    // Without an operator-chosen token ocx generates one into its home, which is then in R2.
    if (env.OCX_EXPOSE_MANAGEMENT_API !== "1" || !env.OPENCODEX_ADMIN_AUTH_TOKEN) {
      return { forward: false, status: 404, message: "The management API is not exposed on this deployment." };
    }
  }
  // Browsers never attach credentials to a preflight, so forwarding one would let anyone wake a
  // billed container. Browser clients are out of scope here: refuse without granting CORS.
  if (req.method === "OPTIONS") return { forward: false, status: 204, message: "" };
  const unauthorized = { forward: false, status: 401, message: "opencodex API key required" } as const;
  const presented = presentedKeys(req).filter(key => key !== KEY_PROTOCOL_PREFIX);
  if (env.OCX_EDGE_KEY_CHECK?.trim() === "presence") return presented.length ? { forward: true } : unauthorized;
  const token = env.OPENCODEX_API_AUTH_TOKEN.trim();
  const accepted = [token, KEY_PROTOCOL_PREFIX + base64url(token)];
  // The management API takes the admin token, which the Worker does know.
  if (management && env.OPENCODEX_ADMIN_AUTH_TOKEN) accepted.push(env.OPENCODEX_ADMIN_AUTH_TOKEN.trim());
  for (const key of presented) {
    for (const expected of accepted) if (await secretEquals(key, expected)) return { forward: true };
  }
  return unauthorized;
}

/** The request as the container should see it: the client never chooses which container port it reaches. */
export function forwardableRequest(req: Request): Request {
  const forwarded = new Request(req);
  forwarded.headers.delete("cf-container-target-port");
  return forwarded;
}
