/**
 * Anthropic usage-limit reset grants (upstream program `cedar_ember`).
 *
 * Claude Pro/Max/Team subscriptions can carry a one-time grant that clears the
 * 5-hour and weekly usage windows. The contract here mirrors the Claude Code CLI
 * (2.1.278) byte for byte where it matters:
 *
 * - read:   GET  /api/oauth/usage?cedar_ember=1&skip_spend=1  (block `cedar_ember`)
 * - org:    GET  /api/oauth/profile                           (`organization.uuid`)
 * - redeem: POST /api/organizations/{org}/reset_rate_limits
 *           body {program:"cedar_ember", grant_id, request_id}
 *
 * Parsing is fail-closed: a malformed block is an error, never "zero grants",
 * because the dashboard spends from what this module returns. Nothing here logs,
 * and no upstream body, token, or organization id leaves through an error message.
 */
import { CLAUDE_CLI_USER_AGENT } from "./claude-cli-identity";

export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
export const ANTHROPIC_RESET_GRANT_PROGRAM = "cedar_ember";
export const ANTHROPIC_RESET_GRANT_STATUS_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
export const ANTHROPIC_PROFILE_PATH = "/api/oauth/profile";
/** Same bound the Claude Code client uses for the claim. */
export const ANTHROPIC_RESET_GRANT_REDEEM_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 12_000;

export const ANTHROPIC_RESET_GRANT_ID_RE = /^[a-z0-9_-]{1,40}$/;
export const ANTHROPIC_RESET_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ORGANIZATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Usage windows a grant can clear. Others upstream may add are dropped. */
export const ANTHROPIC_RESET_WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included"] as const;
export type AnthropicResetWindow = typeof ANTHROPIC_RESET_WINDOWS[number];

/** Terminal answers the claim endpoint can give. */
export const ANTHROPIC_RESET_RESULTS = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"] as const;
export type AnthropicResetUpstreamResult = typeof ANTHROPIC_RESET_RESULTS[number];
/** Upstream results plus the two HTTP refusals that prove nothing was spent. */
export type AnthropicResetSettledCode = AnthropicResetUpstreamResult | "rate_limited" | "auth_error";

export interface AnthropicResetGrant {
  id: string;
  label: string;
  resetsTotal: number;
  resetsLeft: number;
  startsAt: string | null;
  endsAt: string | null;
  clears: AnthropicResetWindow[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  percentUsed: Partial<Record<AnthropicResetWindow, number>>;
}

export interface AnthropicResetGrantStatus {
  eligible: boolean;
  ineligibleReason: string | null;
  atLimit: boolean;
  grants: AnthropicResetGrant[];
  nextGrantId: string | null;
  weeklyResetsAt: string | null;
  cooldownUntil: string | null;
}

export type AnthropicResetGrantErrorCode = "auth" | "upstream" | "malformed";

/** A read failure. `message` is fixed text; upstream detail is never attached. */
export class AnthropicResetGrantError extends Error {
  constructor(readonly code: AnthropicResetGrantErrorCode) {
    super(`Anthropic reset-grant read failed (${code})`);
    this.name = "AnthropicResetGrantError";
  }
}

/** The claim was sent (or may have been) and no terminal answer came back. */
export class AnthropicResetGrantUnknownOutcome extends Error {
  constructor() {
    super("Anthropic reset-grant claim outcome is unknown");
    this.name = "AnthropicResetGrantUnknownOutcome";
  }
}

const KNOWN_INELIGIBLE_REASONS = new Set([
  "config_off", "tier", "seat", "mobile", "surface", "cli_version", "no_grant",
  "tenure", "other_experiment", "unavailable", "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Optional ISO timestamp: absent/null → null, anything unparsable rejects the block. */
function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === "boolean" ? value : undefined;
}

/** Upstream display text, stripped of control characters and bounded. */
function safeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function parseWindows(value: unknown): AnthropicResetWindow[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return ANTHROPIC_RESET_WINDOWS.filter(window => value.includes(window));
}

function parsePercentUsed(value: unknown): Partial<Record<AnthropicResetWindow, number>> {
  const out: Partial<Record<AnthropicResetWindow, number>> = {};
  if (!isRecord(value)) return out;
  for (const window of ANTHROPIC_RESET_WINDOWS) {
    const percent = value[window];
    if (typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100) out[window] = percent;
  }
  return out;
}

function parseGrant(value: unknown): AnthropicResetGrant | null {
  if (!isRecord(value)) return null;
  const { id, resets_total: total, resets_left: left } = value;
  if (typeof id !== "string" || !ANTHROPIC_RESET_GRANT_ID_RE.test(id)) return null;
  if (!isCount(total) || !isCount(left) || left > total) return null;
  const startsAt = optionalTimestamp(value.starts_at);
  const endsAt = optionalTimestamp(value.ends_at);
  const clears = parseWindows(value.clears);
  const paused = optionalBoolean(value.paused, false);
  // Missing usability flags default to the refusing side: a grant that does not
  // say it is usable is not offered for spending.
  const usableNow = optionalBoolean(value.usable_now, false);
  const useRequiresLimit = optionalBoolean(value.use_requires_limit, true);
  if (startsAt === undefined || endsAt === undefined || clears === undefined
    || paused === undefined || usableNow === undefined || useRequiresLimit === undefined) return null;
  return {
    id,
    label: safeLabel(value.label),
    resetsTotal: total,
    resetsLeft: left,
    startsAt,
    endsAt,
    clears,
    paused,
    usableNow,
    useRequiresLimit,
    percentUsed: parsePercentUsed(value.percent_used),
  };
}

/**
 * Parses the `cedar_ember` block. Returns null for a missing or malformed block;
 * one malformed grant, a duplicate id, or a bad timestamp rejects the whole block.
 */
export function parseAnthropicResetGrantStatus(block: unknown): AnthropicResetGrantStatus | null {
  if (!isRecord(block) || typeof block.eligible !== "boolean") return null;
  const rawGrants = block.grants ?? [];
  if (!Array.isArray(rawGrants)) return null;
  const grants: AnthropicResetGrant[] = [];
  const seen = new Set<string>();
  for (const raw of rawGrants) {
    const grant = parseGrant(raw);
    if (!grant || seen.has(grant.id)) return null;
    seen.add(grant.id);
    grants.push(grant);
  }
  const reason = block.ineligible_reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") return null;
  const atLimit = optionalBoolean(block.at_limit, false);
  const weeklyResetsAt = optionalTimestamp(block.weekly_resets_at);
  const cooldownUntil = optionalTimestamp(block.cooldown_until);
  if (atLimit === undefined || weeklyResetsAt === undefined || cooldownUntil === undefined) return null;
  const next = block.next_grant_id;
  return {
    eligible: block.eligible,
    ineligibleReason: typeof reason === "string" ? (KNOWN_INELIGIBLE_REASONS.has(reason) ? reason : "unknown") : null,
    atLimit,
    grants,
    nextGrantId: typeof next === "string" && seen.has(next) ? next : null,
    weeklyResetsAt,
    cooldownUntil,
  };
}

/** Why a grant cannot be spent right now, or null when it can. */
export function anthropicResetGrantBlocker(
  status: AnthropicResetGrantStatus,
  grantId: string,
): "ineligible" | "unknown_grant" | "paused" | "not_usable" | "exhausted" | "not_limited" | null {
  if (!status.eligible) return "ineligible";
  const grant = status.grants.find(candidate => candidate.id === grantId);
  if (!grant) return "unknown_grant";
  if (grant.paused) return "paused";
  if (!grant.usableNow) return "not_usable";
  if (grant.resetsLeft <= 0) return "exhausted";
  if (grant.useRequiresLimit && !status.atLimit) return "not_limited";
  return null;
}

export interface AnthropicAccountRequestOptions {
  accessToken: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
  origin?: string;
}

function accountHeaders(accessToken: string, json: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    "User-Agent": CLAUDE_CLI_USER_AGENT,
    "anthropic-beta": "oauth-2025-04-20",
    Authorization: `Bearer ${accessToken}`,
  };
}

function readSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getAccountJson(path: string, options: AnthropicAccountRequestOptions): Promise<unknown> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.origin ?? ANTHROPIC_API_ORIGIN}${path}`, {
      method: "GET",
      headers: accountHeaders(options.accessToken, false),
      signal: readSignal(options.signal, READ_TIMEOUT_MS),
    });
  } catch {
    throw new AnthropicResetGrantError("upstream");
  }
  if (response.status === 401 || response.status === 403) throw new AnthropicResetGrantError("auth");
  if (!response.ok) throw new AnthropicResetGrantError("upstream");
  try {
    return await response.json();
  } catch {
    throw new AnthropicResetGrantError("malformed");
  }
}

/** Reads the reset-grant block for the account that owns `accessToken`. */
export async function fetchAnthropicResetGrantStatus(options: AnthropicAccountRequestOptions): Promise<AnthropicResetGrantStatus> {
  const body = await getAccountJson(ANTHROPIC_RESET_GRANT_STATUS_PATH, options);
  const status = isRecord(body) ? parseAnthropicResetGrantStatus(body.cedar_ember) : null;
  if (!status) throw new AnthropicResetGrantError("malformed");
  return status;
}

/** The organization the claim is filed against, from the token's own profile. */
export async function fetchAnthropicOrganizationUuid(options: AnthropicAccountRequestOptions): Promise<string> {
  const body = await getAccountJson(ANTHROPIC_PROFILE_PATH, options);
  const organization = isRecord(body) ? body.organization : undefined;
  const uuid = isRecord(organization) ? organization.uuid : undefined;
  if (typeof uuid !== "string" || !ORGANIZATION_UUID_RE.test(uuid)) throw new AnthropicResetGrantError("malformed");
  return uuid.toLowerCase();
}

export interface AnthropicResetClaimOptions extends AnthropicAccountRequestOptions {
  organizationUuid: string;
  grantId: string;
  requestId: string;
}

export interface AnthropicResetClaimAnswer {
  code: AnthropicResetSettledCode;
  resetsLeft: number | null;
  cleared: AnthropicResetWindow[];
}

/**
 * Files one claim. Resolves only with a terminal answer; throws
 * {@link AnthropicResetGrantUnknownOutcome} whenever the claim may have run
 * upstream without an answer we can read (transport error, timeout, 5xx,
 * unreadable body). Validation failures throw before anything is sent.
 */
export async function claimAnthropicResetGrant(options: AnthropicResetClaimOptions): Promise<AnthropicResetClaimAnswer> {
  if (!ORGANIZATION_UUID_RE.test(options.organizationUuid)
    || !ANTHROPIC_RESET_GRANT_ID_RE.test(options.grantId)
    || !ANTHROPIC_RESET_REQUEST_ID_RE.test(options.requestId)) {
    throw new AnthropicResetGrantError("malformed");
  }
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const url = `${options.origin ?? ANTHROPIC_API_ORIGIN}/api/organizations/${encodeURIComponent(options.organizationUuid)}/reset_rate_limits`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: accountHeaders(options.accessToken, true),
      body: JSON.stringify({
        program: ANTHROPIC_RESET_GRANT_PROGRAM,
        grant_id: options.grantId,
        request_id: options.requestId,
      }),
      signal: readSignal(options.signal, ANTHROPIC_RESET_GRANT_REDEEM_TIMEOUT_MS),
    });
  } catch {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  // Refusals that prove the claim did not run, exactly as the Claude Code client maps them.
  if (response.status === 429) return { code: "rate_limited", resetsLeft: null, cleared: [] };
  if (response.status === 401 || response.status === 403) return { code: "auth_error", resetsLeft: null, cleared: [] };
  if (!response.ok) throw new AnthropicResetGrantUnknownOutcome();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  if (!isRecord(body) || typeof body.result !== "string"
    || !(ANTHROPIC_RESET_RESULTS as readonly string[]).includes(body.result)) {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  return {
    code: body.result as AnthropicResetUpstreamResult,
    resetsLeft: isCount(body.resets_left) ? body.resets_left : null,
    cleared: parseWindows(body.cleared) ?? [],
  };
}
