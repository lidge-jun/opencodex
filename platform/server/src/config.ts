import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PLATFORM_DATABASE_URL: z.string().min(1).optional(),
  PLATFORM_BASE_URL: z.string().url(),
  PLATFORM_INSTANCE_DOMAIN: z.string().min(3),
  PLATFORM_PRIVATE_HOSTNAME_DOMAIN: z.string().min(3).default("private.remote.opencodexpages.me"),
  PLATFORM_BOOTSTRAP_GITHUB_ID: z.string().regex(/^\d+$/),
  PLATFORM_SIGNUP_MODE: z.enum(["private", "open"]).default("private"),
  PLATFORM_GATEWAY_ISSUER: z.string().default("opencodex-remote"),
  PLATFORM_GATEWAY_KID: z.string().default("gateway-1"),
  PLATFORM_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(10200),
  PLATFORM_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(10201),
  PLATFORM_GATEWAY_HOST: z.string().default("127.0.0.1"),
  PLATFORM_RELAY_URL: z.string().url().optional(),
  PLATFORM_DEV_AUTH_GITHUB_ID: z.string().regex(/^\d+$/).optional(),
  PLATFORM_DEV_AUTO_APPROVE_DEVICE_LINKS: z.enum(["true", "false"]).default("false"),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_AUTH_EMAIL: z.string().email().optional(),
  CLOUDFLARE_API_BASE_URL: z.string().url().default("https://api.cloudflare.com/client/v4"),
  CLOUDFLARE_MESH_ENABLED: z.enum(["true", "false"]).default("false"),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});

function credential(name: string, envValue?: string): string | undefined {
  if (envValue) return envValue;
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) return undefined;
  try {
    return readFileSync(join(directory, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

export interface PlatformConfig extends z.infer<typeof envSchema> {
  PLATFORM_DATABASE_URL: string;
  PLATFORM_RELAY_URL: string;
  cloudflareApiToken?: string;
  cloudflareAuthEmail?: string;
  gatewayPrivateKeyPem: string;
  encryptionKey: Buffer;
  auditHmacKey: Buffer;
  syntheticHealthToken: string;
}

export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const parsed = envSchema.parse({
    ...env,
    BETTER_AUTH_SECRET: credential("better-auth-secret", env.BETTER_AUTH_SECRET),
    GITHUB_CLIENT_SECRET: credential("github-client-secret", env.GITHUB_CLIENT_SECRET),
  });
  const gatewayPrivateKeyPem = credential("gateway-ed25519-private-key", env.PLATFORM_GATEWAY_PRIVATE_KEY);
  const databaseUrl = credential("database-url", env.PLATFORM_DATABASE_URL);
  const encryptionKeyValue = credential("platform-encryption-key", env.PLATFORM_ENCRYPTION_KEY);
  const auditHmacValue = credential("audit-hmac-key", env.PLATFORM_AUDIT_HMAC_KEY);
  const syntheticHealthToken = credential("synthetic-health-token", env.PLATFORM_SYNTHETIC_HEALTH_TOKEN);
  if (!gatewayPrivateKeyPem) throw new Error("gateway Ed25519 private key credential is required");
  if (!databaseUrl) throw new Error("platform database URL credential is required");
  if (!encryptionKeyValue || Buffer.from(encryptionKeyValue, "base64url").length !== 32) {
    throw new Error("platform encryption key must be 32 base64url-encoded bytes");
  }
  if (!auditHmacValue || Buffer.from(auditHmacValue, "base64url").length < 32) {
    throw new Error("audit HMAC key must be at least 32 base64url-encoded bytes");
  }
  if (!syntheticHealthToken || syntheticHealthToken.length < 32) throw new Error("synthetic health token is required");
  return {
    ...parsed,
    PLATFORM_DATABASE_URL: databaseUrl,
    PLATFORM_RELAY_URL: parsed.PLATFORM_RELAY_URL
      ?? `wss://relay.${parsed.PLATFORM_INSTANCE_DOMAIN}/_ocxr/agent`,
    cloudflareApiToken: credential("cloudflare-api-token", env.CLOUDFLARE_API_TOKEN),
    cloudflareAuthEmail: credential("cloudflare-auth-email", env.CLOUDFLARE_AUTH_EMAIL),
    gatewayPrivateKeyPem,
    encryptionKey: Buffer.from(encryptionKeyValue, "base64url"),
    auditHmacKey: Buffer.from(auditHmacValue, "base64url"),
    syntheticHealthToken,
  };
}
