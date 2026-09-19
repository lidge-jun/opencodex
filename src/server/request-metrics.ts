import type { ResponsesTerminalStatus } from "../bridge";
import type { AttemptRecoveryKind } from "../usage/log";

export const REQUEST_METRICS_PROTOCOLS = Object.freeze(["responses", "chat", "messages", "unknown"] as const);
export const REQUEST_METRICS_RESULTS = Object.freeze(["completed", "failed", "incomplete", "aborted"] as const);
export const REQUEST_METRICS_RECOVERY_CLASSES = Object.freeze([
  "transient",
  "connection",
  "credential",
  "rate_limit",
  "payload",
  "empty_completion",
  "effort_downgrade",
  "other",
] as const);

export const REQUEST_DURATION_BUCKETS_SECONDS = Object.freeze([0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const);
export const REQUEST_TTFT_BUCKETS_SECONDS = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const);

export type RequestMetricsProtocol = typeof REQUEST_METRICS_PROTOCOLS[number];
export type RequestMetricsResult = typeof REQUEST_METRICS_RESULTS[number];
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

function classifyResult(fact: RequestMetricFinalFact): RequestMetricsResult {
  if (fact.closeReason === "client_cancel" || fact.status === 499) return "aborted";
  if (fact.terminalStatus === "failed") return "failed";
  if (fact.terminalStatus === "incomplete"
    || fact.closeReason === "body_stall"
    || fact.closeReason === "body_overflow") return "incomplete";
  if (fact.terminalStatus === "completed") return "completed";
  if (fact.terminalStatus === undefined
    && (fact.status === 101 || (fact.status >= 200 && fact.status < 400))) return "completed";
  return "failed";
}

function recoveryClass(kind: AttemptRecoveryKind): RequestMetricsRecoveryClass {
  switch (kind) {
    case "transient-5xx": return "transient";
    case "connection-reset": return "connection";
    case "oauth-401":
    case "key-401": return "credential";
    case "key-429":
    case "rate-limit-429":
    case "anthropic-oauth-429":
    case "oauth-account-429": return "rate_limit";
    case "image-413":
    case "console-go-upload-retry":
    case "opaque-blob-rejection": return "payload";
    case "empty-completion": return "empty_completion";
    case "reasoning-effort-downgrade": return "effort_downgrade";
    default: return "other";
  }
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
  let durations = histograms(REQUEST_DURATION_BUCKETS_SECONDS);
  let ttft = histograms(REQUEST_TTFT_BUCKETS_SECONDS);
  let missingTtft = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);

  return {
    recordFinalRequest(fact): void {
      const protocol: RequestMetricsProtocol = fact.protocol ?? "unknown";
      const result = classifyResult(fact);
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
      durations = histograms(REQUEST_DURATION_BUCKETS_SECONDS);
      ttft = histograms(REQUEST_TTFT_BUCKETS_SECONDS);
      missingTtft = matrix(REQUEST_METRICS_PROTOCOLS.length, REQUEST_METRICS_RESULTS.length);
    },
  };
}
