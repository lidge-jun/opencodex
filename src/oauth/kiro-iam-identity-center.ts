import type { OAuthCredentials } from "./types";

export interface KiroIamOptions { startUrl: string; region: string }
export interface KiroIamProfile { arn: string; name: string; region: string }
export type KiroIamReply = (url: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  Promise<{ status: number; data: Record<string, unknown>; errorType: string }>;
const REGION = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]?$/;
const CONTROL = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const PROFILE = /^arn:aws:codewhisperer:([a-z0-9-]+):\d{12}:profile\/[A-Za-z0-9-]+$/;
// The AWS CLI profile client enumerates these two service regions independently of SSO.
const PROFILE_REGIONS = ["us-east-1", "eu-central-1"] as const;
class KiroIamRequestError extends Error {
  constructor(readonly status: number) { super("Kiro IAM discovery failed"); }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Portal URLs are arguments to AWS OIDC, never destinations fetched by the hub. */
export function parseKiroIamOptions(value: unknown): KiroIamOptions | null {
  const { startUrl, region } = record(value);
  if (typeof startUrl !== "string" || startUrl.length > 2048 || CONTROL.test(startUrl)
    || typeof region !== "string" || !REGION.test(region)) return null;
  try {
    const url = new URL(startUrl);
    const authority = /^https:\/\/([^/?#]+)/.exec(startUrl)?.[1];
    if (!authority || authority.includes(":") || authority.includes("@") || url.protocol !== "https:"
      || !/^[a-z0-9][a-z0-9-]{0,62}\.awsapps\.com$/.test(url.hostname)
      || !/^\/start\/?$/.test(url.pathname) || url.search || (url.hash && url.hash !== "#/")) return null;
    return { startUrl: `https://${url.hostname}/start`, region };
  } catch { return null; }
}

function managementUrl(region: string): string {
  if (!REGION.test(region)) throw new Error("Invalid Kiro IAM region");
  if (!PROFILE_REGIONS.some(candidate => candidate === region)) throw new Error("Unsupported Kiro profile region");
  return `https://q.${region}.amazonaws.com/`;
}

async function call(reply: KiroIamReply, access: string, region: string, operation: string,
  body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(managementUrl(region));
  // GetUsageLimits models its arguments in both the query and JSON body (the CLI contract).
  if (operation === "GetUsageLimits") for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
  const result = await reply(url.href, body, {
    authorization: `Bearer ${access}`, "content-type": "application/x-amz-json-1.0",
    "x-amz-target": `AmazonCodeWhispererService.${operation}`, "x-amzn-codewhisperer-optout": "true",
  });
  if (result.status !== 200 || result.errorType || Object.hasOwn(result.data, "error")) throw new KiroIamRequestError(result.status);
  return result.data;
}

/** Bounded pagination; a partial or ambiguous profile list is never offered as complete. */
async function listProfilesInRegion(reply: KiroIamReply, access: string, region: string): Promise<KiroIamProfile[]> {
  const profiles = new Map<string, KiroIamProfile>();
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 8; page++) {
    const data = await call(reply, access, region, "ListAvailableProfiles", { maxResults: 50, ...(nextToken ? { nextToken } : {}) });
    if (!Array.isArray(data.profiles)) throw new Error("Kiro IAM profiles unavailable");
    for (const item of data.profiles) {
      const profile = record(item);
      const arn = typeof profile.arn === "string" ? profile.arn : "";
      const match = PROFILE.exec(arn);
      const name = typeof profile.profileName === "string" ? profile.profileName.trim() : "";
      if (!match || arn.length > 256 || !REGION.test(match[1]!) || !name || name.length > 256
        || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new Error("Invalid Kiro IAM profile");
      profiles.set(arn, { arn, name, region: match[1]! });
      if (profiles.size > 64) throw new Error("Too many Kiro IAM profiles");
    }
    if (data.nextToken === undefined || data.nextToken === null || data.nextToken === "") {
      return [...profiles.values()];
    }
    if (typeof data.nextToken !== "string" || data.nextToken.length > 4096 || tokens.has(data.nextToken)) break;
    nextToken = data.nextToken;
    tokens.add(nextToken);
  }
  throw new Error("Incomplete Kiro IAM profile list");
}

export async function listKiroIamProfiles(reply: KiroIamReply, access: string): Promise<KiroIamProfile[]> {
  const regional = await Promise.all(PROFILE_REGIONS.map(async region => {
    try { return await listProfilesInRegion(reply, access, region); }
    catch (error) {
      // Organizations may grant access in only one service region. Other failures must not
      // silently present a partial list as if discovery had completed.
      if (error instanceof KiroIamRequestError && (error.status === 401 || error.status === 403)) return [];
      throw error;
    }
  }));
  const profiles = new Map(regional.flat().map(profile => [profile.arn, profile]));
  if (!profiles.size || profiles.size > 64) throw new Error("Kiro IAM profiles unavailable");
  return [...profiles.values()];
}

/** Only AWS's response to this grant can name the user; a shared organization ARN cannot. */
export async function resolveKiroIamCredential(reply: KiroIamReply, credential: OAuthCredentials,
  profile: KiroIamProfile): Promise<OAuthCredentials> {
  const data = await call(reply, credential.access, profile.region, "GetUsageLimits", {
    origin: "CLI", isEmailRequired: true, profileArn: profile.arn,
  });
  const email = record(data.userInfo).email;
  if (typeof email !== "string" || !email.trim() || email.length > 320 || CONTROL.test(email.trim())) {
    throw new Error("Kiro IAM user identity unavailable");
  }
  return { ...credential, email: email.trim().toLowerCase(), accountId: profile.arn,
    kiro: { ...credential.kiro, profileArn: profile.arn, apiRegion: profile.region } };
}
