import { PublicEvidenceValidationError } from "./validate";

/** Largest timestamp whose ISO-8601 year still fits the four-digit YYYY form. */
const MAX_PUBLIC_DAY_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Convert a bounded JavaScript timestamp into the public UTC day bucket. */
export function publicUtcDay(timestampMs: number): string {
  if (
    !Number.isInteger(timestampMs)
    || timestampMs < 0
    || timestampMs > MAX_PUBLIC_DAY_TIMESTAMP_MS
  ) {
    throw new PublicEvidenceValidationError(
      "public_selection_time",
      "invalid observation completion timestamp",
    );
  }
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) {
    throw new PublicEvidenceValidationError(
      "public_selection_time",
      "invalid observation completion timestamp",
    );
  }
  return date.toISOString().slice(0, 10);
}
