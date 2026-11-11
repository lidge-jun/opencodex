import type { AccountPauseReason } from "../types/account-auto-pause";
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";
import { credentialGeneration, getAccountSet } from "./store";

/**
 * Explicit, operator-requested health gate for `ocx account resume --if-healthy` (#8398).
 *
 * Owner decision: resume stays explicit (no background auto-resume). A pause whose recorded reason
 * cannot clear remotely (organization disabled, permission denied, #7101) is never health-resumed.
 * The check never refreshes a paused credential: every refresh path deliberately refuses a paused
 * row, so an expired stored token reports `credential_expired` and the operator re-logs in, which
 * clears an automatic pause. The usage read is the bare provider read, so it publishes no quota or
 * routing evidence for an account that is still paused.
 */
export const PERMANENT_PAUSE_REASONS: ReadonlySet<AccountPauseReason> = new Set([
  "oauth_organization_disabled", "account_permission_denied",
]);

export type ResumeHealthRefusal =
  | "pause_not_remote_clearable" | "health_check_unsupported" | "credential_expired"
  | "needs_reauth" | "usage_read_failed" | "account_changed";

export type ResumeHealthVerdict =
  | { ok: true; generation: string; pauseRevision: string | undefined }
  | { ok: false; reason: ResumeHealthRefusal };

export interface ResumeHealthDeps {
  now?: () => number;
  /** The provider's bare usage read for one bearer; resolves with a quota or null. */
  readUsage?: (provider: string, accessToken: string) => Promise<{ quota: unknown | null }>;
}

const EXPIRY_SKEW_MS = 60_000;

async function defaultUsageRead(_provider: string, accessToken: string): Promise<{ quota: unknown | null }> {
  const { probeAnthropicUsageQuota } = await import("../providers/claude-cli-usage");
  return await probeAnthropicUsageQuota(accessToken);
}

/** Whether one paused OAuth account may be resumed now; an unpaused account needs no check. */
export async function checkOAuthResumeHealth(provider: string, accountId: string, deps: ResumeHealthDeps = {}): Promise<ResumeHealthVerdict | null> {
  const now = deps.now ?? Date.now;
  const row = getAccountSet(provider)?.accounts.find(account => account.id === accountId);
  if (!row || row.paused !== true) return null;
  if (row.pauseDetails && PERMANENT_PAUSE_REASONS.has(row.pauseDetails.reason)) return { ok: false, reason: "pause_not_remote_clearable" };
  if (!isAnthropicInstanceId(provider)) return { ok: false, reason: "health_check_unsupported" };
  if (row.needsReauth === true) return { ok: false, reason: "needs_reauth" };
  const credential = row.credential;
  if (credential.expires <= now() + EXPIRY_SKEW_MS) return { ok: false, reason: "credential_expired" };
  const generation = credentialGeneration(credential);
  const pauseRevision = row.pauseRevision;
  let quota: unknown | null = null;
  try { quota = (await (deps.readUsage ?? defaultUsageRead)(provider, credential.access)).quota; } catch { quota = null; }
  if (quota === null || quota === undefined) return { ok: false, reason: "usage_read_failed" };
  const live = getAccountSet(provider)?.accounts.find(account => account.id === accountId);
  if (!live || live.paused !== true || live.pauseRevision !== pauseRevision || credentialGeneration(live.credential) !== generation) {
    return { ok: false, reason: "account_changed" };
  }
  return { ok: true, generation, pauseRevision };
}
