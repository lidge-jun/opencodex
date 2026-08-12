import type { SyntheticPatchV1 } from "./types";

/** Maximum bytes accepted from child stdout for the fabric producer protocol. */
export const FABRIC_PRODUCER_PROTOCOL_MAX_BYTES = 64 * 1024;

/** Maximum stderr bytes retained for harness diagnostics. */
export const FABRIC_PRODUCER_STDERR_MAX_BYTES = 4 * 1024;

/** Maximum request payload size on child stdin. */
export const FABRIC_PRODUCER_REQUEST_MAX_BYTES = 64 * 1024;

export type ProducerChildMessage =
  | { type: "activity" }
  | { type: "result"; patch: SyntheticPatchV1 }
  | { type: "error"; code: string; message: string; attribution: "harness" | "environment" };

export interface ProducerParentRequest {
  harnessKind?: string;
  executorModulePath?: string;
  scratchRoot: string;
  executorInput?: unknown;
  /** Parent-owned budgets are passed through so synthetic harness timing can scale in tests. */
  totalTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

export interface IsolatedProducerResult {
  patch: SyntheticPatchV1;
  lastActivityAt: number;
}

/** Serialize one protocol line to stdout (newline-delimited JSON). */
export function encodeProducerProtocolLine(message: ProducerChildMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parse one protocol line from the child. Malformed lines throw. */
export function parseProducerProtocolLine(line: string): ProducerChildMessage {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error("empty protocol line");
  }
  const parsed = JSON.parse(trimmed) as ProducerChildMessage;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("malformed protocol message");
  }
  switch (parsed.type) {
    case "activity":
      return { type: "activity" };
    case "result":
      if (!parsed.patch || typeof parsed.patch !== "object") throw new Error("malformed result patch");
      return parsed as ProducerChildMessage;
    case "error":
      if (typeof parsed.code !== "string" || typeof parsed.message !== "string") {
        throw new Error("malformed error message");
      }
      return parsed as ProducerChildMessage;
    default:
      throw new Error(`unknown protocol type: ${(parsed as { type: string }).type}`);
  }
}
