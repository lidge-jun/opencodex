import type { RequestLogEntry } from "./request-log";

export interface RequestLogCursor {
  timestamp: number;
  requestId: string;
}

interface SerializedCursorV1 {
  v: 1;
  t: number;
  id: string;
}

export function encodeRequestLogCursor(
  entry: Pick<RequestLogEntry, "timestamp" | "requestId">,
): string {
  const payload: SerializedCursorV1 = {
    v: 1,
    t: entry.timestamp,
    id: entry.requestId,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeRequestLogCursor(raw: string): RequestLogCursor | null {
  if (typeof raw !== "string" || !raw || raw.length > 512) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (parsed.v !== 1) return null;
    if (typeof parsed.t !== "number" || !Number.isFinite(parsed.t) || parsed.t < 0) return null;
    if (typeof parsed.id !== "string" || parsed.id.length === 0 || parsed.id.length > 256) return null;
    return { timestamp: parsed.t, requestId: parsed.id };
  } catch {
    return null;
  }
}

export function sliceRequestLogsAfterCursor(
  logs: readonly RequestLogEntry[],
  cursor: RequestLogCursor,
): { entries: RequestLogEntry[]; reset: boolean } {
  if (logs.length === 0) return { entries: [], reset: true };
  // Search from the end towards the beginning since recent cursors are near the end
  let matchIndex = -1;
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry && entry.timestamp === cursor.timestamp && entry.requestId === cursor.requestId) {
      matchIndex = i;
      break;
    }
  }
  if (matchIndex === -1) {
    return { entries: [...logs], reset: true };
  }
  return { entries: logs.slice(matchIndex + 1), reset: false };
}
