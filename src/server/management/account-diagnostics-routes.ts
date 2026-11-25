/**
 * `GET /api/oauth/accounts/diagnostics?provider=<id>`: why each account of one OAuth login can or
 * cannot serve traffic right now.
 *
 * A passive read (`runPassiveReadSync`) assembled from state routing already keeps: account
 * eligibility (the readers selection uses, once per quota family), the account-wide cooldown, the
 * last upstream refresh result (`oauth/refresh-outcomes.ts`) and in-flight leases. Rows carry the
 * account id only: no email, label, organization or credential field.
 */
import { isPublicOAuthProvider, OAUTH_PROVIDERS } from "../../oauth";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { getAccountSet, accountNeedsReauthForStatus } from "../../oauth/store";
import { lastOAuthRefreshOutcome } from "../../oauth/refresh-outcomes";
import { eligibleFailoverAccounts, genericAccountCooldownUntil, isGenericFailoverProvider } from "../../oauth/generic-account-failover";
import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
import { anthropicModelFamily } from "../../oauth/anthropic-model-family";
import { accountInFlight } from "../../oauth/kiro-account-load";
import { anthropicRoutingFor } from "../../oauth/anthropic-routing";
import { antigravityAccountModelSupport } from "../../providers/antigravity-account-roster";
import { configuredAnthropicInstance, isAnthropicOAuthInstance, type AnthropicInstanceId } from "../../providers/anthropic-instance";
import { getStaleCached } from "../../codex/model-cache";
import { runPassiveReadSync } from "../../lib/passive-read";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export interface AccountDiagnosticsRow {
  id: string;
  active: boolean;
  paused: boolean;
  needsReauth: boolean;
  /** Whether automatic selection may pick this account right now (for some known model, when models are known). */
  eligible: boolean;
  /** Known models this account may serve right now; null when the provider's model list is unknown. */
  eligibleModels: string[] | null;
  lastRefresh: { at: number; ok: boolean; reason?: string; status?: number } | null;
  cooldownUntil: number | null;
  inFlight: number;
  /** Kiro only: the account holds as many leases as `maxConcurrentPerAccount` allows. */
  atCapacity?: boolean;
}

type Config = ManagementContext["config"];

function providerConfig(provider: string, config: Config) {
  if (provider === "anthropic2" && !configuredAnthropicInstance(config, provider)) return undefined;
  const configured = config.providers[provider];
  if (configured) return configured;
  const definition = OAUTH_PROVIDERS[provider];
  return definition?.resolveProviderConfig?.(config) ?? definition?.providerConfig;
}

/** Known model ids for the provider: the discovered catalog, else the configured list. */
function knownModels(provider: string, config: Config): string[] | null {
  const discovered = getStaleCached(provider)?.map(model => model.id).filter(id => typeof id === "string" && id.length > 0);
  if (discovered?.length) return [...new Set(discovered)];
  const configured = config.providers[provider]?.models?.filter(id => typeof id === "string" && id.length > 0);
  return configured?.length ? [...new Set(configured)] : null;
}

function kiroCap(config: Config): number | undefined {
  const cap = config.providers?.kiro?.oauthAccountFailover?.maxConcurrentPerAccount;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 100 ? cap : undefined;
}

export function buildAccountDiagnostics(
  provider: string, config: Config, now = Date.now(),
): { provider: string; activeAccountId: string | null; models: string[] | null; accounts: AccountDiagnosticsRow[] } {
  return runPassiveReadSync(() => {
    const set = getAccountSet(provider);
    const accounts = set?.accounts ?? [];
    const models = knownModels(provider, config);
    const effective = providerConfig(provider, config);
    const anthropic = isAnthropicOAuthInstance(provider) && effective?.authMode === "oauth"
      ? anthropicRoutingFor(provider as AnthropicInstanceId) : undefined;
    const generic = !anthropic && effective !== undefined && isGenericFailoverProvider(provider, effective);

    // Eligibility varies only by quota family, so each reader runs once per family a known model has.
    const familyOf = (model?: string): string => (anthropic ? anthropicModelFamily(model) : classifyModelFamilyForQuota(provider, model)) ?? "";
    const byFamily = new Map<string, Set<string> | undefined>();
    const eligibleFor = (model?: string): Set<string> | undefined => {
      const family = familyOf(model);
      if (!byFamily.has(family)) {
        byFamily.set(family, anthropic ? new Set(anthropic.getEligibleAnthropicAccounts(now, model))
          : generic ? new Set(eligibleFailoverAccounts(provider, now, classifyModelFamilyForQuota(provider, model))) : undefined);
      }
      return byFamily.get(family);
    };
    const anyModel = eligibleFor();
    const cap = provider === "kiro" ? kiroCap(config) : undefined;

    const rows = accounts.map((account): AccountDiagnosticsRow => {
      const paused = account.paused === true;
      const needsReauth = accountNeedsReauthForStatus(provider, account, now);
      const inFlight = accountInFlight(provider, account.id);
      const atCapacity = cap !== undefined && inFlight >= cap;
      const selectable = !atCapacity && (anyModel ? anyModel.has(account.id) : !paused && !needsReauth);
      // Antigravity gates models per account from its discovered roster (#7500).
      const roster = provider === "google-antigravity" && models ? antigravityAccountModelSupport(provider, account.id, models, now) : undefined;
      const eligibleModels = models === null ? null : models.filter(model => {
        if (atCapacity) return false;
        const ids = eligibleFor(model);
        if (ids ? !ids.has(account.id) : !selectable) return false;
        return roster?.get(model) !== false;
      });
      const cooldownUntil = anthropic
        ? anthropic.getAnthropicAccountHealthSnapshot(account.id, now)?.cooldownUntil ?? null
        : genericAccountCooldownUntil(provider, account.id, now);
      const refresh = lastOAuthRefreshOutcome(provider, account.id, account.addedAt ?? 0);
      return {
        id: account.id,
        active: set?.activeAccountId === account.id,
        paused,
        needsReauth,
        eligible: eligibleModels === null ? selectable : eligibleModels.length > 0,
        eligibleModels,
        lastRefresh: refresh ? { ...refresh } : null,
        cooldownUntil,
        inFlight,
        ...(cap !== undefined ? { atCapacity } : {}),
      };
    });
    return { provider, activeAccountId: set?.activeAccountId ?? null, models, accounts: rows };
  });
}

export function handleAccountDiagnosticsRoutes(ctx: Pick<ManagementContext, "req" | "url" | "config">): Response | null {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/oauth/accounts/diagnostics" || req.method !== "GET") return null;
  const provider = oauthCredentialSlot((url.searchParams.get("provider") ?? "").trim().toLowerCase());
  if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
  const response = jsonResponse(buildAccountDiagnostics(provider, config), 200, req, config);
  response.headers.set("cache-control", "no-store");
  return response;
}
