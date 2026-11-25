import { existsSync } from "node:fs";
import { getConfigPath, loadConfig } from "../config";
import { fileBackedConfigPath } from "../config/rebase-provenance";
import { providerEgressFetchInit, resolveProviderEgress, type PoolAccountRoute } from "../lib/provider-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { codexAccountEgressRoute } from "./account-egress";

/**
 * Routes for Codex pool calls that run without a request's config in hand: token refresh, usage
 * (WHAM) probes, model entitlement discovery and reset-credit calls.
 *
 * A pool account's credentialed calls leave by the same route as its inference: the account's own
 * `codexAccounts[].egress` over the `openai` provider's `proxy`/`noProxy` (the provider that owns
 * the account pool), over the global proxy. An account that names no proxy keeps the provider's.
 *
 * The running server binds its live config here (`setLiveStateStoreConfig`), so these calls read the
 * same routes as inference without reloading the file. A process with no live config (a CLI command)
 * loads the file instead, and refuses when that load fell back to defaults while `config.json`
 * exists: a route the operator configured must not be silently dropped.
 */
export type CodexAccountEgressConfig = Pick<OcxConfig, "codexAccounts" | "providers">;

let liveConfig: CodexAccountEgressConfig | undefined;

export function bindCodexAccountEgressConfig(config: CodexAccountEgressConfig): void {
  liveConfig = config;
}

/** Tests only. */
export function resetCodexAccountEgressConfigForTests(): void {
  liveConfig = undefined;
}

export class CodexAccountRouteUnavailableError extends Error {
  override readonly name = "CodexAccountRouteUnavailableError";
}

/** The provider whose route a pool account inherits. */
export const CODEX_POOL_PROVIDER = "openai";

function routingConfig(): CodexAccountEgressConfig {
  if (liveConfig) return liveConfig;
  const config = loadConfig();
  if (fileBackedConfigPath(config) === undefined && existsSync(getConfigPath())) {
    throw new CodexAccountRouteUnavailableError("Codex account routing configuration could not be loaded; refusing to send without it");
  }
  return config;
}

interface CodexAccountRouting {
  provider: Pick<OcxProviderConfig, "proxy" | "noProxy">;
  account?: PoolAccountRoute;
}

/**
 * The routing inputs for one pool account's call, or undefined when nothing configures a route for
 * it (not a pool account, or neither the account nor the provider sets `proxy`/`noProxy`), in which
 * case the call keeps the process-wide route unchanged.
 */
export function codexAccountRouting(
  accountId: string | null | undefined, config?: CodexAccountEgressConfig,
): CodexAccountRouting | undefined {
  if (!accountId) return undefined;
  const source = config ?? routingConfig();
  if (!source.codexAccounts?.some(row => row.id === accountId && row.isMain !== true)) return undefined;
  const account = codexAccountEgressRoute(source, accountId);
  const providerConfig = source.providers?.[CODEX_POOL_PROVIDER];
  const provider = { proxy: providerConfig?.proxy, noProxy: providerConfig?.noProxy };
  if (!account && provider.proxy === undefined && provider.noProxy === undefined) return undefined;
  return { provider, ...(account ? { account } : {}) };
}

function routeInit(routing: CodexAccountRouting, input: RequestInfo | URL): { proxy?: string | false } {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return providerEgressFetchInit(resolveProviderEgress({ providerName: CODEX_POOL_PROVIDER, provider: routing.provider, url, account: routing.account }));
}

/**
 * A fetch for one pool account's credentialed call. With a configured route it sends through
 * `configuredOutboundFetch` (so the explicit-proxy guards apply) over `base`; without one it is `base`
 * (or the global fetch, looked up at call time) unchanged.
 */
export function codexAccountFetch(
  accountId: string | null | undefined, base?: typeof globalThis.fetch, config?: CodexAccountEgressConfig,
): typeof globalThis.fetch {
  const routing = codexAccountRouting(accountId, config);
  if (!routing) return base ?? (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof globalThis.fetch);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    configuredOutboundFetch(input, { ...init, ...routeInit(routing, input) } as RequestInit, base)) as typeof globalThis.fetch;
}
