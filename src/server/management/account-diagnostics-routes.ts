/**
 * `GET /api/oauth/accounts/diagnostics?provider=<id>`: why each account of one OAuth login can or
 * cannot serve traffic right now.
 *
 * A passive read assembled from state routing already keeps: account eligibility (the same
 * readers selection uses, per model where routing scopes it), the account-wide cooldown, the last
 * upstream refresh result (`oauth/refresh-outcomes.ts`) and in-flight leases. Rows carry the
 * account id only: no email, label, organization or credential field.
 */
import { isPublicOAuthProvider, OAUTH_PROVIDERS } from "../../oauth";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { getAccountSet, accountNeedsReauthForStatus } from "../../oauth/store";
import { lastOAuthRefreshOutcome } from "../../oauth/refresh-outcomes";
import { eligibleFailoverAccounts, genericAccountCooldownUntil, isGenericFailoverProvider } from "../../oauth/generic-account-failover";
import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
import { accountInFlight } from "../../oauth/kiro-account-load";
import { anthropicRoutingFor } from "../../oauth/anthropic-routing";
import { antigravityAccountSupportsModel } from "../../providers/antigravity-account-roster";
import { configuredAnthropicInstance, isAnthropicOAuthInstance, type AnthropicInstanceId } from "../../providers/anthropic-instance";
import { getStaleCached } from "../../codex/model-cache";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export const ACCOUNT_DIAGNOSTICS_PATH = "/api/oauth/accounts/diagnostics";

export interface AccountDiagnosticsRow {
  id: string;
  active: boolean;
  paused: boolean;
  needsReauth: boolean;
  /** Whether automatic selection may pick this account for some model right now. */
  eligible: boolean;
  /** Known models this account may serve right now; null when the provider's model list is unknown. */
  eligibleModels: string[] | null;
  lastRefresh: { at: number; ok: boolean; reason?: string; status?: number } | null;
  cooldownUntil: number | null;
  inFlight: number;
}

function providerConfig(provider: string, config: ManagementContext["config"]) {
  if (provider === "anthropic2" && !configuredAnthropicInstance(config, provider)) return undefined;
  const configured = config.providers[provider];
  if (configured) return configured;
  const definition = OAUTH_PROVIDERS[provider];
  return definition?.resolveProviderConfig?.(config) ?? definition?.providerConfig;
}

/** Known model ids for the provider: the discovered catalog, else the configured list. */
function knownModels(provider: string, config: ManagementContext["config"]): string[] | null {
  const discovered = getStaleCached(provider)?.map(model => model.id).filter(id => typeof id === "string" && id.length > 0);
  if (discovered?.length) return [...new Set(discovered)];
  const configured = config.providers[provider]?.models?.filter(id => typeof id === "string" && id.length > 0);
  return configured?.length ? [...new Set(configured)] : null;
}

export function buildAccountDiagnostics(
  provider: string, config: ManagementContext["config"], now = Date.now(),
): { provider: string; activeAccountId: string | null; models: string[] | null; accounts: AccountDiagnosticsRow[] } {
  const set = getAccountSet(provider);
  const accounts = set?.accounts ?? [];
  const models = knownModels(provider, config);
  const effective = providerConfig(provider, config);
  const anthropic = isAnthropicOAuthInstance(provider) && effective?.authMode === "oauth"
    ? anthropicRoutingFor(provider as AnthropicInstanceId) : undefined;
  const generic = !anthropic && effective !== undefined && isGenericFailoverProvider(provider, effective);

  // One eligibility read per model (and one for "any model"), shared by every account row.
  const eligibleFor = (model?: string): Set<string> | undefined => {
    if (anthropic) return new Set(anthropic.getEligibleAnthropicAccounts(now, model));
    if (generic) return new Set(eligibleFailoverAccounts(provider, now, classifyModelFamilyForQuota(provider, model)));
    return undefined;
  };
  const anyModel = eligibleFor();
  const perModel = new Map((models ?? []).map(model => [model, eligibleFor(model)] as const));

  const rows = accounts.map((account): AccountDiagnosticsRow => {
    const paused = account.paused === true;
    const needsReauth = accountNeedsReauthForStatus(provider, account, now);
    const eligible = anyModel ? anyModel.has(account.id) : !paused && !needsReauth;
    const eligibleModels = models === null ? null : models.filter(model => {
      const ids = perModel.get(model);
      if (ids ? !ids.has(account.id) : !eligible) return false;
      // Antigravity gates models per account from its discovered roster (#7500).
      return provider !== "google-antigravity" || antigravityAccountSupportsModel(provider, account.id, model, now) !== false;
    });
    const cooldownUntil = anthropic
      ? anthropic.getAnthropicAccountHealthSnapshot(account.id, now)?.cooldownUntil ?? null
      : genericAccountCooldownUntil(provider, account.id, now);
    const refresh = lastOAuthRefreshOutcome(provider, account.id);
    return {
      id: account.id,
      active: set?.activeAccountId === account.id,
      paused,
      needsReauth,
      eligible,
      eligibleModels,
      lastRefresh: refresh ? { ...refresh } : null,
      cooldownUntil,
      inFlight: accountInFlight(provider, account.id),
    };
  });
  return { provider, activeAccountId: set?.activeAccountId ?? null, models, accounts: rows };
}

export function handleAccountDiagnosticsRoutes(ctx: Pick<ManagementContext, "req" | "url" | "config">): Response | null {
  const { req, url, config } = ctx;
  if (url.pathname !== ACCOUNT_DIAGNOSTICS_PATH || req.method !== "GET") return null;
  const provider = oauthCredentialSlot((url.searchParams.get("provider") ?? "").trim().toLowerCase());
  if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
  const response = jsonResponse(buildAccountDiagnostics(provider, config), 200, req, config);
  response.headers.set("cache-control", "no-store");
  return response;
}
