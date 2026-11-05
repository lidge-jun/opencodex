import type { CodeBuddyAiOAuthMetadata } from "../oauth/types";
import { createHash } from "node:crypto";

export const CODEBUDDY_AI_ORIGIN = "https://www.codebuddy.ai";
export const CODEBUDDY_AI_BASE_URL = `${CODEBUDDY_AI_ORIGIN}/v2`;
export const CODEBUDDY_AI_CONFIG_URL = `${CODEBUDDY_AI_ORIGIN}/v3/config`;
export const CODEBUDDY_AI_USER_AGENT = "CLI/2.180.0 CodeBuddy/2.180.0";

export function codeBuddyAiCatalogIdentity(access: string, metadata: CodeBuddyAiOAuthMetadata | undefined): string {
  return createHash("sha256").update(JSON.stringify([access, metadata])).digest("hex");
}

export function codeBuddyAiHeaderValue(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

export function normalizeCodeBuddyAiMetadata(value: unknown): CodeBuddyAiOAuthMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<CodeBuddyAiOAuthMetadata>;
  if (!codeBuddyAiHeaderValue(v.uid) || !codeBuddyAiHeaderValue(v.domain)) return undefined;
  if (v.enterpriseId !== undefined && !codeBuddyAiHeaderValue(v.enterpriseId)) return undefined;
  return {
    uid: v.uid, domain: v.domain,
    ...(v.enterpriseId ? { enterpriseId: v.enterpriseId } : {}),
    ...(typeof v.refreshExpiresAt === "number" && Number.isFinite(v.refreshExpiresAt) && v.refreshExpiresAt > 0
      ? { refreshExpiresAt: v.refreshExpiresAt } : {}),
  };
}

export function assertCodeBuddyAiDestination(baseUrl: string): void {
  const u = new URL(baseUrl);
  if (u.origin !== CODEBUDDY_AI_ORIGIN || u.username || u.password || u.search || u.hash
    || !["", "/v2", "/v2/chat/completions"].includes(u.pathname.replace(/\/+$/, ""))) {
    throw new Error("CodeBuddy AI credentials require https://www.codebuddy.ai/v2");
  }
}

export function codeBuddyAiHeaders(access: string | undefined, metadata?: CodeBuddyAiOAuthMetadata): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": CODEBUDDY_AI_USER_AGENT,
    "X-Product": "SaaS", "X-IDE-Type": "CLI", "X-IDE-Name": "CLI",
    "X-IDE-Version": "2.180.0", "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation", "X-Agent-Type": "main",
  };
  if (access) {
    if (!codeBuddyAiHeaderValue(access, 32768)) throw new Error("Invalid CodeBuddy AI access token");
    headers.Authorization = `Bearer ${access}`;
  }
  if (metadata) {
    const valid = normalizeCodeBuddyAiMetadata(metadata);
    if (!valid) throw new Error("CodeBuddy AI account identity unavailable; sign in again");
    headers["X-User-Id"] = valid.uid;
    headers["X-Domain"] = valid.domain;
    if (valid.enterpriseId) {
      headers["X-Enterprise-Id"] = valid.enterpriseId;
      headers["X-Tenant-Id"] = valid.enterpriseId;
    }
  }
  return headers;
}
