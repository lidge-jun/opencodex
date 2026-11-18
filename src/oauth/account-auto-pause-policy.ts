import type { AccountPauseReason } from "../types/account-auto-pause";
import { readBoundedResponseBody } from "../lib/bounded-body";

/** Only whole, account-scoped messages are authority; model/resource policy errors are not. */
export function classifyPermanentAccountRefusal(status: number, payload: unknown): AccountPauseReason | undefined {
  if (status !== 401 && status !== 403 || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return;
  const { type: rawType, code, message, status: googleStatus } = error as Record<string, unknown>;
  const google = googleStatus === "PERMISSION_DENIED" || googleStatus === "UNAUTHENTICATED";
  const type = rawType ?? (googleStatus === "PERMISSION_DENIED" ? "permission_error" : googleStatus === "UNAUTHENTICATED" ? "authentication_error" : undefined);
  if (typeof message !== "string" || !["permission_error", "authentication_error", "invalid_request_error"].includes(String(type))) return;
  if (code != null && !(google && code === status) && !["permission_error", "permission_denied", "subscription_inactive", "subscription_expired", "subscription_required", "plan_downgraded"].includes(String(code))) return;
  const text = message.trim();
  if (/^OAuth authentication is (?:currently )?not allowed for this organi[sz]ation[.!]?$/i.test(text)) return "oauth_organization_disabled";
  if (/^(?:Your |The )?(?:Claude |ChatGPT )?subscription (?:has expired|is expired)[.!]?$/i.test(text)) return "subscription_expired";
  if (/^(?:(?:Your |The )?(?:Claude |ChatGPT )?subscription is inactive|Your account does not have an active subscription)[.!]?$/i.test(text)) return "subscription_inactive";
  if (/^Your (?:account|plan) (?:has been |was )?downgraded to (?:the )?free(?: plan)? (?:and |with )?(?:has )?(?:no|without) (?:remaining )?credits[.!]?$/i.test(text)) return "plan_downgraded";
  if (type === "permission_error" && /^Your account (?:does not have access to Claude Code|is (?:disabled|suspended)|is not permitted to use (?:the |this )?API)[.!]?$/i.test(text)) return "account_permission_denied";
  // Cloud Code Assist (Antigravity / Gemini CLI OAuth) account ban (#7803).
  if (isConclusiveAccountBan(status, payload)) return "account_permission_denied";
}

/**
 * A refusal the upstream itself marks permanent for the whole account: the Cloud Code Assist Terms
 * of Service ban. Google's backend has returned the sentence alone and with exactly two closing
 * sentences (google-gemini/gemini-cli #19501, #20813, #27199, #27388); only those whole messages,
 * on a consistent 403 / numeric 403 / PERMISSION_DENIED envelope, qualify. Project-scoped
 * CONSUMER_SUSPENDED, SERVICE_DISABLED and model-permission errors name a project or a model, not
 * the sending identity.
 */
export function isConclusiveAccountBan(status: number, payload: unknown): boolean {
  if (status !== 403 || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const { type, code, message, status: googleStatus } = error as Record<string, unknown>;
  // The same type gate classifyPermanentAccountRefusal applies before reaching this envelope.
  if (type !== undefined && !["permission_error", "authentication_error", "invalid_request_error"].includes(String(type))) return false;
  return code === 403 && googleStatus === "PERMISSION_DENIED" && typeof message === "string"
    && CCA_TOS_ACCOUNT_BAN.test(message.trim().replace(/\s+/g, " "));
}

const CCA_TOS_ACCOUNT_BAN = new RegExp("^This service has been disabled in this account for violation of Terms of Service\\."
  + "(?: If you believe this is an error, contact gemini-code-assist-user-feedback@google\\.com\\."
  + "| Please submit an appeal to continue using this product\\.)?$");

/** `conclusiveOnly` admits only {@link isConclusiveAccountBan}, the default for a row with no policy. */
export async function permanentAccountRefusal(response: Response, signal?: AbortSignal, conclusiveOnly = false): Promise<AccountPauseReason | undefined> {
  if (response.status !== 401 && response.status !== 403) return;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true,
      maxBytes: 16_384, totalTimeoutMs: 250, inactivityTimeoutMs: 250 });
    if (!body.displaySafe || body.truncated) return;
    const payload: unknown = JSON.parse(body.text);
    if (conclusiveOnly) return isConclusiveAccountBan(response.status, payload) ? "account_permission_denied" : undefined;
    return classifyPermanentAccountRefusal(response.status, payload);
  } catch { return; }
}

type Streak = { incarnation: string; count: number; tail: Promise<unknown>; paused: boolean };
/** Process-local streaks, serialized in response-arrival order, including asynchronous reads/writes. */
export class AccountRefusalStreaks {
  private readonly accounts = new Map<string, Streak>();
  observe(key: string, incarnation: string, threshold: number, verdict: Promise<AccountPauseReason | undefined>, success: boolean,
    current: () => boolean, pause: (reason: AccountPauseReason) => Promise<boolean>): Promise<boolean> {
    if (!current()) return Promise.resolve(false);
    let streak = this.accounts.get(key);
    if (!streak || streak.incarnation !== incarnation) {
      // Capacity refusal forgets no live streak and never pauses on incomplete evidence.
      if (!streak && this.accounts.size >= 2048) return Promise.resolve(false);
      streak = { incarnation, count: 0, tail: Promise.resolve(), paused: false };
      this.accounts.set(key, streak);
    }
    const owned = streak;
    const result = owned.tail.catch(() => undefined).then(async () => {
      const reason = await verdict;
      if (this.accounts.get(key) !== owned || owned.paused || !current()) return false;
      if (success) { owned.count = 0; return false; }
      if (!reason) return false;
      owned.count = Math.min(owned.count + 1, threshold);
      if (owned.count < threshold) return false;
      owned.paused = await pause(reason);
      return owned.paused;
    });
    owned.tail = result;
    return result;
  }
}
