import { KEY_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { OcxUsage } from "../types";
import { sealedCredentialRefusals } from "./request-log-attempt-recovery";
import { recordKeyWireAttemptUsage, usageFromResponsesPayload, type RequestLogContext } from "./request-log";

/** Preserve metered JSON failures before recovery consumes/cancels their body. */
export async function recordKeyAttemptFailure(logCtx: RequestLogContext, response: Response, signal?: AbortSignal,
  includeUnattributed = false): Promise<OcxUsage | undefined> {
  const attempt = logCtx.activeAttempt;
  const keyAttempt = attempt && !sealedCredentialRefusals.has(attempt) && KEY_ACCOUNT_LOG_LABEL_RE.test(attempt.accountLogLabel ?? "") ? attempt : undefined;
  if (!keyAttempt && !includeUnattributed) return;
  const ordinal = keyAttempt?.ordinal;
  if (keyAttempt) keyAttempt.status = response.status;
  const cancelOriginal = (): void => { try { void response.body?.cancel().catch(() => {}); } catch { /* closed */ } };
  signal?.addEventListener("abort", cancelOriginal, { once: true });
  try {
    if (signal?.aborted) { cancelOriginal(); return; }
    const body = await readBoundedResponseBody(response.clone(), { signal, totalTimeoutMs: 1000, inactivityTimeoutMs: 1000 });
    if (body.truncated || body.oversized) return;
    const value = JSON.parse(body.text);
    const usage = usageFromResponsesPayload(value?.usage ?? value?.response?.usage);
    if (usage && keyAttempt && logCtx.activeAttempt === keyAttempt && keyAttempt.ordinal === ordinal) recordKeyWireAttemptUsage(logCtx, usage);
    return usage;
  } catch { /* Absent/malformed usage remains unknown; recovery still owns the response. */ }
  finally { signal?.removeEventListener("abort", cancelOriginal); }
}
