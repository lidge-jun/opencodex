import { existsSync } from "node:fs";
import { getConfigPath, loadConfig } from "../config";
import { configLoadFellBack, fileBackedConfigPath } from "../config/rebase-provenance";
import { providerEgressFetchInit, resolveProviderEgress, type PoolAccountRoute } from "../lib/provider-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { codexAccountEgressRoute } from "./account-egress";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Routes for Codex pool calls that run without a request's config in hand: token refresh, usage
 * (WHAM) probes, model discovery, reset credits, warmup and the post-login usage read.
 *
 * A pool account's credentialed calls leave by the same route as its inference: the account's own
 * `codexAccounts[].egress` over the `openai` provider's `proxy`/`noProxy` (the provider that owns
 * the account pool), over the global proxy. An account that names no proxy keeps the provider's.
 *
 * The route is resolved at each send, and every failure to establish it refuses the send rather
 * than letting a pool credential leave by another route:
 * - a stored pool credential whose row the config no longer lists (removed while the credential was
 *   in hand, even if credential cleanup failed, or an orphan whose former route is unknown);
 * - a config that could not be read, so the load fell back to defaults while `config.json` exists.
 * - no routing configuration at all (no binding for the current home and no `config.json`): a
 *   stored credential's former route cannot be known once its config is gone.
 * Only a new login, whose row does not exist yet, takes the provider's route without a row.
 *
 * The running server binds its live config here for the lifetime of its background lifecycle
 * (`src/server/background-lifecycle.ts`), together with the config path it was loaded from. A call
 * made with no binding, or under a different config home, loads that home's file instead.
 */
export type CodexAccountEgressConfig = Pick<OcxConfig, "codexAccounts" | "providers">;

export interface CodexAccountEgressBinding {
  config: CodexAccountEgressConfig;
  configPath: string;
  /** The config this server started with is defaults standing in for an unreadable file. */
  degraded: boolean;
}

let live: CodexAccountEgressBinding | undefined;

/** Bind a server's config under the current config home; returns the binding so an owner can restore it. */
export function bindCodexAccountEgressConfig(config: CodexAccountEgressConfig): CodexAccountEgressBinding {
  const configPath = getConfigPath();
  live = { config, configPath, degraded: configLoadFellBack(configPath) && existsSync(configPath) };
  return live;
}

/** Reinstall a binding exactly as it was captured, with its own config home and load state. */
export function restoreCodexAccountEgressBinding(binding: CodexAccountEgressBinding): void {
  live = binding;
}

/** Detach the live binding; with a config, only when it is still the bound one. */
export function unbindCodexAccountEgressConfig(config?: CodexAccountEgressConfig): void {
  if (!config || live?.config === config) live = undefined;
}

/** Tests only. */
export function resetCodexAccountEgressConfigForTests(): void {
  live = undefined;
}

export class CodexAccountRouteUnavailableError extends Error {
  override readonly name = "CodexAccountRouteUnavailableError";
}

/** The provider whose route a pool account inherits. */
export const CODEX_POOL_PROVIDER = "openai";

/**
 * Test seam: suites whose fixtures store pool credentials without a config (written long before
 * account routes existed) keep the earlier behaviour, sending with no account route instead of
 * refusing. The test preload sets it; the account-egress suites clear it to exercise the refusals.
 * It has no effect unless the test home guard is armed, so a production process cannot set it.
 */
const UNLISTED_FIXTURE_SEAM = Symbol.for("opencodex.codex-account-egress.unlisted-fixture-seam");
function unlistedFixturesAllowed(): boolean {
  return (globalThis as { [UNLISTED_FIXTURE_SEAM]?: unknown })[UNLISTED_FIXTURE_SEAM] === true && isTestHomeGuardArmed();
}

const UNREADABLE = "Codex account routing configuration could not be loaded; refusing to send without it";

/** The config whose routes apply now, or undefined when none exists (no binding, no `config.json`). */
function routingConfig(): CodexAccountEgressConfig | undefined {
  const configPath = getConfigPath();
  if (live && live.configPath === configPath) {
    if (live.degraded) throw new CodexAccountRouteUnavailableError(UNREADABLE);
    return live.config;
  }
  if (!existsSync(configPath)) return undefined;
  const config = loadConfig();
  if (fileBackedConfigPath(config) === undefined || configLoadFellBack(configPath)) {
    throw new CodexAccountRouteUnavailableError(UNREADABLE);
  }
  return config;
}

interface CodexAccountRouting {
  provider: Pick<OcxProviderConfig, "proxy" | "noProxy">;
  account?: PoolAccountRoute;
}

export interface CodexAccountRoutingOptions {
  config?: CodexAccountEgressConfig;
  /** A new login, whose pool row does not exist yet: it takes the provider's route. */
  newLogin?: boolean;
}

/**
 * The routing inputs for one account's call, or undefined when the call keeps the process-wide
 * route unchanged: no account (a direct or main-login caller), the main login, no config at all, or
 * a pool account for which neither the account nor the provider configures `proxy`/`noProxy`.
 */
export function codexAccountRouting(
  accountId: string | null | undefined, options: CodexAccountRoutingOptions = {},
): CodexAccountRouting | undefined {
  if (!accountId || accountId === MAIN_CODEX_ACCOUNT_ID) return undefined;
  const source = options.config ?? routingConfig();
  if (!source) {
    if (options.newLogin === true || unlistedFixturesAllowed()) return undefined;
    throw new CodexAccountRouteUnavailableError("no Codex account routing configuration exists; refusing to send a stored pool credential");
  }
  const row = source.codexAccounts?.find(candidate => candidate.id === accountId);
  if (row?.isMain === true) return undefined;
  if (!row && options.newLogin !== true) {
    if (unlistedFixturesAllowed()) return undefined;
    throw new CodexAccountRouteUnavailableError("this Codex pool account is not configured; refusing to send its credential");
  }
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
 * A fetch for one account's credentialed call. The route is resolved when the call is sent; a
 * refusal rejects the call before any byte leaves. With a configured route it sends through
 * `configuredOutboundFetch` (so the explicit-proxy guards apply) over `base`; without one it is
 * `base` (or the global fetch, looked up at call time) unchanged.
 */
export function codexAccountFetch(
  accountId: string | null | undefined, options: CodexAccountRoutingOptions & { base?: typeof globalThis.fetch } = {},
): typeof globalThis.fetch {
  const { base } = options;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const routing = codexAccountRouting(accountId, options);
    if (!routing) return (base ?? fetch)(input, init);
    return configuredOutboundFetch(input, { ...init, ...routeInit(routing, input) } as RequestInit, base);
  }) as typeof globalThis.fetch;
}
