import type { LabAutomationRunRecordV1, LabAutomationStateV1 } from "./types";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import { LabAutomationError } from "./types";

export interface LabAutomationRunsPage {
  items: LabAutomationRunRecordV1[];
  hasMore: boolean;
  nextCursor?: string;
}

export function listLabAutomationRuns(
  state: LabAutomationStateV1,
  limit = 50,
  cursor?: string,
): LabAutomationRunsPage {
  const capped = Math.min(Math.max(1, limit), LAB_AUTOMATION_HARD_MAX.maxPersistedRuns);
  const sorted = [...state.runs].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.runId < b.runId ? -1 : 1;
  });
  let start = 0;
  if (cursor) {
    const index = sorted.findIndex((row) => row.runId === cursor);
    if (index < 0) throw new LabAutomationError("invalid or expired run cursor", "invalid_cursor");
    start = index + 1;
  }
  const slice = sorted.slice(start, start + capped);
  const hasMore = start + capped < sorted.length;
  return {
    items: slice,
    hasMore,
    ...(hasMore && slice.length > 0 ? { nextCursor: slice[slice.length - 1]!.runId } : {}),
  };
}
