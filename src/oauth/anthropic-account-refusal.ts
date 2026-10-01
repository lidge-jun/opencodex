/** Narrow pre-output account recovery, fenced to the bearer that physically sent the turn. */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { isNonReplayableResponse } from "../lib/upstream-retry";
import { credentialGeneration, getAccountCredentialWithStatus } from "./store";
import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import type { AnthropicRouteDecision } from "./anthropic-model-routes";
import { recordAnthropicAccountRefusal, rotateAnthropicAccountOnRefusal } from "./anthropic-routing";

const responseCredentials = new WeakMap<Response, Pick<OAuthAccessSnapshot, "accountId" | "generation">>();
const verdicts = new WeakMap<Response, Promise<boolean>>();

/** Called only when the outgoing headers prove ownership of the selected stored bearer. */
export function bindAnthropicRefusalCredential(response: Response, snapshot: OAuthAccessSnapshot): void {
  responseCredentials.set(response, { accountId: snapshot.accountId, generation: snapshot.generation });
}

async function isAccountRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || body.truncated) return false;
    const payload: unknown = JSON.parse(body.text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("error" in payload)) return false;
    const error = payload.error;
    if (!error || typeof error !== "object" || Array.isArray(error) || !("type" in error) || !("message" in error)
      || typeof error.message !== "string") return false;
    // Whole-message patterns: request-policy/model/resource refusals and quoted diagnostics
    // must not acquire account authority merely by containing entitlement keywords.
    if ("code" in error && error.code != null
      && (typeof error.code !== "string" || !["subscription_required", "insufficient_quota", "permission_denied"].includes(error.code))) return false;
    const message = error.message.trim();
    if (error.type === "permission_error" && /^(?:Your account does not have access to Claude Code|Your (?:Claude )?subscription (?:has expired|is (?:expired|inactive))|Your account does not have an active subscription)[.!]?$/i.test(message)) return true;
    return (error.type === "billing_error" || error.type === "permission_error")
      && /^Your credit balance is too low to access the Anthropic API\.(?: Please go to Plans & Billing to upgrade or purchase credits\.)?$/i.test(message);
  } catch {
    // Malformed, over-limit, interrupted and unreadable error bodies are never authority.
    return false;
  }
}

export async function rotateAnthropicAccountOnResponse(
  response: Response,
  options: {
    config: OcxConfig;
    accountId: string;
    sessionKey?: string | null;
    decision?: AnthropicRouteDecision | null;
    signal?: AbortSignal;
    canRetry: boolean;
    allowAccountRefusal?: boolean;
  },
): Promise<string | null> {
  if (options.signal?.aborted || isNonReplayableResponse(response)) return null;
  if (response.status !== 429) {
    if (response.status !== 403 || options.allowAccountRefusal === false) return null;
    const sent = responseCredentials.get(response);
    if (!sent || sent.accountId !== options.accountId) return null;
    let verdict = verdicts.get(response);
    if (!verdict) {
      verdict = isAccountRefusal(response, options.signal);
      verdicts.set(response, verdict);
    }
    if (!await verdict || options.signal?.aborted) return null;
    // A late refusal must not cool a new credential stored while its body was being read.
    const current = getAccountCredentialWithStatus("anthropic", sent.accountId);
    if (!current || current.paused || current.needsReauth || credentialGeneration(current.credential) !== sent.generation) return null;
  }
  const status = response.status === 429 ? 429 : 403;
  if (!options.canRetry) {
    recordAnthropicAccountRefusal(options.config, options.accountId, status,
      response.headers.get("retry-after"), Date.now(), response.headers);
    return null;
  }
  return rotateAnthropicAccountOnRefusal(options.config, options.accountId, status,
    response.headers.get("retry-after"), options.sessionKey, Date.now(), response.headers, options.decision);
}
