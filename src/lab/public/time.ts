import { PublicEvidenceValidationError } from "./validate";

/** Convert a bounded JavaScript timestamp into the public UTC day bucket. */
export function publicUtcDay(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
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
