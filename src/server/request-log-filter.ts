/**
 * `/api/logs` query filters over the in-memory request log. Split out of `request-log.ts`
 * (which sits at its file-size threshold) so query clauses can grow here.
 */
import type { RequestLogEntry } from "./request-log";
import { matchesLogConversationId } from "./request-log-conversation";
import { isDeliveryMode } from "../protocols/contract";

/** Capacity of the in-memory request log ring; also the upper bound of `tail` and `limit`. */
export const MAX_LOG_SIZE = 2000;

/** `protocolMode=none` selects rows with no observed protocol trace. */
export const REQUEST_LOG_PROTOCOL_MODE_NONE = "none";

/**
 * Whether a row matches a `protocolMode` query value: the final trace mode, or `none` for a row
 * without a trace. An unrecognised value matches nothing rather than being ignored, for the
 * reason #2704 gives for `model`.
 */
export function matchesProtocolMode(entry: Pick<RequestLogEntry, "protocolTrace">, mode: string): boolean {
  if (mode === REQUEST_LOG_PROTOCOL_MODE_NONE) return entry.protocolTrace === undefined;
  return isDeliveryMode(mode) && entry.protocolTrace?.mode === mode;
}

export function filterRequestLogs(logs: RequestLogEntry[], params: URLSearchParams): RequestLogEntry[] {
  let filtered = logs;
  const provider = params.get("provider")?.trim();
  if (provider) {
    filtered = filtered.filter(entry => entry.provider === provider
      || entry.attempts?.some(attempt => attempt.provider === provider));
  }
  const conversationId = params.get("conversationId")?.trim() || params.get("conversation")?.trim();
  if (conversationId) {
    filtered = filtered.filter(entry => matchesLogConversationId(entry.conversationId, conversationId));
  }
  // #2704: there was no `model` clause at all, so `?model=x` was ACCEPTED and silently
  // ignored -- worse than an error, because it yields wrong conclusions from output that
  // looks correct. Attempts are matched for the same reason `provider` matches them: a
  // request that failed over should be findable by the model that actually served it.
  const model = params.get("model")?.trim();
  if (model) {
    filtered = filtered.filter(entry => entry.model === model
      || entry.attempts?.some(attempt => attempt.model === model));
  }
  // #4057: "which account served this request" is the first question asked when one provider
  // holds several accounts, and until now the only way to answer it was to grep usage.jsonl by
  // hand. Attempts are matched for the same reason `provider` and `model` match them: when a
  // request failed over between pool accounts, a search for the account that finally served it
  // has to find that request, not only the account that first refused it.
  const account = params.get("account")?.trim();
  if (account) {
    filtered = filtered.filter(entry => entry.accountLogLabel === account
      || entry.attempts?.some(attempt => attempt.accountLogLabel === account));
  }
  const protocolMode = params.get("protocolMode")?.trim().toLowerCase();
  if (protocolMode) filtered = filtered.filter(entry => matchesProtocolMode(entry, protocolMode));
  const status = params.get("status")?.trim().toLowerCase();
  if (status) {
    filtered = /^[1-5]xx$/.test(status)
      ? filtered.filter(entry => Math.floor(entry.status / 100) === Number(status[0]))
      : filtered.filter(entry => String(entry.status) === status);
  }
  const tailRaw = params.get("tail")?.trim();
  if (tailRaw) {
    const tail = Number.parseInt(tailRaw, 10);
    if (Number.isFinite(tail) && tail > 0) filtered = filtered.slice(-Math.min(tail, MAX_LOG_SIZE));
  }
  const offsetRaw = params.get("offset")?.trim();
  const limitRaw = params.get("limit")?.trim();
  if (limitRaw) {
    const limit = Number.parseInt(limitRaw, 10);
    const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
    if (Number.isFinite(limit) && limit > 0) {
      const capped = Math.min(limit, MAX_LOG_SIZE);
      const startOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
      const end = filtered.length - startOffset;
      if (end <= 0) filtered = [];
      else {
        const begin = Math.max(0, end - capped);
        filtered = filtered.slice(begin, end);
      }
    }
  }
  return filtered;
}

export function filteredRequestLogCount(logs: RequestLogEntry[], params: URLSearchParams): number {
  const withoutPagination = new URLSearchParams(params);
  withoutPagination.delete("limit");
  withoutPagination.delete("offset");
  return filterRequestLogs(logs, withoutPagination).length;
}
