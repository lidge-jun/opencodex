/** Native Kiro device grants. All upstream bodies and credentials stay inside this module. */
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig } from "../config";
import { providerOutboundPost } from "../lib/provider-outbound";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBytes } from "../lib/bounded-body";
import { upsertOAuthProvider } from "./index";
import { appendKiroAccountFromDeviceLogin, isStorableKiroClientPart, rollbackCredentialWriteIfMatch } from "./store";
import type { OAuthCredentials } from "./types";
import type { ManagementPrincipal } from "../server/management-auth";
import type { OcxConfig } from "../types";

export type KiroDeviceMethod = "builder-id" | "google" | "github";
export type KiroDevicePrincipal = ManagementPrincipal;
type State = "pending" | "done" | "failed" | "expired" | "cancelled";
export interface KiroDeviceView {
  flowId: string;
  method: KiroDeviceMethod;
  state: State;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  warning?: "duplicate_profile_arn" | "manual_review_required";
}
interface Flow {
  view: KiroDeviceView;
  ownerPrincipal: KiroDevicePrincipal;
  deviceCode?: string;
  clientId?: string;
  clientSecret?: string;
  nextPollAt: number;
  intervalMs: number;
  deadline: number;
  polling?: Promise<KiroDeviceView>;
  configBaseline?: OcxConfig;
  commitAccepted?: boolean;
}
export type KiroDevicePost = (url: string, body: Record<string, unknown>) => Promise<Response>;
const SOCIAL = "https://prod.us-east-1.auth.desktop.kiro.dev";
const OIDC = "https://oidc.us-east-1.amazonaws.com";
const MAX_KIRO_DEVICE_FLOWS = 4;
const MAX_LIFETIME_MS = 15 * 60_000;
const PROFILE_ARN = /^arn:[a-z0-9-]+:codewhisperer:[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9-]+$/;
const flows = new Map<string, Flow>();

async function defaultPost(url: string, body: Record<string, unknown>): Promise<Response> {
  const configured = loadConfig().providers.kiro;
  return providerOutboundPost("kiro", {
    baseUrl: new URL(url).origin,
    ...(configured?.proxy ? { proxy: configured.proxy } : {}),
    ...(configured?.noProxy ? { noProxy: configured.noProxy } : {}),
    ...(configured?.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  }, url, {
    headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
}

let transport: KiroDevicePost = defaultPost;
let clock = () => Date.now();
function defaultPublishConfig(): void {
  const config = loadConfig();
  upsertOAuthProvider(config, "kiro");
  saveConfig(config);
}
let publishConfig: () => void | Promise<void> = defaultPublishConfig;
/** Tests replace the transport; production always uses the guarded outbound path. */
export function setKiroDevicePostForTests(post?: KiroDevicePost): void { transport = post ?? defaultPost; }
export function setKiroDeviceClockForTests(now?: () => number): void { clock = now ?? (() => Date.now()); }
export function setKiroDevicePublishForTests(publish?: () => void | Promise<void>): void {
  publishConfig = publish ?? defaultPublishConfig;
}
export function clearKiroDeviceFlowsForTests(): void { flows.clear(); transport = defaultPost; setKiroDeviceClockForTests(); setKiroDevicePublishForTests(); }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function reply(url: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown>; errorType: string }> {
  const response = await transport(url, body);
  // Unknown upstream bodies are bounded and never echoed into a response or error.
  const { bytes, oversized } = await readBoundedResponseBytes(response, {
    maxBytes: BOUNDED_BODY_MAX_BYTES, signal: AbortSignal.timeout(20_000),
  });
  if (oversized) throw new Error("Kiro device reply too large");
  let parsed: unknown = {};
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { /* malformed reply fails closed */ }
  const data = object(parsed);
  return { status: response.status, data, errorType: response.headers.get("x-amzn-errortype")?.split(":")[0] ?? "" };
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function publicView(flow: Flow): KiroDeviceView { return { ...flow.view }; }
function terminal(flow: Flow, state: State, warning?: KiroDeviceView["warning"]): KiroDeviceView {
  flow.view.state = state;
  if (warning) flow.view.warning = warning;
  delete flow.deviceCode;
  delete flow.clientId;
  delete flow.clientSecret;
  return publicView(flow);
}
function owned(flowId: string, principal: KiroDevicePrincipal): Flow | undefined {
  const flow = flows.get(flowId);
  if (!flow || flow.ownerPrincipal !== principal) return undefined;
  if (clock() >= flow.deadline) {
    terminal(flow, "expired");
    flows.delete(flowId);
    return undefined;
  }
  return flow;
}
function code(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function viewFromAuthorization(flow: Flow, data: Record<string, unknown>, scale: number): void {
  if (!code(data.deviceCode) || !code(data.userCode) || !code(data.verificationUri)) throw new Error("Kiro device authorization failed");
  const now = clock();
  const lifetime = positive(data.expiresInMilliseconds) && scale === 1 ? data.expiresInMilliseconds
    : positive(data.expiresIn) && scale === 1000 ? data.expiresIn * 1000 : scale === 1 ? 300_000 : 600_000;
  const interval = positive(data.intervalInMilliseconds) && scale === 1 ? data.intervalInMilliseconds
    : positive(data.interval) && scale === 1000 ? data.interval * 1000 : 5_000;
  flow.deviceCode = data.deviceCode;
  flow.deadline = Math.min(flow.deadline, now + lifetime);
  flow.intervalMs = Math.max(1000, interval);
  flow.nextPollAt = now + flow.intervalMs;
  flow.view = {
    flowId: flow.view.flowId, method: flow.view.method, state: "pending", userCode: data.userCode,
    verificationUri: data.verificationUri,
    ...(code(data.verificationUriComplete) ? { verificationUriComplete: data.verificationUriComplete } : {}),
    expiresAt: flow.deadline,
  };
}

export async function startKiroDeviceLogin(method: KiroDeviceMethod, principal: KiroDevicePrincipal, configBaseline?: OcxConfig): Promise<KiroDeviceView> {
  // Reserve before the first await, so concurrent starts cannot evade the cap.
  for (const [id, flow] of flows) if (clock() >= flow.deadline) { terminal(flow, "expired"); flows.delete(id); }
  if ([...flows.values()].filter(flow => flow.view.state === "pending").length >= MAX_KIRO_DEVICE_FLOWS) {
    throw new Error("Too many Kiro device logins in progress");
  }
  const flowId = randomBytes(32).toString("base64url");
  const flow: Flow = {
    view: { flowId, method, state: "pending" }, ownerPrincipal: principal,
    nextPollAt: 0, intervalMs: 5_000, deadline: clock() + MAX_LIFETIME_MS,
    ...(configBaseline ? { configBaseline: structuredClone(configBaseline) } : {}),
  };
  flows.set(flowId, flow);
  let started = false;
  try {
    if (method === "builder-id") {
      const registration = await reply(`${OIDC}/client/register`, {
        clientName: "kiro-cli", clientType: "public",
        scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"],
      });
      if (registration.status < 200 || registration.status >= 300 || !isStorableKiroClientPart(registration.data.clientId)
        || !isStorableKiroClientPart(registration.data.clientSecret)) throw new Error("Kiro registration failed");
      flow.clientId = registration.data.clientId;
      flow.clientSecret = registration.data.clientSecret;
      const authorization = await reply(`${OIDC}/device_authorization`, {
        clientId: flow.clientId, clientSecret: flow.clientSecret, startUrl: "https://view.awsapps.com/start",
      });
      if (authorization.status < 200 || authorization.status >= 300) throw new Error("Kiro device authorization failed");
      viewFromAuthorization(flow, authorization.data, 1000);
    } else {
      const authorization = await reply(`${SOCIAL}/oauth/device/authorization`, {
        clientId: "kiro-cli", loginProvider: method === "google" ? "Google" : "Github",
      });
      if (authorization.status < 200 || authorization.status >= 300) throw new Error("Kiro device authorization failed");
      viewFromAuthorization(flow, authorization.data, 1);
    }
    started = true;
    return publicView(flow);
  } catch {
    throw new Error("Kiro device login could not start");
  } finally {
    if (!started) { terminal(flow, "failed"); flows.delete(flowId); }
  }
}

export function kiroDeviceConfigBaseline(flowId: string, principal: KiroDevicePrincipal): OcxConfig | undefined {
  return owned(flowId, principal)?.configBaseline;
}

async function poll(flow: Flow, principal: KiroDevicePrincipal): Promise<KiroDeviceView> {
  const now = clock();
  flow.nextPollAt = now + flow.intervalMs;
  try {
    const builder = flow.view.method === "builder-id";
    const result = builder
      ? await reply(`${OIDC}/token`, {
        clientId: flow.clientId, clientSecret: flow.clientSecret, deviceCode: flow.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      })
      : await reply(`${SOCIAL}/oauth/device/poll`, { clientId: "kiro-cli", deviceCode: flow.deviceCode });
    if (!owned(flow.view.flowId, principal) || flow.view.state !== "pending") return publicView(flow);
    const data = result.data;
    const error = typeof data.error === "string" ? data.error : result.errorType;
    if (builder && result.status === 400) {
      if (error === "authorization_pending" || error === "AuthorizationPendingException") return publicView(flow);
      if (error === "slow_down" || error === "SlowDownException") {
        flow.intervalMs += 5_000;
        flow.nextPollAt = clock() + flow.intervalMs;
        return publicView(flow);
      }
      if (error === "expired_token" || error === "ExpiredTokenException") return terminal(flow, "expired");
    }
    if (!builder && result.status === 200) {
      if (data.status === "authorization_pending") return publicView(flow);
      if (data.status === "expired_token" || data.status === "expired") return terminal(flow, "expired");
    }
    if (result.status !== 200 || error || (builder && (data.status !== undefined || !positive(data.expiresIn) || !isStorableKiroClientPart(flow.clientId)
      || !isStorableKiroClientPart(flow.clientSecret)))
      || (!builder && (data.status !== undefined && data.status !== "approved"))) return terminal(flow, "failed");
    if (!code(data.accessToken) || !code(data.refreshToken)
      || (!builder && (typeof data.profileArn !== "string" || !PROFILE_ARN.test(data.profileArn)))) return terminal(flow, "failed");
    const credential: OAuthCredentials = {
      access: data.accessToken, refresh: data.refreshToken,
      expires: clock() + (positive(data.expiresIn) ? data.expiresIn * 1000 : 3600_000),
      source: "oauth",
      kiro: builder
        ? { clientId: flow.clientId, clientSecret: flow.clientSecret, ssoRegion: "us-east-1", apiRegion: "us-east-1" }
        : { profileArn: data.profileArn as string, ssoRegion: "us-east-1", apiRegion: "us-east-1" },
    };
    const assertBeforePersist = () => {
      if (flows.get(flow.view.flowId) !== flow || flow.ownerPrincipal !== principal
        || flow.view.state !== "pending" || clock() >= flow.deadline) throw new Error("Kiro device flow cancelled");
      flow.commitAccepted = true;
    };
    const added = await appendKiroAccountFromDeviceLogin(credential, { assertBeforePersist });
    try {
      await publishConfig();
    } catch {
      try {
        if (await rollbackCredentialWriteIfMatch(added.receipt) === "stale") flow.view.warning = "manual_review_required";
      } catch {
        flow.view.warning = "manual_review_required";
      }
      throw new Error("Kiro account configuration failed");
    }
    return terminal(flow, "done", added.warning);
  } catch {
    return flow.view.state === "cancelled" ? publicView(flow) : terminal(flow, "failed");
  }
}

export async function statusKiroDeviceLogin(flowId: string, principal: KiroDevicePrincipal): Promise<KiroDeviceView | null> {
  const flow = owned(flowId, principal);
  if (!flow) return null;
  if (flow.view.state !== "pending" || clock() < flow.nextPollAt) return publicView(flow);
  if (!flow.polling) flow.polling = poll(flow, principal).finally(() => { flow.polling = undefined; });
  return await flow.polling;
}

export function cancelKiroDeviceLogin(flowId: string, principal: KiroDevicePrincipal): KiroDeviceView | null {
  const flow = owned(flowId, principal);
  if (!flow) return null;
  if (flow.commitAccepted && flow.view.state === "pending") return { ...flow.view, state: "done" };
  if (flow.view.state === "pending") {
    terminal(flow, "cancelled");
    flows.delete(flowId);
  }
  return publicView(flow);
}
