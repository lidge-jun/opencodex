export const spillCounters = {
  writes: 0, writeFailures: 0, readFailures: 0,
  aclRetryReturnedTimeouts: 0, aclTimeoutMemoRefusals: 0,
};

export type ResponseSpillWriteFailureCode =
  | "EACLRETRYEXHAUSTED"
  | "ETIMEDOUT"
  | "EACCES"
  | "ENOSPC"
  | "EFBIG"
  | "EIO"
  | "ECAPACITY"
  | "ELOOP"
  | "EUNKNOWN";

export type ResponseSpillWriteStatus = "initial" | "healthy" | "degraded";

export type ResponseSpillWriteFailureOrigin =
  | "retry_returned_timeout"
  | "timeout_memo_refusal";

interface ResponseSpillWriteHealth {
  consecutiveFailures: number;
  lastFailureCode: ResponseSpillWriteFailureCode | null;
  lastFailureOrigin: ResponseSpillWriteFailureOrigin | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export const spillWriteHealth: ResponseSpillWriteHealth = {
  consecutiveFailures: 0,
  lastFailureCode: null,
  lastFailureOrigin: null,
  lastFailureAt: null,
  lastSuccessAt: null,
};

/**
 * Collapse filesystem/runtime errors into a fixed privacy-safe diagnostic union.
 * Messages and paths are deliberately ignored: this projection is returned by the
 * authenticated memory endpoint, and a nested `cause` can contain a username or
 * workspace path even when the public wrapper does not.
 */
function classifySpillWriteFailure(error: unknown): ResponseSpillWriteFailureCode {
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const record = cursor as { code?: unknown; cause?: unknown };
    const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
    switch (code) {
      case "EACLRETRYEXHAUSTED": return "EACLRETRYEXHAUSTED";
      case "ETIMEDOUT": return "ETIMEDOUT";
      case "EACCES":
      case "EPERM": return "EACCES";
      case "ENOSPC":
      case "EDQUOT": return "ENOSPC";
      case "EFBIG": return "EFBIG";
      case "EIO": return "EIO";
      case "ECAPACITY": return "ECAPACITY";
      case "ELOOP": return "ELOOP";
    }
    cursor = record.cause;
  }
  return "EUNKNOWN";
}

/** The spill writer preserves ACL errors in cause; only a fixed memo marker is diagnostic. */
export function spillAclMemoRefusalOrigin(error: unknown): "timeout_memo_refusal" | null {
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const record = cursor as { code?: unknown; aclFailureOrigin?: unknown; cause?: unknown };
    if ((record.code === "ETIMEDOUT" || record.code === "EACLRETRYEXHAUSTED")
      && record.aclFailureOrigin === "timeout_memo_refusal") {
      return "timeout_memo_refusal";
    }
    cursor = record.cause;
  }
  return null;
}

export function noteSpillWriteSuccess(): void {
  spillCounters.writes += 1;
  spillWriteHealth.consecutiveFailures = 0;
  spillWriteHealth.lastSuccessAt = Date.now();
}

export function noteSpillWriteFailure(
  error: unknown,
  override?: ResponseSpillWriteFailureCode,
  retryOrigin: ResponseSpillWriteFailureOrigin | null = null,
): void {
  const code = override ?? classifySpillWriteFailure(error);
  const origin = code === "ETIMEDOUT" || code === "EACLRETRYEXHAUSTED"
    ? spillAclMemoRefusalOrigin(error) ?? retryOrigin
    : null;
  spillCounters.writeFailures += 1;
  spillWriteHealth.consecutiveFailures += 1;
  spillWriteHealth.lastFailureCode = code;
  spillWriteHealth.lastFailureOrigin = origin;
  spillWriteHealth.lastFailureAt = Date.now();
  // Count terminal publications, not ACL calls or a transient first attempt.
  if (origin === "retry_returned_timeout") spillCounters.aclRetryReturnedTimeouts += 1;
  else if (origin === "timeout_memo_refusal") spillCounters.aclTimeoutMemoRefusals += 1;
}
/**
 * Admission-boundary observability (test-visible). directSpills: oversized
 * candidates routed straight to durable spill without a resident stay or
 * unrelated demotion. oversizedDrops: candidates above the single-spill
 * payload ceiling, tombstoned instead of retained. snapshotOversizedRefusals:
 * snapshot files refused before parse.
 */
export const admissionCounters = { directSpills: 0, oversizedDrops: 0, snapshotOversizedRefusals: 0 };


/** Test-only: admission-boundary counters (proves the new paths fire). */
export function responseAdmissionCountersForTests(): Readonly<typeof admissionCounters> {
  return admissionCounters;
}
