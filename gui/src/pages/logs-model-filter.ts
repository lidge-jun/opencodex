/**
 * Free-text matching over a log row's model and provider, kept out of Logs.tsx so that
 * module exports components only (react-refresh/only-export-components).
 *
 * #3070: an operator running custom providers saw their OpenAI monthly window shrink
 * and could not find which turns were responsible. `?model=` filtering exists on the
 * CLI and the API (b68edc077) but never reached the dashboard, and the one filter the
 * page did have — the intercepted-helpers toggle — keys on `shadowCallRewrittenFrom`,
 * which a plain account-gated turn does not carry. So the rows that explain the bill
 * were exactly the rows no control could isolate.
 */
export interface LogModelFields {
  model?: string;
  resolvedModel?: string;
  provider?: string;
  attempts?: Array<{
    provider?: string;
    model?: string;
  }>;
}

/**
 * Case-insensitive substring over the requested model, resolved target, provider, and
 * every failover attempt target.
 *
 * `resolvedModel` is matched as well as `model` on purpose. They differ precisely when
 * routing redirected the turn, which is the case this filter exists to expose — matching
 * only the requested id would hide the redirect that caused the charge.
 *
 * Substring rather than exact: an operator types `terra`, not
 * `gpt-5.6-terra-2026-08-01`. Empty or whitespace-only query matches everything, so the
 * control is inert until it is used.
 */
export function logMatchesModelQuery(log: LogModelFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const attemptTargets = Array.isArray(log.attempts)
    ? log.attempts.flatMap(attempt => (
      attempt && typeof attempt === "object" ? [attempt.provider, attempt.model] : []
    ))
    : [];
  return [log.model, log.resolvedModel, log.provider, ...attemptTargets].some(
    value => typeof value === "string" && value.toLowerCase().includes(needle),
  );
}
