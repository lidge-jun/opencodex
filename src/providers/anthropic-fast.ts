/**
 * Anthropic fast mode (`speed: "fast"`): wire constants and refusal recognition.
 *
 * Fast mode is a separately entitled, separately rate-limited lane on the same Opus models
 * (https://platform.claude.com/docs/en/build-with-claude/fast-mode). The Messages API never
 * falls back on its own: an account without usage credits gets a 429, an organization that has
 * not enabled the feature gets a 400, and a model outside the lane gets a 400 naming the
 * `speed` parameter. Claude Code retries such a request at standard speed; the adapter
 * dispatch loop does the same, once per request.
 *
 * Recognition is deliberately narrow. A generic 429 or 529 on a fast request may be an ordinary
 * account rate limit and must keep flowing into the existing wait/rotation handling, so only an
 * error message that names fast mode or the speed parameter, or a fast-pool header reporting
 * zero remaining, counts. Live probe strings (2026-09-23,
 * devlog/_plan/260923_anthropic_fast_speed/020_probe-evidence.md):
 *   429 "Usage credits are required for fast mode."
 *   400 "Fast mode is not enabled for your organization. ..."
 *   400 "'<model>' does not support the `speed` parameter. ..."
 */

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";

const FAST_REFUSAL_MESSAGE = /\bfast mode\b|\bspeed\b\W{0,2} parameter/i;
const FAST_POOL_REMAINING_HEADER = /^anthropic-fast-(?:input|output)-tokens-remaining$/i;

function anthropicErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object") return undefined;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function fastPoolExhausted(headers: Headers): boolean {
  let exhausted = false;
  headers.forEach((value, name) => {
    if (FAST_POOL_REMAINING_HEADER.test(name) && value.trim() === "0") exhausted = true;
  });
  return exhausted;
}

/**
 * Whether a response to a request that actually sent `speed: "fast"` is a fast-lane refusal a
 * standard-speed resend can recover. Pure; the caller supplies a bounded body read.
 */
export function isAnthropicFastRefusal(
  status: number,
  headers: Headers,
  bodyText: string | undefined,
): boolean {
  if (status !== 400 && status !== 429) return false;
  if (status === 429 && fastPoolExhausted(headers)) return true;
  const message = bodyText === undefined ? undefined : anthropicErrorMessage(bodyText);
  return message !== undefined && FAST_REFUSAL_MESSAGE.test(message);
}

/**
 * Merge beta tokens into the single `anthropic-beta` header, case-insensitively. Header
 * overrides may spell the name in any case; two spellings in one plain object would reach the
 * wire as two headers (Headers comma-joins them), so every spelling collapses into one
 * lowercase key with deduplicated tokens in first-seen order.
 */
export function mergeAnthropicBetaHeader(
  headers: Record<string, string>,
  extraBetas: readonly string[] = [],
): void {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    for (const part of raw.split(",")) {
      const token = part.trim();
      if (!token || seen.has(token.toLowerCase())) continue;
      seen.add(token.toLowerCase());
      tokens.push(token);
    }
  };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "anthropic-beta") continue;
    add(headers[name] ?? "");
    delete headers[name];
  }
  for (const beta of extraBetas) add(beta);
  if (tokens.length > 0) headers["anthropic-beta"] = tokens.join(",");
}
