import type { OcxConfig } from "../types";
import { isCodexAccountPaused } from "./account-pause";
import { isCodexAccountGenerationLive } from "./account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { PERMANENT_PAUSE_REASONS, type ResumeHealthRefusal } from "../oauth/account-resume-health";
import type { PoolQuotaResult } from "./auth-api/pool-quota-probe";

export type CodexResumeHealthVerdict = { ok: true; pauseRevision: string | undefined } | { ok: false; reason: ResumeHealthRefusal };

/** An explicit refresh probe of one pool account: forced, operator-initiated, never a cached read. */
export type CodexHealthProbe = (accountId: string, plan: string | undefined) => Promise<PoolQuotaResult>;

const defaultProbe: CodexHealthProbe = async (accountId, plan) => {
  const { fetchPoolAccountQuota } = await import("./auth-api/pool-quota-probe");
  return await fetchPoolAccountQuota(accountId, true, plan, undefined, false, undefined, undefined, true);
};

/**
 * Health gate for `ocx account resume openai <id> --if-healthy` (#8398): the same rules as the OAuth
 * gate, read through the pool's own WHAM quota probe, which may refresh a pool credential. Healthy
 * means a fresh quota read by a credential generation that is still live; an exhausted window is
 * still healthy, because routing already handles a spent window. Null when the account is not paused.
 */
export async function checkCodexResumeHealth(config: OcxConfig, accountId: string, probe: CodexHealthProbe = defaultProbe): Promise<CodexResumeHealthVerdict | null> {
  if (!isCodexAccountPaused(config, accountId)) return null;
  const state = config.codexAccountPauseState?.[accountId];
  if (state?.details && PERMANENT_PAUSE_REASONS.has(state.details.reason)) return { ok: false, reason: "pause_not_remote_clearable" };
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return { ok: false, reason: "health_check_unsupported" };
  const pauseRevision = state?.revision;
  const plan = (config.codexAccounts ?? []).find(account => account.id === accountId && !account.isMain)?.plan;
  let result: PoolQuotaResult | undefined;
  try { result = await probe(accountId, plan); } catch { result = undefined; }
  if (!result) return { ok: false, reason: "usage_read_failed" };
  if (result.needsReauth) return { ok: false, reason: "needs_reauth" };
  const generation = result.freshCredentialGeneration;
  if (!result.freshQuota || generation === undefined || !isCodexAccountGenerationLive(accountId, generation)) return { ok: false, reason: "usage_read_failed" };
  if (!isCodexAccountPaused(config, accountId) || config.codexAccountPauseState?.[accountId]?.revision !== pauseRevision) {
    return { ok: false, reason: "account_changed" };
  }
  return { ok: true, pauseRevision };
}
