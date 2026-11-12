export type OcxTelemetryDecision = "accepted" | "declined";

/**
 * Anonymous product telemetry consent state.
 *
 * Absence of `decision` means undecided. No payload is sent until either `decision` is
 * `"accepted"` or a human has seen the disclosure (`noticeShownAt` recorded via interactive
 * TTY or dashboard consent session). The collector endpoint is a code constant and is never
 * persisted here.
 */
export interface OcxTelemetryConfig {
  decision?: OcxTelemetryDecision;
  decidedAt?: string;
  noticeShownAt?: string;
}
