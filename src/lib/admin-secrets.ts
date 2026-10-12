import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

export const ADMIN_TOKEN_FILE = "admin-api-token";

export function adminApiTokenFilePath(configDir = getConfigDir()): string {
  return join(configDir, ADMIN_TOKEN_FILE);
}

export function loadAdminTokenFromFile(configDir = getConfigDir()): string | null {
  const path = adminApiTokenFilePath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return null;
    const token = readFileSync(path, "utf8").trim();
    return /^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function configuredAdminToken(configDir = getConfigDir(), env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim() || loadAdminTokenFromFile(configDir);
}

export const ADMIN_TOKEN_PREFIX = "ocx_admin_";

/**
 * Derive the bearer used by the OpenCode launcher for its one management read.
 * A listener that captures this value cannot recover or replay the administrator token.
 */
export function opencodeCatalogToken(adminToken: string): string {
  return `ocx_catalog_${createHmac("sha256", adminToken).update("opencode:/api/models:v1").digest("base64url")}`;
}

function secretTextEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when `token` is a management credential: minted `ocx_admin_…` shape, or
 * byte-equal to the configured admin token (env or admin-api-token file).
 * Used by the service write/start chokepoint and by doctor so the two cannot drift.
 */
export function tokenCollidesWithAdmin(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  configDir = getConfigDir(),
): boolean {
  if (token.startsWith(ADMIN_TOKEN_PREFIX)) return true;
  const admin = configuredAdminToken(configDir, env);
  return admin !== null && secretTextEquals(token, admin);
}
