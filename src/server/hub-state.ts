/**
 * The hub's own projection for `GET|HEAD /v1/hub-state` (#4236).
 *
 * Pure: it takes the config and an already-computed login summary and returns the DTO. The
 * route owns admission, the role gate and the size ceiling; this module owns what a client is
 * allowed to learn. Keeping the projection here — and building each row field by field rather
 * than spreading a provider or a login summary — is what makes "no keys, no emails, no account
 * ids" checkable by reading one function. A spread would silently start exporting whatever the
 * next field added to those records happens to be.
 *
 * Contract and caps live in `src/remote/hub-state.ts` so the client validates the same shape.
 */
import {
  HUB_STATE_SCHEMA_VERSION,
  MAX_HUB_STATE_OAUTH_PROVIDERS,
  MAX_HUB_STATE_PROVIDERS,
  MAX_HUB_STATE_SUBAGENT_MODELS,
  HUB_STATE_AUTH_MODES,
  type HubStateDTO,
  type HubStateOAuthEntry,
  type HubStateProvider,
} from "../remote/hub-state";
import { DEFAULT_SUBAGENT_MODELS } from "../config/subagent-models";
import type { OcxConfig } from "../types";

export type HubStateConfigView = Pick<OcxConfig, "providers" | "subagentModels" | "claudeCode" | "hub">;

/** A login summary row as `oauthLoginSummary()` returns it; extra fields are never read. */
export interface HubStateLoginRow {
  provider: string;
  loggedIn: boolean;
}

/**
 * The hub's effective featured roster: the same "unset means the defaults, an explicit `[]`
 * means none" rule `buildClaudeAgentDefs` applies, so a client that delegates from this list
 * sees exactly what the hub itself would offer.
 */
export function hubSubagentRoster(config: Pick<OcxConfig, "subagentModels">): string[] {
  return uncappedSubagentRoster(config).slice(0, MAX_HUB_STATE_SUBAGENT_MODELS);
}

/** The same roster before the cap, so `truncated` can be computed instead of guessed. */
function uncappedSubagentRoster(config: Pick<OcxConfig, "subagentModels">): string[] {
  const roster = config.subagentModels === undefined ? DEFAULT_SUBAGENT_MODELS : config.subagentModels;
  return roster
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map(entry => entry.trim());
}

export function buildHubState(
  config: HubStateConfigView,
  logins: readonly HubStateLoginRow[],
  hubVersion: string,
): HubStateDTO {
  // A disabled provider is dropped, not exported with a flag. `/v1/catalog` and `/v1/models`
  // both filter it out (`src/router.ts`, `src/codex/catalog/*`), so exporting it here was the
  // one thing this route told a data-key holder that no other data-plane route does — and a
  // client has no use for it either: it cannot be routed to, so absence IS the truthful report,
  // and `authMode` already explains a present-but-credential-less row without it.
  const enabledProviders = Object.entries(config.providers ?? {}).filter(([, provider]) => provider.disabled !== true);
  const providers: HubStateProvider[] = enabledProviders
    .slice(0, MAX_HUB_STATE_PROVIDERS)
    .map(([name, provider]) => ({
      name,
      adapter: provider.adapter,
      authMode: provider.authMode !== undefined && HUB_STATE_AUTH_MODES.includes(provider.authMode)
        ? provider.authMode
        : null,
      // Presence only. Identical to the projection GET /api/providers already ships.
      hasCredential: Boolean(provider.apiKey),
      // Always false here. The field stays in the contract for an older hub's documents; see
      // `HubStateProvider` in src/remote/hub-state.ts.
      disabled: false,
    }));
  // Field-by-field, never a spread: oauthLoginSummary also carries the operator's email.
  const oauth: HubStateOAuthEntry[] = logins
    .slice(0, MAX_HUB_STATE_OAUTH_PROVIDERS)
    .map(entry => ({ provider: entry.provider, loggedIn: entry.loggedIn === true }));
  const rosterBeforeCap = uncappedSubagentRoster(config).length;
  // Said out loud rather than silently: the caps are a prefix, and a client presenting a prefix
  // as the whole list is the same confident-and-wrong report this route exists to prevent.
  const truncated = enabledProviders.length > MAX_HUB_STATE_PROVIDERS
    || logins.length > MAX_HUB_STATE_OAUTH_PROVIDERS
    || rosterBeforeCap > MAX_HUB_STATE_SUBAGENT_MODELS;
  return {
    schemaVersion: HUB_STATE_SCHEMA_VERSION,
    runtimeRole: "hub",
    hubVersion,
    origin: config.hub?.dataPublicOrigin ?? null,
    providers,
    oauth,
    subagentModels: hubSubagentRoster(config),
    truncated,
    // Same predicate the launch path uses: absence means enabled.
    claudeCode: { enabled: config.claudeCode?.enabled !== false },
  };
}
