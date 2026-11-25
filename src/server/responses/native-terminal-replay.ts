import { ownedChatErrorPayload } from "../../lib/client-error-body";
import { httpStatusFromTerminalError } from "../../lib/errors";
import {
  applyReplayRefusalClientHeaders, isReplayRefusalCode, REPLAY_REFUSAL_MESSAGE, REPLAY_REFUSED_STATUS,
  type replayRefusalVerdict,
} from "../../lib/upstream-retry";
import { truncationReasonFor } from "../../responses/truncated-stop-reason";

export const NON_REPLAYABLE_COMPLETION_MESSAGE = "Upstream reported a non-replayable failed completion.";

function safeIncompleteDetails(value: unknown) {
  const reason = (value as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== "string") return;
  const safeReason = isReplayRefusalCode(reason) ? reason : truncationReasonFor(reason);
  return safeReason === undefined ? undefined : { reason: safeReason };
}

/** The same terminal verdict owns the frame and any HTTP metadata still open for editing. */
export function projectNativeTerminalReplayVeto(
  verdict: ReturnType<typeof replayRefusalVerdict>,
  mode: "streamed" | "buffered",
  upstream: { type?: unknown; code?: unknown } | undefined,
  reasons: { root?: unknown; response?: unknown },
  status: number,
  maskCode: (value: string) => string,
) {
  const { refusalCode, explicitVeto } = verdict;
  if (!refusalCode && !explicitVeto) return;
  const type = typeof upstream?.type === "string" ? upstream.type : undefined;
  const code = typeof upstream?.code === "string" ? upstream.code : undefined;
  const errorStatus = httpStatusFromTerminalError({ type, code });
  const safe = ownedChatErrorPayload({ status: errorStatus, type, code, evidence: { status: errorStatus, type, code } }).error;
  const error = refusalCode
    ? { type: "upstream_error", code: refusalCode, message: REPLAY_REFUSAL_MESSAGE }
    : { type: safe.type, code: code === undefined ? safe.code : maskCode(code), message: NON_REPLAYABLE_COMPLETION_MESSAGE };
  return {
    rootIncompleteDetails: safeIncompleteDetails(reasons.root),
    fields: { incomplete_details: safeIncompleteDetails(reasons.response ?? reasons.root), retryable: false as const, error, last_error: error },
    http: mode === "buffered"
      ? { status: refusalCode ? REPLAY_REFUSED_STATUS : status, coded: refusalCode !== undefined, applyHeaders: applyReplayRefusalClientHeaders }
      : undefined,
  };
}

export type NativeTerminalReplayHttpEdits = NonNullable<NonNullable<ReturnType<typeof projectNativeTerminalReplayVeto>>["http"]>;
