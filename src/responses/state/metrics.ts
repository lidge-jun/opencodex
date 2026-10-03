import type { StoredResponseState } from "../state";
import type { ResponseSpillWriteStatus, ResponseSpillWriteFailureCode, ResponseSpillWriteFailureOrigin } from "./spill-failure";

export interface ResponseStateMetrics {
  count: number;
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillWriteStatus: ResponseSpillWriteStatus;
  spillWriteConsecutiveFailures: number;
  spillLastWriteFailureCode: ResponseSpillWriteFailureCode | null;
  spillLastWriteFailureOrigin: ResponseSpillWriteFailureOrigin | null;
  spillAclRetryReturnedTimeouts: number;
  spillAclTimeoutMemoRefusals: number;
  spillLastWriteFailureAt: number | null;
  spillLastWriteSuccessAt: number | null;
  spillReadFailures: number;
  replayScopeMismatchDrops: number;
}

export function computeResponseStateMetrics(params: {
  states: Iterable<StoredResponseState>;
  stateCount: number;
  now: number;
  totalBytes: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillWriteConsecutiveFailures: number;
  spillLastFailureCode: ResponseSpillWriteFailureCode | null;
  spillLastFailureOrigin: ResponseSpillWriteFailureOrigin | null;
  spillLastSuccessAt: number | null;
  spillAclRetryReturnedTimeouts: number;
  spillAclTimeoutMemoRefusals: number;
  spillLastFailureAt: number | null;
  spillReadFailures: number;
  replayScopeMismatchDrops: number;
}): ResponseStateMetrics {
  let largestBytes = 0;
  let oldestCreatedAt = params.now;
  let residentCount = 0;
  let spillStubCount = 0;
  let tombstoneCount = 0;
  let spillPayloadBytes = 0;
  for (const state of params.states) {
    const bytes = state.sizeBytes;
    if (bytes > largestBytes) largestBytes = bytes;
    if (state.createdAt < oldestCreatedAt) oldestCreatedAt = state.createdAt;
    if (state.kind === "resident") {
      residentCount += 1;
    } else if (state.kind === "spill") {
      spillStubCount += 1;
      spillPayloadBytes += state.spill.payloadBytes;
    } else tombstoneCount += 1;
  }
  return {
    count: params.stateCount,
    residentCount,
    spillStubCount,
    tombstoneCount,
    totalBytes: params.totalBytes,
    spillPayloadBytes,
    largestBytes,
    oldestAgeMs: params.stateCount > 0 ? params.now - oldestCreatedAt : 0,
    spillWrites: params.spillWrites,
    spillWriteFailures: params.spillWriteFailures,
    spillWriteStatus: params.spillWriteConsecutiveFailures > 0
      ? "degraded"
      : params.spillLastSuccessAt !== null
        ? "healthy"
        : "initial",
    spillWriteConsecutiveFailures: params.spillWriteConsecutiveFailures,
    spillLastWriteFailureCode: params.spillLastFailureCode,
    spillLastWriteFailureOrigin: params.spillLastFailureOrigin,
    spillAclRetryReturnedTimeouts: params.spillAclRetryReturnedTimeouts,
    spillAclTimeoutMemoRefusals: params.spillAclTimeoutMemoRefusals,
    spillLastWriteFailureAt: params.spillLastFailureAt,
    spillLastWriteSuccessAt: params.spillLastSuccessAt,
    spillReadFailures: params.spillReadFailures,
    replayScopeMismatchDrops: params.replayScopeMismatchDrops,
  };
}
