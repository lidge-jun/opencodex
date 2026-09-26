/**
 * Send-unblock rewriting for the ChatGPT desktop intercept.
 *
 * The ChatGPT desktop app disables the conversation composer from two backend data shapes:
 *
 *  1. Conversation metadata (`POST /backend-api/conversation/init`, and the
 *     `conversation_detail_metadata` events of the `/backend-api/f/conversation` stream) carries
 *     `blocked_features` entries named `send` (or `tpp_send`) and `limits_progress` entries for
 *     `send` with `remaining <= 0`.
 *  2. The desktop usage snapshot (`/backend-api/wham/usage[/stream]`) carries
 *     `rate_limit.allowed: false` + `rate_limit.limit_reached: true` while the logged-in
 *     ChatGPT subscription quota is exhausted.
 *
 * Only the account's own usage quota is lifted -- data that is meaningless for turns whose
 * model calls opencodex routes to third-party providers. Scope is deliberately narrow:
 *
 *  - Only the endpoints above are rewritten (`rewriteSurfaceFor`); every other response passes
 *    through byte-identical, even when it happens to contain the same field names.
 *  - A send block is removed only when its `block_reason` says quota (or is absent, the shape
 *    of a plain usage limit). Eligibility blocks such as `work_subscription_required`, and any
 *    reason not recognised as quota, are preserved and reported, so the app keeps its real
 *    explanation and `ocx chatgpt status` can show why a composer stays locked.
 *  - Quota display stays honest: `banner_info` / `rate_limit_upsell`, `used_percent`,
 *    `reset_at` and window fields, `model_limits`, `model_usage` and every other key pass
 *    through untouched, so the app keeps showing the account's real usage.
 */

/** `blocked_features[].name` values the desktop composer treats as a send lock. */
const SEND_BLOCKED_FEATURE_NAMES = new Set(["send", "tpp_send"]);

/** `limits_progress[].feature_name` value for the composer's send gate. */
const SEND_LIMIT_FEATURE_NAME = "send";

/**
 * `block_reason` values that describe usage quota, e.g. `usage_limit`. Anything else --
 * subscription, policy, or a reason this code has never seen -- is left in place.
 */
const QUOTA_BLOCK_REASON = /limit|quota|exhaust/i;

/** Which part of the rewrite applies to a response. */
export type RewriteSurface = "conversation" | "usage";

const CONVERSATION_PATHS = ["/backend-api/conversation/init", "/backend-api/conversation", "/backend-api/f/conversation"];
const USAGE_PATHS = ["/backend-api/wham/usage", "/backend-api/wham/usage/stream"];

/**
 * The rewrite that applies to a request path, or null for everything else. Conversation paths
 * match exactly or as a prefix segment (`/backend-api/f/conversation/prepare`); the conversation
 * list (`/backend-api/conversations`) and the other usage endpoints (thread usage, plan history)
 * do not match.
 */
export function rewriteSurfaceFor(pathname: string): RewriteSurface | null {
  if (USAGE_PATHS.includes(pathname)) return "usage";
  if (CONVERSATION_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))) return "conversation";
  return null;
}

/** A send block the rewrite deliberately left in place. */
export interface PreservedSendBlock {
  name: string;
  reason: string;
}

export interface RewriteResult {
  value: unknown;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSendBlockedFeature(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && SEND_BLOCKED_FEATURE_NAMES.has(String(entry.name ?? ""));
}

/** Absent/empty reason is the plain usage-limit shape; otherwise the reason must say quota. */
function isQuotaBlockReason(reason: unknown): boolean {
  if (reason === undefined || reason === null || reason === "") return true;
  return typeof reason === "string" && QUOTA_BLOCK_REASON.test(reason);
}

function isExhaustedSendLimit(entry: unknown): boolean {
  if (!isRecord(entry) || entry.feature_name !== SEND_LIMIT_FEATURE_NAME) return false;
  const remaining = entry.remaining;
  return typeof remaining === "number" && remaining <= 0;
}

/**
 * Recursively strip quota send-lock entries from any `blocked_features` / `limits_progress`
 * arrays. Non-quota send blocks are kept and appended to `preserved`. Malformed entries are
 * kept: the rewrite owns removal of known-shaped blocks, not validation.
 */
export function stripSendBlocks(value: unknown, preserved: PreservedSendBlock[] = []): RewriteResult {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map(item => {
      const result = stripSendBlocks(item, preserved);
      changed ||= result.changed;
      return result.value;
    });
    return { value: items, changed };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "blocked_features" && Array.isArray(child)) {
      const kept = child.filter(entry => {
        if (!isSendBlockedFeature(entry)) return true;
        if (isQuotaBlockReason(entry.block_reason)) return false;
        preserved.push({ name: String(entry.name), reason: String(entry.block_reason) });
        return true;
      });
      changed ||= kept.length !== child.length;
      out[key] = kept;
      continue;
    }
    if (key === "limits_progress" && Array.isArray(child)) {
      const kept = child.filter(entry => !isExhaustedSendLimit(entry));
      changed ||= kept.length !== child.length;
      out[key] = kept;
      continue;
    }
    const result = stripSendBlocks(child, preserved);
    changed ||= result.changed;
    out[key] = result.value;
  }
  return { value: out, changed };
}

/**
 * Flip the desktop usage snapshot's send gate in place: `rate_limit.allowed` false -> true and
 * `rate_limit.limit_reached` true -> false, at any depth (top-level for the snapshot endpoint,
 * under `usage` for stream events). Callers apply this to the usage endpoints only. Window
 * percentages, reset timestamps, the upsell banner and every other display field are left
 * exactly as the backend sent them.
 *
 * Returns whether anything changed.
 */
export function unlockRateLimitGate(value: unknown): boolean {
  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const rateLimit = node.rate_limit;
    if (isRecord(rateLimit)) {
      if (rateLimit.allowed === false) {
        rateLimit.allowed = true;
        changed = true;
      }
      if (rateLimit.limit_reached === true) {
        rateLimit.limit_reached = false;
        changed = true;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return changed;
}

/**
 * Rewrite a JSON response body for `surface` (both parts when omitted). Returns `null` when the
 * body is not valid JSON or contains nothing to rewrite, so callers can pass the original bytes
 * through untouched. Non-quota send blocks left in place are appended to `preserved`.
 */
export function stripSendBlocksFromJson(
  text: string,
  surface?: RewriteSurface,
  preserved: PreservedSendBlock[] = [],
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let value = parsed;
  let changed = false;
  if (surface !== "usage") {
    const stripped = stripSendBlocks(value, preserved);
    value = stripped.value;
    changed ||= stripped.changed;
  }
  if (surface !== "conversation") changed = unlockRateLimitGate(value) || changed;
  return changed ? JSON.stringify(value) : null;
}

/**
 * Rewrite a single SSE line. ChatGPT conversation and usage-stream events carry one JSON
 * document per `data:` line; lines that parse to a payload with send blocks or a closed usage
 * gate are replaced, everything else passes through byte-identical. A CRLF-framed line keeps
 * its `\r`. Returns `null` when the line is unchanged.
 */
export function stripSendBlocksFromSseLine(
  line: string,
  surface?: RewriteSurface,
  preserved: PreservedSendBlock[] = [],
): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  // `s`: a JSON string may legally hold U+2028/U+2029, which `.` would otherwise refuse.
  const match = /^(data: ?)(.*)$/s.exec(body);
  if (!match) return null;
  const rewritten = stripSendBlocksFromJson(match[2]!, surface, preserved);
  if (rewritten === null) return null;
  return `${match[1]}${rewritten}${cr}`;
}
