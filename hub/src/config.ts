import { isIP } from "node:net";

export interface HubConfig {
  databasePath: string;
  digestSecret: string;
  publicOrigin: string;
  hostname: string;
  port: number;
  allowRegistration: boolean;
  sessionTtlSeconds: number;
  development: boolean;
  trustLoopbackProxy: boolean;
  opencodexOrigin: string;
  internalAdmissionToken: string;
  requestCostUnits: number;
  pricingVersion: string;
  upstreamTimeoutMs: number;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function looksLikePlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["changeme", "replaceme", "defaultsecret", "password", "example"].some(marker => normalized.includes(marker));
}

export function validateHubConfig(config: HubConfig): HubConfig {
  if (Buffer.byteLength(config.digestSecret) < 32) throw new Error("HUB_DIGEST_SECRET must contain at least 32 bytes");
  if (looksLikePlaceholderSecret(config.digestSecret)) throw new Error("HUB_DIGEST_SECRET must not be a placeholder");
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("invalid hub port");
  if (!config.databasePath.trim() || config.databasePath.includes("\0")) throw new Error("hub database path is required");
  if (!config.development && config.databasePath === ":memory:") throw new Error("production hub requires a durable database path");
  if (typeof config.allowRegistration !== "boolean") throw new Error("invalid registration policy");
  if (!Number.isSafeInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 300 || config.sessionTtlSeconds > 2_592_000) {
    throw new Error("HUB_SESSION_TTL_SECONDS must be between 300 and 2592000");
  }
  const origin = new URL(config.publicOrigin);
  if (!origin.hostname || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("HUB_PUBLIC_ORIGIN must be an origin without credentials, path, query, or hash");
  if (origin.protocol !== "https:" && !(config.development && origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw new Error("hosted mode requires an https public origin; http is allowed only for explicit loopback development");
  }
  if (!config.development && isLoopback(origin.hostname)) throw new Error("production HUB_PUBLIC_ORIGIN must not be loopback");
  if (config.trustLoopbackProxy && config.development) throw new Error("loopback proxy trust is a production-only mode");
  if (config.trustLoopbackProxy && !isLoopback(config.hostname)) throw new Error("trusted proxy mode requires a loopback hub bind");
  if (!config.development && !config.trustLoopbackProxy && isLoopback(config.hostname)) throw new Error("production hub hostname must be an explicit public bind");
  if (config.development && !isLoopback(config.hostname)) throw new Error("development hub may bind only to loopback");
  if (!config.development && !config.trustLoopbackProxy && isIP(config.hostname) === 0 && config.hostname !== "0.0.0.0" && config.hostname !== "::") {
    throw new Error("hub hostname must be an IP bind address");
  }
  const target = new URL(config.opencodexOrigin);
  if (target.protocol !== "http:" || !isLoopback(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("HUB_OPENCODEX_ORIGIN must be a loopback http origin without credentials, path, query, or hash");
  }
  if (target.origin === origin.origin) throw new Error("public hub and private OpenCodex origins must be different");
  if (Buffer.byteLength(config.internalAdmissionToken) < 32) throw new Error("HUB_INTERNAL_ADMISSION_TOKEN must contain at least 32 bytes");
  if (looksLikePlaceholderSecret(config.internalAdmissionToken)) throw new Error("HUB_INTERNAL_ADMISSION_TOKEN must not be a placeholder");
  if (config.internalAdmissionToken === config.digestSecret) throw new Error("hub digest and internal admission secrets must be different");
  if (!Number.isSafeInteger(config.requestCostUnits) || config.requestCostUnits < 1) throw new Error("HUB_REQUEST_COST_UNITS must be a positive safe integer");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.pricingVersion)) throw new Error("invalid HUB_PRICING_VERSION");
  if (!Number.isSafeInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs < 1_000 || config.upstreamTimeoutMs > 600_000) {
    throw new Error("HUB_UPSTREAM_TIMEOUT_MS must be between 1000 and 600000");
  }
  return { ...config, publicOrigin: origin.origin, opencodexOrigin: target.origin };
}

export function loadHubConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const development = env.HUB_DEVELOPMENT === "1";
  return validateHubConfig({
    databasePath: env.HUB_DATABASE_PATH?.trim() ?? "",
    digestSecret: env.HUB_DIGEST_SECRET ?? "",
    publicOrigin: env.HUB_PUBLIC_ORIGIN?.trim() ?? "",
    hostname: env.HUB_HOSTNAME?.trim() || (development ? "127.0.0.1" : ""),
    port: Number(env.HUB_PORT ?? "10400"),
    allowRegistration: env.HUB_ALLOW_REGISTRATION === "1",
    sessionTtlSeconds: Number(env.HUB_SESSION_TTL_SECONDS ?? String(60 * 60 * 24 * 7)),
    development,
    trustLoopbackProxy: env.HUB_TRUST_LOOPBACK_PROXY === "1",
    opencodexOrigin: env.HUB_OPENCODEX_ORIGIN?.trim() ?? "",
    internalAdmissionToken: env.HUB_INTERNAL_ADMISSION_TOKEN ?? "",
    requestCostUnits: Number(env.HUB_REQUEST_COST_UNITS ?? ""),
    pricingVersion: env.HUB_PRICING_VERSION?.trim() ?? "",
    upstreamTimeoutMs: Number(env.HUB_UPSTREAM_TIMEOUT_MS ?? "120000"),
  });
}
