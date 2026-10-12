import type { RequestLogEntry } from "../../src/server";

/**
 * One request-log row with every required field already filled in.
 *
 * Moved out of tests/usage/request-log.test.ts verbatim: that file sits at its file-size cap, and
 * the repository answer to a cap is a sibling helper rather than compressed control flow. The
 * defaults are the ones its twenty-seven call sites were already relying on.
 */
export function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 10,
    usageStatus: "unreported",
    ...overrides,
  };
}
