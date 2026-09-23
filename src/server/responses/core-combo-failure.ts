import { parseRetryAfterMs } from "../../combos";
import type { ConsumedComboFailure, HandleResponsesOptions } from "./core-options";
import type { OcxUsage } from "../../types";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { codexQuotaFailureMessage, codexQuotaOutcomeMeta } from "./core-codex-account";
import {
  isRateLimitOrQuotaFailureMessage,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  CYBER_POLICY_ERROR_CODE,
  CYBER_POLICY_FALLBACK_MESSAGE,
} from "../../lib/errors";
import { normalizeUpstreamErrorText } from "./core-errors";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { formatErrorResponse } from "../../bridge";
import { isNonReplayableResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
import { usageFromResponsesPayload } from "../request-log";
import type { ResponsesTerminalStatus } from "../../bridge";

export function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}




export async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ConsumedComboFailure> {
  // Read before the body: the marker lives on this Response object, and the failure below is
  // rebuilt as a new one that would otherwise lose it.
  const nonReplayable = isNonReplayableResponse(response);
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  let usage: OcxUsage | undefined;
  let upstreamCode: string | undefined;
  let upstreamMessage: string | undefined;
  let upstreamType: string | undefined;
  // Whether the body itself confirms a quota/rate-limit refusal, computed on the SAME read as
  // the classification below. `shouldRetryCodexPoolAccountQuota` cannot be called here without
  // a second body read, so this mirrors its normalization: raw 402/429, or a 5xx whose intact,
  // display-safe body carries a recognized quota message.
  let quotaConfirmedByBody = false;
  const serverError = response.status >= 500 && response.status < 600;
  try {
    const body = await readBoundedResponseBody(response, { signal, reportUtf8Validity: serverError });
    // A 5xx body counts as quota or classification evidence only when it decoded as valid
    // UTF-8, matching shouldRetryCodexPoolAccountQuota. A malformed byte keeps the status-only
    // fallback, with one exception: a cyber-policy refusal must still stop the combo, so the
    // replacement-decoded text may carry that verdict and nothing else.
    const utf8Trusted = !serverError || body.utf8Valid === true;
    if (utf8Trusted) usage = usageFromComboFailureText(body.text);
    if (serverError && utf8Trusted && body.displaySafe && !body.truncated) {
      const quotaMessage = codexQuotaFailureMessage(body.text);
      quotaConfirmedByBody = quotaMessage !== undefined
        && isRateLimitOrQuotaFailureMessage(quotaMessage);
    }
    if (body.displaySafe && !body.truncated) {
      const normalized = normalizeUpstreamErrorText(body.text, fallback);
      if (utf8Trusted || isCyberPolicyCode(normalized.code) || isCyberPolicyMessage(normalized.safeText)) {
        classificationText = normalized.safeText;
        upstreamCode = normalized.code;
        upstreamMessage = normalized.message;
        upstreamType = normalized.type;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const cyberFailure = isCyberPolicyCode(upstreamCode) || isCyberPolicyMessage(classificationText);
  const normalizedUpstreamCode = cyberFailure ? CYBER_POLICY_ERROR_CODE : upstreamCode;
  const message = cyberFailure
    ? upstreamMessage
      ?? (isCyberPolicyCode(upstreamCode) ? CYBER_POLICY_FALLBACK_MESSAGE : classificationText)
    : classificationText === fallback
      ? fallback
      : `${fallback}: ${classificationText}`;
  const upstreamRetryAfter = response.headers.get("retry-after");
  // Past HTTP dates are an immediate retry directive, just like the numeric value zero.
  // Normalize before the client helper discards them and substitutes a default delay.
  const effectiveRetryAfter = parseRetryAfterMs(upstreamRetryAfter, now) === undefined
    && parseRetryAfterMs(upstreamRetryAfter, now, { preserveImmediate: true }) !== undefined
    ? "0"
    : upstreamRetryAfter;
  // Client response may get the synthetic "2" fallback; cooldown metadata must not —
  // otherwise coolComboTarget treats it as a 2s cooldown instead of the 60s default.
  const clientRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter: effectiveRetryAfter,
    now,
  });
  const cooldownRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter: effectiveRetryAfter,
    now,
    includeDefault: false,
  });
  const failureResponse = formatErrorResponse(
    response.status,
    cyberFailure ? (upstreamType ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
    message,
    {
      ...(normalizedUpstreamCode !== undefined ? { code: normalizedUpstreamCode } : {}),
      ...(clientRetryAfter !== undefined ? { retryAfter: clientRetryAfter } : {}),
    },
  );
  if (nonReplayable) markResponseNonReplayable(failureResponse);
  return {
    response: failureResponse,
    ...(nonReplayable ? { nonReplayable: true } : {}),
    classificationText,
    ...(normalizedUpstreamCode !== undefined ? { upstreamCode: normalizedUpstreamCode } : {}),
    ...(!cyberFailure && cooldownRetryAfter !== undefined ? { retryAfter: cooldownRetryAfter } : {}),
    // The EFFECTIVE classification decides, not the raw status. An upstream that wraps a quota
    // refusal in a 5xx still carries `x-codex-*-reset-at`, and gating on 402/429 alone threw
    // those away, so the combo target came back up immediately instead of waiting for the
    // window it was told about. `cyberFailure` stays excluded: a policy block is not a quota.
    ...(!cyberFailure
      && (response.status === 429 || response.status === 402 || quotaConfirmedByBody)
      ? { resetAt: codexQuotaOutcomeMeta(response).resetAt }
      : {}),
    ...(usage ? { usage } : {}),
  };
}




export function usageFromComboFailureText(text: string): OcxUsage | undefined {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.response;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : payload;
    return usageFromResponsesPayload(source.usage);
  } catch {
    return undefined;
  }
}




export function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  let pendingModel: string | undefined;
  let completionAccepted = false;
  let completionRejected = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const publishCompletion = (): void => {
    if (state !== "committed" || completionRejected || pendingModel === undefined) return;
    const model = pendingModel;
    pendingModel = undefined;
    options.onResponseComplete?.(model);
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (value.kind === "cancel" || value.status !== "completed") {
      completionRejected = true;
      pendingModel = undefined;
    }
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    onResponseComplete: (model: string) => {
      if (state === "discarded" || completionRejected || completionAccepted || !model.trim()) return;
      completionAccepted = true;
      pendingModel = model;
      publishCompletion();
    },
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
      publishCompletion();
    },
    discard: () => {
      state = "discarded";
      pending = undefined;
      pendingModel = undefined;
    },
  };
}



export function buildComboChildHeaders(parentHeaders: HeadersInit): Headers {
  const childHeaders = new Headers(parentHeaders);
  // A provisional caller credential is not authoritative for a Combo child.
  childHeaders.delete("authorization");
  childHeaders.delete("chatgpt-account-id");
  // Combo children re-serialize already-decoded JSON. Keeping transport metadata from
  // the parent would make the child decoder treat plain JSON as compressed bytes.
  childHeaders.delete("content-length");
  childHeaders.delete("content-encoding");
  return childHeaders;
}
