import type { WorkBuddyOAuthMetadata } from "../oauth/types";
import { createHash } from "node:crypto";

/**
 * One Tencent subscription wire, two region-isolated products. A token issued for one profile is
 * only ever sent to that profile's origin; nothing falls back across regions.
 */
export interface WorkBuddyProfile {
  id: "workbuddy-ai" | "codebuddy-cn-ai";
  label: string;
  /** Inference, catalog, refresh and billing origin. */
  origin: string;
  /** Browser-login origin; CodeBuddy CN signs in on its website, not its API host. */
  loginOrigin: string;
  loginPlatform: string;
  defaultDomain: string;
  identity: Readonly<Record<string, string>>;
  /** CodeBuddy CN CLI declares whether the account is enterprise-private. */
  privateDataHeader: boolean;
}

export const WORKBUDDY_PROFILE: WorkBuddyProfile = {
  id: "workbuddy-ai", label: "WorkBuddy AI",
  origin: "https://www.workbuddy.ai", loginOrigin: "https://www.workbuddy.ai",
  loginPlatform: "workbuddy-ai", defaultDomain: "www.workbuddy.ai",
  identity: { "User-Agent": "WorkBuddy/5.5.6", "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy", "X-IDE-Version": "5.5.6" },
  privateDataHeader: false,
};

export const CODEBUDDY_CN_AI_PROFILE: WorkBuddyProfile = {
  id: "codebuddy-cn-ai", label: "CodeBuddy CN",
  origin: "https://copilot.tencent.com", loginOrigin: "https://www.codebuddy.cn",
  loginPlatform: "workbuddy", defaultDomain: "www.codebuddy.cn",
  identity: { "User-Agent": "CLI/2.179.3 CodeBuddy/2.179.3", "X-IDE-Type": "CLI", "X-IDE-Name": "CLI", "X-IDE-Version": "2.179.3" },
  privateDataHeader: true,
};

export const WORKBUDDY_PROFILES: Readonly<Record<WorkBuddyProfile["id"], WorkBuddyProfile>> = {
  "workbuddy-ai": WORKBUDDY_PROFILE, "codebuddy-cn-ai": CODEBUDDY_CN_AI_PROFILE,
};

export function workBuddyProfile(name: unknown): WorkBuddyProfile | undefined {
  return typeof name === "string" && Object.hasOwn(WORKBUDDY_PROFILES, name)
    ? WORKBUDDY_PROFILES[name as WorkBuddyProfile["id"]] : undefined;
}

export const isWorkBuddyProvider = (name: unknown): boolean => workBuddyProfile(name) !== undefined;
export const workBuddyBaseUrl = (profile: WorkBuddyProfile): string => `${profile.origin}/v2`;
export const isWorkBuddyBaseUrl = (baseUrl: string): boolean =>
  Object.values(WORKBUDDY_PROFILES).some(profile => workBuddyBaseUrl(profile) === baseUrl);

export const WORKBUDDY_ORIGIN = WORKBUDDY_PROFILE.origin;
export const WORKBUDDY_BASE_URL = workBuddyBaseUrl(WORKBUDDY_PROFILE);
export const WORKBUDDY_CONFIG_URL = `${WORKBUDDY_ORIGIN}/v3/config`;
export const WORKBUDDY_USER_AGENT = WORKBUDDY_PROFILE.identity["User-Agent"];

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

export function assertWorkBuddyDestination(baseUrl: string, profile: WorkBuddyProfile = WORKBUDDY_PROFILE): void {
  const u = new URL(baseUrl);
  if (u.origin !== profile.origin || u.username || u.password || u.search || u.hash
    || !["", "/v2", "/v2/chat/completions"].includes(u.pathname.replace(/\/+$/, ""))) {
    throw new Error(`${profile.label} credentials require ${workBuddyBaseUrl(profile)}`);
  }
}

export function workBuddyHeaders(
  access: string | undefined, metadata?: WorkBuddyOAuthMetadata, profile: WorkBuddyProfile = WORKBUDDY_PROFILE,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...profile.identity,
    "X-Product": "SaaS", "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation", "X-Agent-Type": "main",
  };
  if (access) {
    if (!workBuddyHeaderValue(access, 32768)) throw new Error(`Invalid ${profile.label} access token`);
    headers.Authorization = `Bearer ${access}`;
  }
  if (metadata) {
    const valid = normalizeWorkBuddyMetadata(metadata);
    if (!valid) throw new Error(`${profile.label} account identity unavailable; sign in again`);
    headers["X-User-Id"] = valid.uid;
    headers["X-Domain"] = valid.domain;
    if (valid.enterpriseId) {
      headers["X-Enterprise-Id"] = valid.enterpriseId;
      headers["X-Tenant-Id"] = valid.enterpriseId;
    }
    if (profile.privateDataHeader) headers["X-Private-Data"] = valid.enterpriseId ? "true" : "false";
  }
  return headers;
}
