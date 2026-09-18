/**
 * One GUI client for the unified pool-settings contract.
 *
 * Before this, three fetchers spoke three shapes for the same two fields: the Codex threshold
 * write, the Codex strategy write with `accountPool`-prefixed response keys, and the Anthropic
 * pool read/write. `/api/pool/settings` answers identically for every kind, so the transport
 * collapses to this module and the components above keep their own presentation.
 */
import {
  normalizeAccountPoolQuotaWindow,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  type AccountPoolQuotaWindow,
  type AccountPoolStrategy,
} from "./account-pool-strategy";

/** The Codex pool is addressed by its provider id like any other kind. */
export const CODEX_POOL_PROVIDER = "openai";

export type PoolSettingsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PoolSettings {
  provider: string;
  kind: "codex" | "anthropic" | "generic";
  supported: string[];
  enabled: boolean | null;
  enabledEffective: boolean;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
  autoSwitchThreshold: number | null;
  quotaWindow: AccountPoolQuotaWindow | null;
}

/** Fields a caller may write. Named in GUI terms; mapped to the wire below. */
export interface PoolSettingsWrite {
  enabled?: boolean;
  strategy?: AccountPoolStrategy;
  stickyLimit?: number;
  /** GUI callers say "threshold"; the contract says autoSwitchThreshold. */
  threshold?: number;
  quotaWindow?: AccountPoolQuotaWindow;
}

function toDto(json: unknown, provider: string, fallback?: PoolSettingsWrite): PoolSettings {
  const raw = (json ?? {}) as Record<string, unknown>;
  const threshold = raw.autoSwitchThreshold ?? fallback?.threshold;
  return {
    provider,
    kind: raw.kind === "codex" || raw.kind === "anthropic" ? raw.kind : "generic",
    supported: Array.isArray(raw.supported) ? raw.supported.filter((f): f is string => typeof f === "string") : [],
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    enabledEffective: raw.enabledEffective === true,
    // Fall back to what was asked for when the response omits a field. A management write may
    // answer 204, and reporting the normalizer default there would silently show the operator
    // a different value than the one they just saved.
    strategy: normalizeAccountPoolStrategy(raw.strategy ?? fallback?.strategy),
    stickyLimit: normalizeAccountPoolStickyLimit(raw.stickyLimit ?? fallback?.stickyLimit),
    autoSwitchThreshold: typeof threshold === "number" ? threshold : null,
    quotaWindow: (raw.quotaWindow ?? fallback?.quotaWindow) === undefined || raw.quotaWindow === null
      ? null
      : normalizeAccountPoolQuotaWindow(raw.quotaWindow ?? fallback?.quotaWindow),
  };
}

/**
 * Map GUI field names onto the wire, and ALWAYS send `provider`.
 *
 * This is not ceremony. The route ignores a field it does not know, so a body that still said
 * `threshold` would return 200 and write nothing -- and `putAutoSwitchThreshold` only inspects
 * `response.ok`, so every save would report success while changing no setting. Silent success
 * is worse than a visible failure, which is why the mapping lives here rather than at each
 * call site where one of three could forget it.
 */
export function poolSettingsRequestBody(provider: string, fields: PoolSettingsWrite): Record<string, unknown> {
  return {
    provider,
    ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
    ...(fields.strategy !== undefined ? { strategy: fields.strategy } : {}),
    ...(fields.stickyLimit !== undefined ? { stickyLimit: fields.stickyLimit } : {}),
    ...(fields.threshold !== undefined ? { autoSwitchThreshold: fields.threshold } : {}),
    ...(fields.quotaWindow !== undefined ? { quotaWindow: fields.quotaWindow } : {}),
  };
}

export async function getPoolSettings(
  apiBase: string,
  provider: string,
  fetchImpl: PoolSettingsFetch = (input, init) => fetch(input, init),
  init?: RequestInit,
): Promise<PoolSettings | null> {
  try {
    const response = await fetchImpl(`${apiBase}/api/pool/settings?provider=${encodeURIComponent(provider)}`, init);
    if (!response.ok) return null;
    // No empty-body tolerance on the READ. `toDto` fills defaults, so `{}` would render as a
    // disabled pool with default values and the panel would treat that as a loaded state --
    // letting the next save overwrite the real configuration from fabricated input. A read
    // with no parseable body is a failed read. The write below is the opposite case: there,
    // an empty 2xx is a real success and the fallback is the settings just sent.
    return toDto(await response.json(), provider);
  } catch {
    return null;
  }
}

export async function putPoolSettings(
  apiBase: string,
  provider: string,
  fields: PoolSettingsWrite,
  fetchImpl: PoolSettingsFetch = (input, init) => fetch(input, init),
  init?: RequestInit,
): Promise<PoolSettings | null> {
  try {
    const response = await fetchImpl(`${apiBase}/api/pool/settings`, {
      ...init,
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      body: JSON.stringify(poolSettingsRequestBody(provider, fields)),
    });
    if (!response.ok) return null;
    // A 2xx with no parseable body is still a successful write; the old per-route clients
    // only inspected response.ok and a management PUT may answer 204.
    return toDto(await response.json().catch(() => ({})), provider, fields);
  } catch {
    return null;
  }
}

/**
 * Codex strategy/sticky write, kept as a named helper because three call sites use it.
 *
 * It lives HERE rather than in `account-pool-strategy.ts` for a structural reason: that module
 * owns the value normalizers this one imports, so putting the transport there too would make the
 * two modules import each other. The first draft papered over that with a dynamic import and the
 * bundler called it out as ineffective, which was the cycle telling on itself.
 */
export async function putCodexPoolStrategy(
  apiBase: string,
  body: { strategy?: AccountPoolStrategy; stickyLimit?: number },
  fetchImpl: PoolSettingsFetch = (input, init) => fetch(input, init),
): Promise<{ ok: true; strategy: AccountPoolStrategy; stickyLimit: number } | { ok: false }> {
  if (body.strategy === undefined && body.stickyLimit === undefined) return { ok: false };
  const settings = await putPoolSettings(apiBase, CODEX_POOL_PROVIDER, {
    strategy: body.strategy,
    stickyLimit: body.stickyLimit,
  }, fetchImpl);
  if (!settings) return { ok: false };
  return { ok: true, strategy: settings.strategy, stickyLimit: settings.stickyLimit };
}
