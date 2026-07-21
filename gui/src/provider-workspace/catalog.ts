/**
 * provider-workspace/catalog.ts
 *
 * Pure catalog/classification helpers for the Providers workspace view.
 * No network calls, no React — transforms the proxy config `providers` map
 * into stable UI sections and tier tags.
 *
 * Binning rules (applied in priority order):
 *  1. disabled === true              -> disabled
 *  2. keyOptional === true           -> ready  (key not required — not the same as free pricing)
 *  3. authMode === "oauth"           -> ready  (credentials managed externally)
 *  4. authMode === "forward"         -> ready  (passes caller credentials through)
 *  5. authMode === "local"           -> ready  (local runtime, no key required)
 *  6. loopback base URL              -> ready  (local runtime, auth mode may be stripped)
 *  7. hasApiKey === true             -> ready  (key-auth with credential present)
 *  8. everything else                -> needsSetup
 *
 * Live-auth overlay: `applyActiveAccountReauth` may demote ready → needs-setup
 * when the active account needs reauth (config binning rules above unchanged).
 *
 * Tiers (three-way, interview 2026-07-17): "accounts" (the canonical OpenAI forward
 * provider), "free" (free pricing), "paid" (everything else). Accounts wins
 * over free.
 */

/**
 * Shape of a single provider value as it appears in the proxy config map.
 * The provider name is the Record key, not a field here.
 */
export interface WorkspaceProvider {
  adapter: string;
  baseUrl: string;
  hasApiKey?: boolean;
  hasHeaders?: boolean;
  defaultModel?: string;
  /** Static/configured model ids from provider config (offline fallback). */
  models?: string[];
  authMode?: "key" | "forward" | "oauth" | "local" | string;
  keyOptional?: boolean;
  /** Free pricing (may still require an API key). */
  freeTier?: boolean;
  disabled?: boolean;
  note?: string;
  allowPrivateNetwork?: boolean;
  /** When false, only the configured `models` are routed (no /models fetch). */
  liveModels?: boolean;
  /** Static model list. Used as the authoritative catalog when `liveModels === false`. */
  models?: string[];
}

/** Three-way pricing/ownership tier for a ready provider row. */
export type ProviderTier = "free" | "paid" | "accounts";

/**
 * A provider item as surfaced to the workspace view.
 * Extends WorkspaceProvider with the name resolved from the Record key.
 */
export interface WorkspaceItem extends WorkspaceProvider {
  name: string;
  /** Present on ready items; needsSetup/disabled rows omit it. */
  tier?: ProviderTier;
  /** Set by `applyActiveAccountReauth` when live auth health overrides config readiness. */
  activeNeedsReauth?: boolean;
}

/** The three sections rendered in the Providers workspace. */
export interface WorkspaceSections {
  /** Providers that are enabled and have all credentials needed to route requests. */
  ready: WorkspaceItem[];
  /** Enabled providers that are missing required credentials (e.g. an API key). */
  needsSetup: WorkspaceItem[];
  /** Providers explicitly disabled by the user. */
  disabled: WorkspaceItem[];
}

const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * The single canonical OpenAI forward provider id. Legacy ids are migration-only
 * and must never be revived as account-provider workspace rows.
 */
const CANONICAL_FORWARD_PROVIDER = "openai";

/**
 * Mirrors src/providers/openai-tiers.ts `normalizedBaseUrl` exactly: strict
 * parsing, userinfo/query/hash rejection, no raw-string fallback.
 */
function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

/** Loopback host check shared with the provider-kind classifier (WP080a). */
export function hasLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isConfigurationReady(p: WorkspaceProvider): boolean {
  return p.keyOptional === true ||
    p.authMode === "oauth" ||
    p.authMode === "forward" ||
    p.authMode === "local" ||
    hasLoopbackBaseUrl(p.baseUrl) ||
    p.hasApiKey === true;
}

/**
 * True when the provider config is the canonical Codex passthrough shape.
 * GUI-local mirror of `isCanonicalOpenAiForwardProvider` (src/providers/openai-tiers.ts) —
 * strict casing, no fallback.
 */
function isCanonicalForwardShape(p: WorkspaceProvider): boolean {
  return p.adapter === "openai-responses"
    && p.authMode === "forward"
    && normalizedBaseUrl(p.baseUrl) === CODEX_FORWARD_BASE_URL;
}

/**
 * True for the single OpenAI account-backed provider in its canonical passthrough shape.
 */
export function isAccountProvider(name: string, p: WorkspaceProvider): boolean {
  return name === CANONICAL_FORWARD_PROVIDER && isCanonicalForwardShape(p);
}

/**
 * Free pricing (badge / filter / sort): `freeTier`, keyless free (`keyOptional`),
 * local runtimes, or loopback. Forward passthrough is NOT free — those are
 * account providers. Does **not** imply ready-without-key — use
 * `binProviderStatus` for readiness.
 */
export function isFreeProvider(p: WorkspaceProvider): boolean {
  return p.freeTier === true
    || p.keyOptional === true
    || p.authMode === "local"
    || hasLoopbackBaseUrl(p.baseUrl);
}

export function isPaidProvider(name: string, p: WorkspaceProvider): boolean {
  return providerTier(name, p) === "paid";
}

/** Three-way tier: accounts wins over free; everything else is paid. */
export function providerTier(name: string, p: WorkspaceProvider): ProviderTier {
  if (isAccountProvider(name, p)) return "accounts";
  if (isFreeProvider(p)) return "free";
  return "paid";
}

/** Rail / list sort modes for the providers workspace. */
export type ProviderSortMode = "az" | "za" | "free-paid" | "paid-free" | "accounts-first";

export function sortWorkspaceItems(items: WorkspaceItem[], mode: ProviderSortMode): WorkspaceItem[] {
  const copy = [...items];
  const byName = (a: WorkspaceItem, b: WorkspaceItem) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const tierOf = (i: WorkspaceItem): ProviderTier => i.tier ?? providerTier(i.name, i);
  switch (mode) {
    case "az":
      return copy.sort(byName);
    case "za":
      return copy.sort((a, b) => byName(b, a));
    case "free-paid":
      return copy.sort((a, b) => {
        const af = tierOf(a) === "free" ? 0 : 1;
        const bf = tierOf(b) === "free" ? 0 : 1;
        return af - bf || byName(a, b);
      });
    case "paid-free":
      return copy.sort((a, b) => {
        const af = tierOf(a) === "free" ? 1 : 0;
        const bf = tierOf(b) === "free" ? 1 : 0;
        return af - bf || byName(a, b);
      });
    case "accounts-first":
      return copy.sort((a, b) => {
        const rank = (i: WorkspaceItem) => {
          const tier = tierOf(i);
          return tier === "accounts" ? 0 : tier === "free" ? 1 : 2;
        };
        return rank(a) - rank(b) || byName(a, b);
      });
    default:
      return copy;
  }
}

/**
 * Transforms the proxy config `providers` map into the three workspace sections.
 * Ready items carry their three-way `tier`. Iteration order follows
 * `Object.entries` (insertion order).
 */
export function buildProviderWorkspace(
  providers: Record<string, WorkspaceProvider>,
): WorkspaceSections {
  const ready: WorkspaceItem[] = [];
  const needsSetup: WorkspaceItem[] = [];
  const disabled: WorkspaceItem[] = [];

  for (const [name, p] of Object.entries(providers)) {
    if (p.disabled) {
      disabled.push({ name, ...p });
      continue;
    }
    if (isConfigurationReady(p)) {
      ready.push({ name, ...p, tier: providerTier(name, p) });
    } else {
      needsSetup.push({ name, ...p });
    }
  }

  return { ready, needsSetup, disabled };
}

/**
 * Live-auth overlay: when the active account for a provider needs reauth,
 * demote that provider from ready → needs-setup. Inactive-only reauth is
 * ignored (caller must only set true for the active account).
 */
export function applyActiveAccountReauth(
  sections: WorkspaceSections,
  activeNeedsReauth: Readonly<Record<string, boolean>>,
): WorkspaceSections {
  const demote = new Set(
    Object.entries(activeNeedsReauth)
      .filter(([, needs]) => needs)
      .map(([name]) => name),
  );
  if (demote.size === 0) return sections;

  const stillReady: WorkspaceItem[] = [];
  const needsSetup = [...sections.needsSetup];
  for (const item of sections.ready) {
    if (demote.has(item.name)) {
      const demoted: WorkspaceItem = { ...item, activeNeedsReauth: true };
      delete demoted.tier;
      needsSetup.push(demoted);
    } else {
      stillReady.push(item);
    }
  }
  return { ready: stillReady, needsSetup, disabled: sections.disabled };
}

/** Canonical status string for a single provider — config plus optional live-auth overlay. */
export type ProviderStatus = "ready" | "needs-setup" | "disabled";

/**
 * Returns the canonical status for a single WorkspaceProvider (or WorkspaceItem).
 * Applies the same priority rules as buildProviderWorkspace, with an optional
 * live-auth overlay when `activeNeedsReauth` is set on a WorkspaceItem.
 */
export function binProviderStatus(p: WorkspaceProvider | WorkspaceItem): ProviderStatus {
  if (p.disabled) return "disabled";
  if ("activeNeedsReauth" in p && p.activeNeedsReauth) return "needs-setup";
  if (isConfigurationReady(p)) return "ready";
  return "needs-setup";
}

/**
 * Hide the legacy `chatgpt` row when canonical `openai` already covers the same
 * ChatGPT passthrough. Backend may still keep both ids (OAuth scratch / images);
 * the workspace should show one row per passthrough surface.
 */
export function hideRedundantChatGptForwardProviders<T extends WorkspaceProvider>(
  providers: Record<string, T>,
): Record<string, T> {
  const openai = providers.openai;
  const chatgpt = providers.chatgpt;
  if (!openai || !chatgpt) return providers;
  if (!isAccountProvider("openai", openai)) return providers;
  if (!isCanonicalForwardShape(chatgpt)) return providers;
  const rest = { ...providers };
  delete rest.chatgpt;
  return rest;
}

/**
 * Resolve the one current Codex-account provider used by account-management links.
 * Legacy or custom forward-shaped rows are not eligible owners.
 */
export function pickCanonicalForwardProvider(
  providers: Record<string, WorkspaceProvider>,
): string | null {
  if (providers.openai && isAccountProvider("openai", providers.openai)) return "openai";
  return null;
}
