import { randomUUID } from "node:crypto";
import { loginChatGPTNativeDevice, type NativeDeviceLogin } from "../oauth/chatgpt-device";
import type { OAuthController } from "../oauth/types";
import {
  beginNativeMainReauth,
  MainAuthJsonChangedDuringRefreshError,
  NativeMainReauthIdentityMismatchError,
  NativeMainReauthUnavailableError,
  type NativeMainReauthTokens,
} from "./main-account";

/**
 * Process-owned native-main device reauth flow (#3898).
 *
 * Exactly one active flow per process, started from the management API or the
 * CLI. The human-facing DTO carries only flowId, status, the verification
 * URL and the device code: tokens, emails, and raw account ids never leave
 * the device/grant layer, and the opaque device_auth_id never leaves
 * chatgpt-device.ts at all. The grant runs on this flow's own
 * AbortController — deliberately NOT through startLoginFlow("chatgpt"),
 * which would overwrite the pool scratch slot and collide with pool logins.
 */

export type MainDeviceReauthStatus =
  | { flowId: string; status: "pending"; verificationUrl: string; deviceCode: string }
  | { flowId: string; status: "committing" }
  | { flowId: string; status: "succeeded"; credentialUpdated: true }
  | { flowId: string; status: "cancelled" }
  | {
      flowId: string;
      status: "failed";
      credentialUpdated?: true;
      code:
        | "identity_mismatch"
        | "credential_changed"
        | "native_main_unavailable"
        | "device_authorization_failed"
        | "publication_failed"
        | "reconciliation_failed";
    };

export class MainDeviceReauthFlowBusyError extends Error {
  readonly code = "flow_in_progress";
  constructor() {
    super("A native main device reauth is already in progress");
    this.name = "MainDeviceReauthFlowBusyError";
  }
}

interface ActiveFlow {
  flowId: string;
  controller: AbortController;
  status: MainDeviceReauthStatus;
  /** Set once auth.json has been replaced; cancellation can no longer win. */
  published: boolean;
  /** Snapshot-holding commit prepared at start; closure-private identity. */
  prepared?: { commit: (tokens: NativeMainReauthTokens) => Promise<{ chatgptAccountId: string }> };
}

/** Bounded terminal retention so status/cancel stay answerable after completion. */
const TERMINAL_RETENTION_MS = 300_000;

let activeFlow: ActiveFlow | null = null;
const terminalFlows = new Map<string, { status: MainDeviceReauthStatus; expiresAt: number }>();

export interface MainDeviceReauthDeps {
  login?: (ctrl: OAuthController) => Promise<NativeDeviceLogin>;
  beginCommit?: () => { commit: (tokens: NativeMainReauthTokens) => Promise<{ chatgptAccountId: string }> };
  flowId?: () => string;
  now?: () => number;
}

function isTerminal(status: MainDeviceReauthStatus): boolean {
  return status.status === "succeeded" || status.status === "cancelled" || status.status === "failed";
}

function sweepTerminal(now: number): void {
  for (const [flowId, row] of terminalFlows) {
    if (row.expiresAt <= now) terminalFlows.delete(flowId);
  }
}

function finish(flow: ActiveFlow, status: MainDeviceReauthStatus, now: number): void {
  // Publication beats a racing cancellation: once auth.json was replaced the
  // honest terminal is succeeded, never cancelled (080). Every other terminal
  // is first-write-wins so a superseded or cancelled completion cannot
  // publish a later result.
  if (isTerminal(flow.status)) {
    if (!(flow.published && status.status === "succeeded")) return;
  }
  if (status.status === "succeeded") flow.published = true;
  flow.status = status;
  terminalFlows.set(flow.flowId, { status, expiresAt: now + TERMINAL_RETENTION_MS });
}

function mapFailure(flowId: string, error: unknown): MainDeviceReauthStatus {
  if (error instanceof NativeMainReauthIdentityMismatchError) {
    return { flowId, status: "failed", code: "identity_mismatch" };
  }
  if (error instanceof MainAuthJsonChangedDuringRefreshError) {
    return { flowId, status: "failed", code: "credential_changed" };
  }
  if (error instanceof NativeMainReauthUnavailableError) {
    return { flowId, status: "failed", code: "native_main_unavailable" };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "NATIVE_MAIN_CLAIM_UNAVAILABLE" || code === "NATIVE_MAIN_OWNER_UNAVAILABLE") {
    return { flowId, status: "failed", code: "native_main_unavailable" };
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return { flowId, status: "failed", code: "device_authorization_failed" };
  }
  if (error instanceof Error && /device authorization/.test(error.message)) {
    return { flowId, status: "failed", code: "device_authorization_failed" };
  }
  return { flowId, status: "failed", code: "publication_failed" };
}

/**
 * Start the one active flow. Returns the pending status; the URL/code arrive
 * with the usercode response and are visible through the status endpoint.
 */
export function startMainDeviceReauth(deps: MainDeviceReauthDeps = {}): MainDeviceReauthStatus {
  const now = (deps.now ?? Date.now)();
  sweepTerminal(now);
  if (activeFlow && !isTerminal(activeFlow.status)) throw new MainDeviceReauthFlowBusyError();
  const flowId = (deps.flowId ?? randomUUID)();
  const flow: ActiveFlow = {
    flowId,
    controller: new AbortController(),
    status: { flowId, status: "pending", verificationUrl: "", deviceCode: "" },
    published: false,
  };
  // Claim the singleflight slot BEFORE preparing: two overlapping starts must
  // not both snapshot and then have one throw flow_in_progress after the
  // other already began polling.
  activeFlow = flow;
  try {
    // Prepare NOW: the existing credential snapshot is captured at start (080),
    // so a hub with no reauthenticatable main credential fails fast with
    // native_main_unavailable instead of after the human completes the page.
    flow.prepared = (deps.beginCommit ?? beginNativeMainReauth)();
  } catch (error) {
    activeFlow = null;
    throw error;
  }
  const login = deps.login ?? loginChatGPTNativeDevice;
  const clock = deps.now ?? Date.now;
  void (async () => {
    try {
      const grant = await login({
        signal: flow.controller.signal,
        onAuth: info => {
          // A superseded or cancelled flow may not publish its URL/code.
          if (activeFlow !== flow || isTerminal(flow.status)) return;
          flow.status = {
            flowId,
            status: "pending",
            verificationUrl: info.url,
            deviceCode: info.deviceCode ?? "",
          };
        },
      });
      if (flow.controller.signal.aborted) return;
      if (!isTerminal(flow.status)) flow.status = { flowId, status: "committing" };
      // Recheck immediately before the write: a cancel that landed while the
      // grant was resolving must not reach auth.json. Once the commit DOES
      // publish, the terminal is succeeded even if a cancel raced it (080).
      if (activeFlow !== flow || flow.controller.signal.aborted || isTerminal(flow.status)) return;
      await flow.prepared!.commit({
        accessToken: grant.credential.access,
        refreshToken: grant.credential.refresh,
        idToken: grant.idToken,
        chatgptAccountId: grant.credential.accountId!,
      });
      flow.published = true;
      finish(flow, { flowId, status: "succeeded", credentialUpdated: true }, clock());
    } catch (error) {
      if (flow.controller.signal.aborted && !flow.published) return;
      finish(flow, mapFailure(flowId, error), clock());
    }
  })();
  return flow.status;
}

export function getMainDeviceReauthStatus(flowId: string, deps: MainDeviceReauthDeps = {}): MainDeviceReauthStatus | null {
  const now = (deps.now ?? Date.now)();
  sweepTerminal(now);
  if (activeFlow?.flowId === flowId) return activeFlow.status;
  return terminalFlows.get(flowId)?.status ?? null;
}

/**
 * Cancel the flow. Cancellation after publication returns the published
 * terminal (succeeded), never cancelled; a pending/committing flow aborts its
 * grant and settles cancelled.
 */
export function cancelMainDeviceReauth(flowId: string, deps: MainDeviceReauthDeps = {}): MainDeviceReauthStatus | null {
  const now = (deps.now ?? Date.now)();
  sweepTerminal(now);
  if (activeFlow?.flowId === flowId && !isTerminal(activeFlow.status)) {
    activeFlow.controller.abort();
    finish(activeFlow, { flowId, status: "cancelled" }, now);
    return activeFlow.status;
  }
  return terminalFlows.get(flowId)?.status ?? null;
}

/** Test hook: drop all in-memory flow state. Production never calls this. */
export function resetMainDeviceReauthForTests(): void {
  // Abort first: a reset that only clears the maps leaves a pending grant
  // polling against real timers for up to the 15-minute device TTL.
  activeFlow?.controller.abort();
  activeFlow = null;
  terminalFlows.clear();
}
