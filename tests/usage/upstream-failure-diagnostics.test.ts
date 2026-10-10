import { expect, test } from "bun:test";
import { inspectResponseLogJson, noteUpstreamRequestId, type RequestLogContext } from "../../src/server/request-log";

function context(): RequestLogContext {
  return { model: "fixture-model", provider: "openai" };
}

test("upstream failures record the error code and request id without the body", () => {
  const log = context();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
  try {
    noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_abc123" }));
    inspectResponseLogJson(log, JSON.stringify({
      error: { code: "server_error", message: "secret upstream body" },
    }));
    noteUpstreamRequestId(log, new Headers({ "openai-request-id": "not a token" }));
  } finally {
    console.warn = warn;
  }
  expect(log.upstreamRequestId).toBe("req_abc123");
  expect(log.upstreamErrorCode).toBe("server_error");
  expect(warnings.join("\n")).not.toContain("secret upstream body");
  expect(warnings.some(line => line.includes("code=server_error") && line.includes("request_id=req_abc123"))).toBe(true);
});
