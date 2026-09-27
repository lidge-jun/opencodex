import type { TKey } from "./i18n/shared";

export type KiroDeviceMethod = "builder-id" | "google" | "github";
export type KiroDeviceState = "pending" | "done" | "failed" | "expired" | "cancelled";
export interface KiroDeviceView {
  flowId: string;
  method: KiroDeviceMethod;
  state: KiroDeviceState;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  warning?: "duplicate_profile_arn" | "manual_review_required";
}

const methods = new Set<KiroDeviceMethod>(["builder-id", "google", "github"]);
const states = new Set<KiroDeviceState>(["pending", "done", "failed", "expired", "cancelled"]);
/** Admit only the public device-view fields; an unexpected server field is never retained. */
export function parseKiroDeviceView(input: unknown): KiroDeviceView | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.flowId !== "string" || !value.flowId || !methods.has(value.method as KiroDeviceMethod)
    || !states.has(value.state as KiroDeviceState)) return null;
  return {
    flowId: value.flowId,
    method: value.method as KiroDeviceMethod,
    state: value.state as KiroDeviceState,
    ...(typeof value.userCode === "string" ? { userCode: value.userCode } : {}),
    ...(typeof value.verificationUri === "string" ? { verificationUri: value.verificationUri } : {}),
    ...(typeof value.verificationUriComplete === "string" ? { verificationUriComplete: value.verificationUriComplete } : {}),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    ...(value.warning === "duplicate_profile_arn" || value.warning === "manual_review_required" ? { warning: value.warning } : {}),
  };
}

/** URL parser normalization alone is insufficient: reject controls and explicit ports first. */
export function kiroVerificationLink(raw: string | undefined): string | null {
  if (!raw || [...raw].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const authority = /^https:\/\/([^/?#]+)/iu.exec(raw)?.[1];
  if (!authority || authority.includes("@") || authority.includes(":")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host !== "device.sso.us-east-1.amazonaws.com" && host !== "kiro.dev" && !host.endsWith(".kiro.dev")) return null;
    return url.href;
  } catch { return null; }
}

export function kiroSkipReasonKey(account: {
  autoSelectable?: boolean;
  skipReason?: string;
  needsReauth?: boolean;
  health?: { status: string };
}, provider: string): TKey | null {
  if (provider !== "kiro" || account.autoSelectable !== false) return null;
  if (account.skipReason === "needs_reauth") return null;
  if (account.skipReason === "cooldown" && account.health?.status === "cooldown") return null;
  if (account.skipReason === "suspended") return "kiroSelection.suspended";
  if (account.skipReason === "quota_exhausted") return "kiroSelection.quotaExhausted";
  if (account.skipReason === "cooldown") return "kiroSelection.cooldown";
  return "kiroSelection.generic";
}
