/**
 * The hub-state contract shared by `GET|HEAD /v1/hub-state` and every connected client.
 *
 * Why it exists (#4236): an agent working on a connected client machine read that machine's
 * own `~/.opencodex/config.json` and `ocx status`, saw `xai ✗ not logged in`, no grok provider
 * and five delegable models, and concluded the hub could not serve grok — while the hub had
 * xAI logged in and was serving grok all along. A client's local credential store is empty BY
 * DESIGN, so reporting it as the truth is not a cosmetic defect: it makes the client lie about
 * the only machine that has the facts.
 *
 * What may cross this boundary is deliberately narrow. The client holds a per-client DATA key
 * and no management credential, so this is a least-privilege data-plane read in the `/v1/catalog`
 * (#809) tradition rather than a widened `/api/*` boundary. The payload is BOOLEANS and model
 * ids: `hasCredential` is the same `!!p.apiKey` projection `GET /api/providers` already ships,
 * and `loggedIn` is `oauthLoginSummary`'s boolean with the email and account id dropped
 * entirely. No keys, no tokens, no quotas, no usage, no account identity — and nothing of that
 * shape may be added later, because this surface is reachable with a data key.
 *
 * The delta over `/v1/catalog`, stated exactly, because "only two booleans" was wrong and a
 * wrong boundary claim is worse than none. Provider names already leak through `/v1/catalog`
 * slugs and `/v1/models` ids, but only for providers those routes list. What this route adds is:
 * `hasCredential`, `loggedIn`, `authMode`, the featured roster — and the NAME and adapter of an
 * ENABLED provider that the catalog omits for want of a usable credential. That last one is the
 * point of the route (a client has to be able to say "the hub has xai configured and has no key
 * for it" rather than "the hub cannot serve grok"), and it is the whole widening.
 *
 * A provider the operator marked `disabled` is NOT exported — see `src/server/hub-state.ts`.
 * Naming it would tell a data-key holder about a provider no other data-plane route mentions,
 * and a client has no use for it: it is not routable, so "absent" is the truthful report.
 */

export const HUB_STATE_SCHEMA_VERSION = 1;

/** Hard caps, so the serialized body is bounded by construction rather than by hope. */
export const MAX_HUB_STATE_PROVIDERS = 200;
export const MAX_HUB_STATE_SUBAGENT_MODELS = 32;
export const MAX_HUB_STATE_OAUTH_PROVIDERS = 200;
export const MAX_HUB_STATE_STRING_CHARS = 200;
/** Response/transfer ceiling. The caps above keep a realistic body two orders below this. */
export const MAX_HUB_STATE_BYTES = 64 * 1024;

/**
 * Mirrors `OcxProviderConfig.authMode` (src/types/provider.ts); default `"key"`.
 *
 * It is shape, not secret: it says HOW a provider authenticates, which is what lets a client
 * explain `hasCredential: false` on an `oauth` provider without claiming nothing is configured.
 */
export const HUB_STATE_AUTH_MODES = ["key", "forward", "oauth", "local"] as const;
export type HubStateAuthMode = (typeof HUB_STATE_AUTH_MODES)[number] | null;

export interface HubStateProvider {
  name: string;
  adapter: string;
  authMode: HubStateAuthMode;
  /** Presence only — the same `!!p.apiKey` projection `GET /api/providers` ships. */
  hasCredential: boolean;
  /**
   * Always `false` from a hub of this version, which does not export a disabled provider at all.
   * The field stays in the contract because an OLDER hub does send `true`, and a client reading
   * one must still be able to label the row rather than present it as routable.
   */
  disabled: boolean;
}

export interface HubStateOAuthEntry {
  provider: string;
  /** `oauthLoginSummary().loggedIn`. The email and account id are dropped, not masked. */
  loggedIn: boolean;
}

export interface HubStateDTO {
  schemaVersion: typeof HUB_STATE_SCHEMA_VERSION;
  /** Always "hub": the route 404s on any other role, so a client can trust what it reads. */
  runtimeRole: "hub";
  hubVersion: string;
  /** `hub.dataPublicOrigin` when the operator set one; null rather than a guess. */
  origin: string | null;
  providers: HubStateProvider[];
  oauth: HubStateOAuthEntry[];
  /** The hub's effective featured subagent roster — what a client should delegate to. */
  subagentModels: string[];
  /**
   * At least one row was dropped to fit a cap above, so the arrays are a prefix rather than the
   * whole truth. Silent truncation is what this flag exists to prevent: a client that lists 200
   * of 240 providers and says nothing has told the reader the other 40 do not exist, which is
   * the same class of confident-and-wrong report #4236 is about.
   */
  truncated: boolean;
  claudeCode: { enabled: boolean };
}

function boundedString(value: unknown, max = MAX_HUB_STATE_STRING_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a hub-state body received over the wire.
 *
 * Returns null instead of throwing so both the live fetch and the on-disk cache can reject a
 * malformed document the same way, and so a client NEVER degrades to its own local login state
 * on a shape it does not recognize — degrading quietly is the defect being fixed.
 *
 * Unknown keys are dropped rather than refused: a newer hub must be readable by an older
 * client, and the fields this projection reads are all required.
 */
export function parseHubStateBody(value: unknown): HubStateDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== HUB_STATE_SCHEMA_VERSION) return null;
  if (raw.runtimeRole !== "hub") return null;
  const hubVersion = boundedString(raw.hubVersion, 64);
  if (!hubVersion) return null;
  const origin = raw.origin === null || raw.origin === undefined ? null : boundedString(raw.origin, 512);
  if (raw.origin !== null && raw.origin !== undefined && origin === null) return null;
  if (!Array.isArray(raw.providers) || raw.providers.length > MAX_HUB_STATE_PROVIDERS) return null;
  if (!Array.isArray(raw.oauth) || raw.oauth.length > MAX_HUB_STATE_OAUTH_PROVIDERS) return null;
  if (!Array.isArray(raw.subagentModels) || raw.subagentModels.length > MAX_HUB_STATE_SUBAGENT_MODELS) return null;
  const claudeCode = raw.claudeCode;
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) return null;
  const enabled = (claudeCode as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") return null;
  // Absent means false: a hub that predates the flag truncated nothing this client can detect,
  // and refusing its document would turn a new honesty field into a compatibility break. A
  // present non-boolean is still refused, like every other field here.
  if (raw.truncated !== undefined && typeof raw.truncated !== "boolean") return null;
  const truncated = raw.truncated === true;

  const providers: HubStateProvider[] = [];
  for (const row of raw.providers) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const entry = row as Record<string, unknown>;
    const name = boundedString(entry.name);
    const adapter = boundedString(entry.adapter);
    if (!name || !adapter) return null;
    if (typeof entry.hasCredential !== "boolean" || typeof entry.disabled !== "boolean") return null;
    const authMode = entry.authMode;
    const normalizedAuthMode = typeof authMode === "string" && (HUB_STATE_AUTH_MODES as readonly string[]).includes(authMode)
      ? authMode as NonNullable<HubStateAuthMode>
      : null;
    // An unrecognized authMode is refused rather than nulled: nulling it would let a newer hub's
    // new mode read as "unset", which is a different claim about the provider.
    if (authMode !== null && authMode !== undefined && normalizedAuthMode === null) return null;
    providers.push({
      name,
      adapter,
      authMode: normalizedAuthMode,
      hasCredential: entry.hasCredential,
      disabled: entry.disabled,
    });
  }

  const oauth: HubStateOAuthEntry[] = [];
  for (const row of raw.oauth) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const entry = row as Record<string, unknown>;
    const provider = boundedString(entry.provider);
    if (!provider || typeof entry.loggedIn !== "boolean") return null;
    oauth.push({ provider, loggedIn: entry.loggedIn });
  }

  const subagentModels: string[] = [];
  for (const row of raw.subagentModels) {
    const model = boundedString(row);
    if (!model) return null;
    subagentModels.push(model);
  }

  return {
    schemaVersion: HUB_STATE_SCHEMA_VERSION,
    runtimeRole: "hub",
    hubVersion,
    origin,
    providers,
    oauth,
    subagentModels,
    truncated,
    claudeCode: { enabled },
  };
}
