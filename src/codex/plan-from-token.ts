import {
  ConfigMutationLockError,
  loadConfig,
  mutatePersistedConfig,
} from "../config";
import type { CodexAccount, OcxConfig } from "../types";
import { isSelectableCodexPoolAccount, isValidCodexAccountId } from "./account-id";
import {
  getCodexAccountCredential,
  isCodexAccountGenerationLive,
  readCodexAccountRecord,
} from "./account-store";
import { extractChatgptPlanType, codexPlanValue } from "./plan";

interface FreshPoolPlanUpdate {
  accountId: string;
  plan: string;
  credentialGeneration: number;
}

function configuredPoolAccount(config: OcxConfig, accountId: string): CodexAccount | null {
  if (!isValidCodexAccountId(accountId)) return null;
  return (config.codexAccounts ?? [])
    .find(account => account.id === accountId && isSelectableCodexPoolAccount(account)) ?? null;
}

function jwtPlanFromPoolCredential(accountId: string): string | undefined {
  const cred = getCodexAccountCredential(accountId);
  return cred ? extractChatgptPlanType(undefined, cred.accessToken) : undefined;
}

/**
 * WHAM-wins gate (release-audit fix). A JWT-derived plan may be persisted only when no
 * WHAM-sourced plan exists for the CURRENT credential generation. A token refresh bumps the
 * generation, and the refreshed JWT is then genuinely newer information than the previous
 * generation's WHAM read, so it may write again until WHAM re-observes. Records without
 * provenance (legacy) stay writable so the original #1989 recovery still works.
 */
function jwtMayWritePlan(account: CodexAccount, generation: number): boolean {
  if (account.planSource !== "wham") return true;
  const whamGeneration = account.planCredentialGeneration;
  return whamGeneration !== undefined && generation > whamGeneration;
}

function collectJwtPoolPlanUpdates(runtimeConfig: OcxConfig): FreshPoolPlanUpdate[] {
  const updates: FreshPoolPlanUpdate[] = [];
  for (const account of (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount)) {
    const jwtPlan = jwtPlanFromPoolCredential(account.id);
    if (!jwtPlan || codexPlanValue(account.plan) === jwtPlan) continue;
    const generation = readCodexAccountRecord(account.id)?.generation;
    if (generation === undefined) continue;
    if (!jwtMayWritePlan(account, generation)) continue;
    updates.push({ accountId: account.id, plan: jwtPlan, credentialGeneration: generation });
  }
  return updates;
}

const appliedJwtPlans = new Map<string, string>();

function persistJwtPlanUpdates(runtimeConfig: OcxConfig, updates: FreshPoolPlanUpdate[]): void {
  if (updates.length === 0) return;
  let outcome: ReturnType<typeof mutatePersistedConfig<FreshPoolPlanUpdate[]>>;
  try {
    outcome = mutatePersistedConfig(persistedConfig => {
      const accepted: FreshPoolPlanUpdate[] = [];
      let changed = false;
      for (const update of updates) {
        if (!isCodexAccountGenerationLive(update.accountId, update.credentialGeneration)) continue;
        const liveAccount = configuredPoolAccount(runtimeConfig, update.accountId);
        const persistedAccount = configuredPoolAccount(persistedConfig, update.accountId);
        if (!liveAccount || !persistedAccount) continue;
        // Re-check against the PERSISTED row: another process may have landed a WHAM
        // observation between collect and this mutation.
        if (!jwtMayWritePlan(persistedAccount, update.credentialGeneration)) continue;
        accepted.push(update);
        if (persistedAccount.plan !== update.plan) {
          persistedAccount.plan = update.plan;
          changed = true;
        }
        if (persistedAccount.planSource !== "jwt" || persistedAccount.planCredentialGeneration !== update.credentialGeneration) {
          persistedAccount.planSource = "jwt";
          persistedAccount.planCredentialGeneration = update.credentialGeneration;
          changed = true;
        }
      }
      return { changed, value: accepted };
    });
  } catch (error) {
    if (error instanceof ConfigMutationLockError) return;
    throw error;
  }
  if (outcome.status === "unavailable") return;
  for (const update of outcome.value) {
    if (!isCodexAccountGenerationLive(update.accountId, update.credentialGeneration)) continue;
    const liveAccount = configuredPoolAccount(runtimeConfig, update.accountId);
    if (liveAccount) {
      liveAccount.plan = update.plan;
      liveAccount.planSource = "jwt";
      liveAccount.planCredentialGeneration = update.credentialGeneration;
      appliedJwtPlans.set(update.accountId, update.plan);
    }
  }
}

/**
 * Persist JWT `chatgpt_plan_type` onto `codexAccounts[].plan` when it contradicts the stored
 * label. Generation-gated, same fail-closed lock policy as the WHAM plan patch. Does not
 * overwrite a plan that already matches the token.
 */
export function reconcileCodexPlansFromTokens(runtimeConfig: OcxConfig = loadConfig()): void {
  persistJwtPlanUpdates(runtimeConfig, collectJwtPoolPlanUpdates(runtimeConfig));
}

export function resetJwtPlanNotesForTests(): void {
  appliedJwtPlans.clear();
}

/** Apply one account's live token claim without blocking the credential read path. */
export function noteCodexAccountAccessToken(
  accountId: string,
  accessToken: string,
  credentialGeneration: number,
): void {
  const jwtPlan = extractChatgptPlanType(undefined, accessToken);
  if (!jwtPlan) return;
  if (appliedJwtPlans.get(accountId) === jwtPlan) return;
  try {
    const runtimeConfig = loadConfig();
    const live = configuredPoolAccount(runtimeConfig, accountId);
    if (!live || codexPlanValue(live.plan) === jwtPlan) {
      appliedJwtPlans.set(accountId, jwtPlan);
      return;
    }
    if (!jwtMayWritePlan(live, credentialGeneration)) return;
    persistJwtPlanUpdates(runtimeConfig, [{ accountId, plan: jwtPlan, credentialGeneration }]);
    if (codexPlanValue(live.plan) === jwtPlan) appliedJwtPlans.set(accountId, jwtPlan);
  } catch {
    appliedJwtPlans.delete(accountId);
  }
}
