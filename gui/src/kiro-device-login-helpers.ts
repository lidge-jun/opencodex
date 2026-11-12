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
/** Commercial AWS regions, offered as suggestions. The field stays free text so a newer region still works. */
export const KIRO_IAM_REGIONS: readonly string[] = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "af-south-1", "ap-east-1", "ap-east-2",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5",
  "ap-southeast-6", "ap-southeast-7", "ca-central-1", "ca-west-1", "eu-central-1", "eu-central-2",
  "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3", "il-central-1",
  "me-central-1", "me-south-1", "mx-central-1", "sa-east-1",
];
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
export function kiroVerificationLink(raw: string | undefined, method?: KiroDeviceMethod): string | null {
  if (!raw || [...raw].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const authority = /^https:\/\/([^/?#]+)/iu.exec(raw)?.[1];
  if (!authority || authority.includes("@") || authority.includes(":")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const awsRegion = /^device\.sso\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host)?.[1];
    // Identity Center verifies on the organization's own access portal, the same host shape the login form accepts.
    const iamPortal = method === "iam-identity-center" && /^[a-z0-9][a-z0-9-]{0,62}\.awsapps\.com$/.test(host) && /^\/start\/?$/.test(url.pathname);
    if (!iamPortal && !(awsRegion && AWS_REGION.test(awsRegion)) && host !== "kiro.dev" && !host.endsWith(".kiro.dev")) return null;
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
