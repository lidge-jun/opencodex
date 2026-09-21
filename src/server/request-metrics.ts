import type { ResponsesTerminalStatus } from "../bridge";
import type { AttemptRecoveryKind } from "../usage/log";
import {
  REQUEST_FAILURE_CAUSES,
  type RequestFailureCause,
  causeForRecoveryKind,
} from "../lib/request-failure-model";
import {
  REQUEST_OUTCOME_CLASSES,
  classifyRequestOutcome,
  type RequestOutcomeClass,
} from "../usage/request-outcome";

export const REQUEST_METRICS_PROTOCOLS = Object.freeze(["responses", "chat", "messages", "unknown"] as const);
/**
 * The exporter's result label set IS the shared outcome vocabulary, not a copy of it. Restating
 * these four strings here is what let the exporter and the dashboard drift into disagreeing about
 * the same request.
 */
export const REQUEST_METRICS_RESULTS = REQUEST_OUTCOME_CLASSES;
/**
 * Closed recovery classes exported as Prometheus label values.
 *
 * Bounded by construction: the label can only ever take one of these strings, so no user, model,
 * account or request identifier can reach a series name. `quota`, `policy` and `ciphertext` are
 * separate members because an operator seeing a spike needs to know which one it is -- waiting
 * out a rate limit, changing accounts, changing the prompt and dropping stale ciphertext are
 * four different responses, and collapsing them is what made the existing counter unactionable.
 */
export const REQUEST_METRICS_RECOVERY_CLASSES = Object.freeze([
  "transient",
  "connection",
  "credential",
  "rate_limit",
  "quota",
  "policy",
  "ciphertext",
  "payload",
  "empty_completion",
  "effort_downgrade",
  "other",
] as const);

export const REQUEST_DURATION_BUCKETS_SECONDS = Object.freeze([0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const);
export const REQUEST_TTFT_BUCKETS_SECONDS = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const);

/**
 * The failure-cause label set IS the shared dictionary, for the same reason the result label set
 * is the shared outcome vocabulary: a restated copy is what let two surfaces drift into
 * disagreeing about the same request.
 *
 * It labels a COUNTER and never a histogram. Fifteen causes across four protocols is sixty
 * series, fixed for the lifetime of the roster, and every value comes from a frozen list, so no
 * user, model, account or request identifier can reach a series name. A histogram labelled by
 * cause would multiply that by its bucket count for no question anyone asks.
 */
export const REQUEST_METRICS_FAILURE_CAUSES = REQUEST_FAILURE_CAUSES;

export type RequestMetricsProtocol = typeof REQUEST_METRICS_PROTOCOLS[number];
export type RequestMetricsResult = RequestOutcomeClass;
export type RequestMetricsRecoveryClass = typeof REQUEST_METRICS_RECOVERY_CLASSES[number];

export interface RequestMetricFinalFact {
  protocol?: "responses" | "chat" | "messages";
  status: number;
  durationMs: number;
  firstOutputMs?: number;
  terminalStatus?: ResponsesTerminalStatus;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  attempts?: ReadonlyArray<{
    sendCount: number;
    recoveryKinds: readonly AttemptRecoveryKind[];
  }>;
  spendSends?: number;
  /**
   * Why this request failed, as the recorder derived it. Absent when it did not fail, which is
   * why the counter below cannot be reconstructed by subtracting completions from totals.
   */
  failureCause?: RequestFailureCause;
}

export interface RequestMetricsRecorder {
  recordFinalRequest(fact: RequestMetricFinalFact): void;
}

export interface RequestMetricsSnapshotter {
  snapshot(): string;
}

export interface RequestMetricsOwner extends RequestMetricsRecorder, RequestMetricsSnapshotter {
  resetForTests(): void;
}

interface HistogramCell {
  buckets: number[];
  count: number;
  sum: number;
}

const protocolCell = (value: RequestMetricsProtocol): number => REQUEST_METRICS_PROTOCOLS.indexOf(value);
const resultCell = (value: RequestMetricsResult): number => REQUEST_METRICS_RESULTS.indexOf(value);
const recoveryCell = (value: RequestMetricsRecoveryClass): number => REQUEST_METRICS_RECOVERY_CLASSES.indexOf(value);
const failureCauseCell = (value: RequestFailureCause): number => REQUEST_METRICS_FAILURE_CAUSES.indexOf(value);

function matrix(rows: number, columns: number): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));
}

function histograms(bounds: readonly number[]): HistogramCell[][] {
  return Array.from({ length: REQUEST_METRICS_PROTOCOLS.length }, () => (
    Array.from({ length: REQUEST_METRICS_RESULTS.length }, () => ({
      buckets: Array.from({ length: bounds.length + 1 }, () => 0),
      count: 0,
      sum: 0,
    }))
  ));
}

/**
 * Metrics class for each shared failure cause.
 *
 * Keyed on the cause rather than on the recovery kind so this projection and the durable log
 * speak one vocabulary. Total by construction: the previous switch ended in `default: "other"`,
 * which meant a recovery kind added later compiled cleanly and then disappeared into an
 * unactionable bucket. A missing member is now a typecheck failure.
 */
const CAUSE_METRICS_CLASS = {
  "transport-unsent": "connection",
  "transport-ambiguous": "connection",
  "upstream-declined": "transient",
  "rate-limit": "rate_limit",
  "quota-exhausted": "quota",
  "credential-rejected": "credential",
  "policy-refusal": "policy",
  "parameter-rejected": "effort_downgrade",
  "ciphertext-refusal": "ciphertext",
  "payload-too-large": "payload",
  "payload-rejected": "payload",
  "upstream-fault": "transient",
  "empty-output": "empty_completion",
  "client-cancelled": "other",
  "local-refusal": "other",
} as const satisfies Record<RequestFailureCause, RequestMetricsRecoveryClass>;

function recoveryClass(kind: AttemptRecoveryKind): RequestMetricsRecoveryClass {
  return CAUSE_METRICS_CLASS[causeForRecoveryKind(kind)];
}

function observeHistogram(cell: HistogramCell, bounds: readonly number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  cell.count += 1;
  cell.sum += value;
  for (let index = 0; index < bounds.length; index += 1) {
    if (value <= bounds[index]!) cell.buckets[index]! += 1;
  }
  cell.buckets[bounds.length]! += 1;
}

function sampleLabels(protocol: RequestMetricsProtocol, result?: RequestMetricsResult): string {
  return result === undefined
    ? `{protocol="${protocol}"}`
    : `{protocol="${protocol}",result="${result}"}`;
}

function appendHistogram(
  lines: string[],
  name: string,
  help: string,
  values: HistogramCell[][],
  bounds: readonly number[],
): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
  for (const protocol of REQUEST_METRICS_PROTOCOLS) {
    for (const result of REQUEST_METRICS_RESULTS) {
      const cell = values[protocolCell(protocol)]![resultCell(result)]!;
      for (let index = 0; index < bounds.length; index += 1) {
        lines.push(`${name}_bucket{protocol="${protocol}",result="${result}",le="${bounds[index]}"} ${cell.buckets[index]}`);
      }
      lines.push(`${name}_bucket{protocol="${protocol}",result="${result}",le="+Inf"} ${cell.buckets[bounds.length]}`);
      lines.push(`${name}_sum${sampleLabels(protocol, result)} ${cell.sum}`);
      lines.push(`${name}_count${sampleLabels(protocol, result)} ${cell.count}`);
    }
  }
}

export function createRequestMetricsOwner(
  processStartTimeSeconds = Date.now() / 1000,
): RequestMetricsOwner {
  let logicalRequests = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);
  let physicalSends = Array.from({ length: REQUEST_METRICS_PROTOCOLS.length }, () => 0);
  let recoveries = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RECOVERY_CLASSES.length);
  let failureCauses = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_FAILURE_CAUSES.length);
  let durations = histograms(REQUEST_DURATION_BUCKETS_SECONDS);
  let ttft = histograms(REQUEST_TTFT_BUCKETS_SECONDS);
  let missingTtft = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);

  return {
    recordFinalRequest(fact): void {
      const protocol: RequestMetricsProtocol = fact.protocol ?? "unknown";
      const result = classifyRequestOutcome(fact);
      const protocolIndex = protocolCell(protocol);
      const resultIndex = resultCell(result);
      logicalRequests[protocolIndex]![resultIndex]! += 1;

      const attempts = fact.attempts;
      const sends = attempts === undefined
        ? (Number.isInteger(fact.spendSends) && fact.spendSends! >= 0 ? fact.spendSends! : 0)
        : attempts.reduce((total, attempt) => (
          Number.isInteger(attempt.sendCount) && attempt.sendCount >= 0 ? total + attempt.sendCount : total
        ), 0);
      physicalSends[protocolIndex]! += sends;

      // Counted from the cause the recorder derived, not re-derived here. Two derivations of one
      // answer is the disagreement this batch exists to remove, and the recorder is the only
      // place that sees the transport facts a cause needs.
      if (fact.failureCause !== undefined) {
        failureCauses[protocolIndex]![failureCauseCell(fact.failureCause)]! += 1;
      }

      for (const attempt of attempts ?? []) {
        for (const kind of new Set(attempt.recoveryKinds)) {
          recoveries[protocolIndex]![recoveryCell(recoveryClass(kind))]! += 1;
        }
      }

      observeHistogram(durations[protocolIndex]![resultIndex]!, REQUEST_DURATION_BUCKETS_SECONDS, fact.durationMs / 1000);
      if (typeof fact.firstOutputMs === "number" && Number.isFinite(fact.firstOutputMs) && fact.firstOutputMs >= 0) {
        observeHistogram(ttft[protocolIndex]![resultIndex]!, REQUEST_TTFT_BUCKETS_SECONDS, fact.firstOutputMs / 1000);
      } else {
        missingTtft[protocolIndex]![resultIndex]! += 1;
      }
    },

    snapshot(): string {
      const lines: string[] = [
        "# HELP opencodex_logical_requests_total Finalized logical requests in this process.",
        "# TYPE opencodex_logical_requests_total counter",
      ];
      for (const protocol of REQUEST_METRICS_PROTOCOLS) {
        for (const result of REQUEST_METRICS_RESULTS) {
          lines.push(`opencodex_logical_requests_total${sampleLabels(protocol, result)} ${logicalRequests[protocolCell(protocol)]![resultCell(result)]}`);
        }
      }
      lines.push(
        "# HELP opencodex_physical_sends_total Upstream sends made by finalized logical requests in this process.",
        "# TYPE opencodex_physical_sends_total counter",
      );
      for (const protocol of REQUEST_METRICS_PROTOCOLS) {
        lines.push(`opencodex_physical_sends_total${sampleLabels(protocol)} ${physicalSends[protocolCell(protocol)]}`);
      }
      lines.push(
        "# HELP opencodex_recoveries_total Distinct recovery kinds observed per physical attempt in this process.",
        "# TYPE opencodex_recoveries_total counter",
      );
      for (const protocol of REQUEST_METRICS_PROTOCOLS) {
        for (const recovery of REQUEST_METRICS_RECOVERY_CLASSES) {
          lines.push(`opencodex_recoveries_total{protocol="${protocol}",recovery="${recovery}"} ${recoveries[protocolCell(protocol)]![recoveryCell(recovery)]}`);
        }
      }
      lines.push(
        "# HELP opencodex_request_failures_total Finalized logical requests that did not deliver an answer, by derived cause.",
        "# TYPE opencodex_request_failures_total counter",
      );
      for (const protocol of REQUEST_METRICS_PROTOCOLS) {
        for (const cause of REQUEST_METRICS_FAILURE_CAUSES) {
          lines.push(`opencodex_request_failures_total{protocol="${protocol}",cause="${cause}"} ${failureCauses[protocolCell(protocol)]![failureCauseCell(cause)]}`);
        }
      }
      appendHistogram(lines, "opencodex_request_duration_seconds", "Finalized logical request duration in seconds.", durations, REQUEST_DURATION_BUCKETS_SECONDS);
      appendHistogram(lines, "opencodex_ttft_seconds", "Observed time to first output in seconds.", ttft, REQUEST_TTFT_BUCKETS_SECONDS);
      lines.push(
        "# HELP opencodex_ttft_missing_total Finalized logical requests without an observed time to first output.",
        "# TYPE opencodex_ttft_missing_total counter",
      );
      for (const protocol of REQUEST_METRICS_PROTOCOLS) {
        for (const result of REQUEST_METRICS_RESULTS) {
          lines.push(`opencodex_ttft_missing_total${sampleLabels(protocol, result)} ${missingTtft[protocolCell(protocol)]![resultCell(result)]}`);
        }
      }
      lines.push(
        "# HELP opencodex_metrics_process_start_time_seconds Unix time when this process metrics owner started.",
        "# TYPE opencodex_metrics_process_start_time_seconds gauge",
        `opencodex_metrics_process_start_time_seconds ${processStartTimeSeconds}`,
      );
      return `${lines.join("\n")}\n`;
    },

    resetForTests(): void {
      logicalRequests = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);
      physicalSends = Array.from({ length: REQUEST_METRICS_PROTOCOLS.length }, () => 0);
      recoveries = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RECOVERY_CLASSES.length);
      failureCauses = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_FAILURE_CAUSES.length);
      durations = histograms(REQUEST_DURATION_BUCKETS_SECONDS);
      ttft = histograms(REQUEST_TTFT_BUCKETS_SECONDS);
      missingTtft = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);
    },
  };
}
