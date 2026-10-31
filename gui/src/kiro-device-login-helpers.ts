import type { TKey } from "./i18n/shared";

export type KiroDeviceMethod = "builder-id" | "google" | "github" | "iam-identity-center";
export type KiroDeviceState = "pending" | "select-profile" | "done" | "failed" | "expired" | "cancelled";
export interface KiroIamOptions { startUrl: string; region: string }
export interface KiroIamProfile { arn: string; name: string; region: string }
export interface KiroDeviceView {
  flowId: string;
  method: KiroDeviceMethod;
  state: KiroDeviceState;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  warning?: "duplicate_profile_arn" | "manual_review_required";
  profiles?: KiroIamProfile[];
}

const methods = new Set<KiroDeviceMethod>(["builder-id", "google", "github", "iam-identity-center"]);
const states = new Set<KiroDeviceState>(["pending", "select-profile", "done", "failed", "expired", "cancelled"]);
const AWS_REGION = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]?$/;

export function validKiroIamOptions({ startUrl, region }: KiroIamOptions): boolean {
  return /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.awsapps\.com\/start\/?(?:#\/)?$/.test(startUrl) && AWS_REGION.test(region);
}
/** Admit only the public device-view fields; an unexpected server field is never retained. */
export function parseKiroDeviceView(input: unknown): KiroDeviceView | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.flowId !== "string" || !value.flowId || !methods.has(value.method as KiroDeviceMethod)
    || !states.has(value.state as KiroDeviceState)) return null;
  let profiles: KiroIamProfile[] | undefined;
  if (value.state === "select-profile") {
    if (value.method !== "iam-identity-center" || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 64) return null;
    profiles = [];
    for (const item of value.profiles) {
      if (!item || typeof item !== "object") return null;
      const profile = item as Record<string, unknown>;
      if (typeof profile.arn !== "string" || profile.arn.length > 256
        || !/^arn:aws:codewhisperer:[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9-]+$/.test(profile.arn)
        || typeof profile.name !== "string" || !profile.name || profile.name.length > 256
        || typeof profile.region !== "string" || !AWS_REGION.test(profile.region)) return null;
      profiles.push({ arn: profile.arn, name: profile.name, region: profile.region });
    }
  }
  return {
    flowId: value.flowId,
    method: value.method as KiroDeviceMethod,
    state: value.state as KiroDeviceState,
    ...(typeof value.userCode === "string" ? { userCode: value.userCode } : {}),
    ...(typeof value.verificationUri === "string" ? { verificationUri: value.verificationUri } : {}),
    ...(typeof value.verificationUriComplete === "string" ? { verificationUriComplete: value.verificationUriComplete } : {}),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    ...(value.warning === "duplicate_profile_arn" || value.warning === "manual_review_required" ? { warning: value.warning } : {}),
    ...(profiles ? { profiles } : {}),
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
    const awsRegion = /^device\.sso\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host)?.[1];
    if (!(awsRegion && AWS_REGION.test(awsRegion)) && host !== "kiro.dev" && !host.endsWith(".kiro.dev")) return null;
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
  if (account.skipReason === "paused") return null;
  if (account.skipReason === "cooldown" && account.health?.status === "cooldown") return null;
  if (account.skipReason === "suspended") return "kiroSelection.suspended";
  if (account.skipReason === "quota_exhausted") return "kiroSelection.quotaExhausted";
  if (account.skipReason === "cooldown") return "kiroSelection.cooldown";
  return "kiroSelection.generic";
}
