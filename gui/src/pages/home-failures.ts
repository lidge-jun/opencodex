import { classifyRequestOutcome, type RequestOutcomeFacts } from "../../../src/usage/request-outcome";

/** The slice of a log row Home reads: when it ran, and the facts its outcome is classified from. */
export interface HomeLogRow extends RequestOutcomeFacts {
  timestamp: number;
}

/**
 * Rows since `since` that ended as failures, by the same shared classifier the Logs page counts
 * with, so Home's headline and the Logs error count agree. A client cancel (499) is `aborted`
 * there, not an error, and a 200 that settled on a failed terminal is a failure.
 */
export function recentFailures<R extends HomeLogRow>(rows: readonly R[], since: number): R[] {
  return rows.filter(row => row.timestamp >= since && classifyRequestOutcome(row) === "failed");
}
