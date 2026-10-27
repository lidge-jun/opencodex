import type { WorkBuddyOAuthMetadata } from "../oauth/types";
import { createHash } from "node:crypto";

export const WORKBUDDY_ORIGIN = "https://www.workbuddy.ai";
export const WORKBUDDY_BASE_URL = `${WORKBUDDY_ORIGIN}/v2`;
export const WORKBUDDY_CONFIG_URL = `${WORKBUDDY_ORIGIN}/v3/config`;
export const WORKBUDDY_USER_AGENT = "WorkBuddy/5.5.6";

export function workBuddyCatalogIdentity(access: string, metadata: WorkBuddyOAuthMetadata | undefined): string {
  return createHash("sha256").update(JSON.stringify([access, metadata])).digest("hex");
}

export function workBuddyHeaderValue(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

export function normalizeWorkBuddyMetadata(value: unknown): WorkBuddyOAuthMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<WorkBuddyOAuthMetadata>;
  if (!workBuddyHeaderValue(v.uid) || !workBuddyHeaderValue(v.domain)) return undefined;
  if (v.enterpriseId !== undefined && !workBuddyHeaderValue(v.enterpriseId)) return undefined;
  return {
    uid: v.uid, domain: v.domain,
    ...(v.enterpriseId ? { enterpriseId: v.enterpriseId } : {}),
    ...(typeof v.refreshExpiresAt === "number" && Number.isFinite(v.refreshExpiresAt) && v.refreshExpiresAt > 0
      ? { refreshExpiresAt: v.refreshExpiresAt } : {}),
  };
}

export function assertWorkBuddyDestination(baseUrl: string): void {
  const u = new URL(baseUrl);
  if (u.origin !== WORKBUDDY_ORIGIN || u.username || u.password || u.search || u.hash
    || !["", "/v2", "/v2/chat/completions"].includes(u.pathname.replace(/\/+$/, ""))) {
    throw new Error("WorkBuddy AI credentials require https://www.workbuddy.ai/v2");
  }
}

export function workBuddyHeaders(access: string | undefined, metadata?: WorkBuddyOAuthMetadata): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": WORKBUDDY_USER_AGENT,
    "X-Product": "SaaS", "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": "5.5.6", "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation", "X-Agent-Type": "main",
  };
  if (access) {
    if (!workBuddyHeaderValue(access, 32768)) throw new Error("Invalid WorkBuddy AI access token");
    headers.Authorization = `Bearer ${access}`;
  }
  if (metadata) {
    const valid = normalizeWorkBuddyMetadata(metadata);
    if (!valid) throw new Error("WorkBuddy AI account identity unavailable; sign in again");
    headers["X-User-Id"] = valid.uid;
    headers["X-Domain"] = valid.domain;
    if (valid.enterpriseId) {
      headers["X-Enterprise-Id"] = valid.enterpriseId;
      headers["X-Tenant-Id"] = valid.enterpriseId;
    }
  }
  return headers;
}
