/**
 * Google Antigravity sign-in can get the Google account disabled.
 *
 * Antigravity's OAuth login is issued for Google's own Antigravity app. Reaching Cloud Code
 * Assist through a third-party proxy with it is the pattern behind the account bans reported
 * against Gemini CLI (google-gemini/gemini-cli #19501, #20813, #27199, #27388), where the
 * account answers every request with {@link ANTIGRAVITY_TOS_BAN_MESSAGE}. The auto-pause policy
 * (`account-auto-pause-policy.ts`) recognises that message once it happens; this module is the
 * other half, making sure nobody reaches it without having been told first.
 *
 * Every way of adding an Antigravity account goes through the management API, except
 * `ocx login`, which runs the flow in-process. The API therefore refuses an Antigravity login
 * or import whose body does not carry {@link ANTIGRAVITY_RISK_ACK_FIELD} set to `true`, and each
 * client sets it only after a person acknowledged the warning: the dashboard through its
 * checkbox, the CLI through a y/N prompt or the explicit {@link ANTIGRAVITY_RISK_CLI_FLAG}.
 * The field is consent evidence from the client, the same weight a dashboard checkbox has; it
 * cannot prove a human read anything, and it is not meant to.
 */

export const ANTIGRAVITY_RISK_PROVIDER = "google-antigravity";

/** Request-body field that carries the acknowledgement. Only the literal `true` counts. */
export const ANTIGRAVITY_RISK_ACK_FIELD = "acknowledgeAntigravityRisk";

/** CLI flag for non-interactive use. Without it, a CLI that cannot prompt refuses. */
export const ANTIGRAVITY_RISK_CLI_FLAG = "--accept-antigravity-risk";

/** Machine-readable refusal returned by the management API and printed by the CLI. */
export const ANTIGRAVITY_RISK_REFUSAL_CODE = "antigravity_risk_not_acknowledged";

/** The error Cloud Code Assist returns for a disabled account (see account-auto-pause-policy.ts). */
export const ANTIGRAVITY_TOS_BAN_MESSAGE = "This service has been disabled in this account for violation of Terms of Service.";

export function requiresAntigravityRiskAcknowledgement(provider: string): boolean {
  return provider.trim().toLowerCase() === ANTIGRAVITY_RISK_PROVIDER;
}

export function hasAntigravityRiskAcknowledgement(body: unknown): boolean {
  return typeof body === "object" && body !== null
    && (body as Record<string, unknown>)[ANTIGRAVITY_RISK_ACK_FIELD] === true;
}

/** The API refusal body, shared by every route that can add an Antigravity account. */
export function antigravityRiskRefusalBody(): { error: string; code: typeof ANTIGRAVITY_RISK_REFUSAL_CODE } {
  return {
    error: "Google Antigravity sign-in can get the Google account disabled. Acknowledge the risk in the OpenCodex dashboard, or pass "
      + ANTIGRAVITY_RISK_CLI_FLAG + " to the CLI.",
    code: ANTIGRAVITY_RISK_REFUSAL_CODE,
  };
}

/** Terminal warning shown before every CLI Antigravity sign-in or import, flag or not. */
export const ANTIGRAVITY_RISK_WARNING = [
  "",
  "WARNING: Google Antigravity sign-in can get this Google account permanently disabled.",
  "  The Antigravity login is meant for Google's own Antigravity app. OpenCodex is a third-party",
  "  proxy, and users of third-party tools have reported their Google accounts being disabled with:",
  "    \"" + ANTIGRAVITY_TOS_BAN_MESSAGE + "\"",
  "  - The ban applies to the Google account: its Gemini Code Assist and Antigravity access can",
  "    stop everywhere, including in Google's own tools.",
  "  - Getting access back depends on Google's appeal process and is not guaranteed.",
  "  - Use only a separate Google account you can afford to lose. Never use your main, personal,",
  "    school, or work account.",
  "  Safer option: use a Gemini API key (Google AI Studio or Vertex AI) instead.",
  "",
].join("\n");

export const ANTIGRAVITY_RISK_PROMPT = "Continue with Google Antigravity and accept the risk? [y/N]: ";

export type AntigravityRiskDecision = "accepted" | "declined" | "noninteractive";

/**
 * The CLI gate. The warning is always shown, even with the flag, so a script's log records what
 * was accepted. Without the flag only an interactive terminal may answer, and only an explicit
 * "y" or "yes" accepts: an empty line, EOF, a timeout or a read error all decline.
 */
export async function resolveAntigravityRiskAcknowledgement(opts: {
  flag: boolean;
  interactive: boolean;
  warn: (text: string) => void;
  ask: (question: string) => Promise<string>;
}): Promise<AntigravityRiskDecision> {
  opts.warn(ANTIGRAVITY_RISK_WARNING);
  if (opts.flag) return "accepted";
  if (!opts.interactive) return "noninteractive";
  let answer: string;
  try {
    answer = await opts.ask(ANTIGRAVITY_RISK_PROMPT);
  } catch {
    return "declined";
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes" ? "accepted" : "declined";
}

export function antigravityRiskDecisionMessage(decision: Exclude<AntigravityRiskDecision, "accepted">): string {
  return decision === "noninteractive"
    ? "Refusing Google Antigravity without acknowledgement (" + ANTIGRAVITY_RISK_REFUSAL_CODE + "): no interactive terminal to confirm. "
      + "Re-run in a terminal, or pass " + ANTIGRAVITY_RISK_CLI_FLAG + " to accept the risk explicitly."
    : "Google Antigravity cancelled: the risk was not accepted. Nothing was changed.";
}
