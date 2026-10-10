import { expect, test } from "bun:test";
import { classifyCodexUpstreamOutcome } from "../../src/codex/routing/cooldown-math";
import { httpStatusFromTerminalError } from "../../src/lib/errors";
import { addFinalRequestLog, httpStatusForRequestLogTerminal, inspectResponseLogJson, noteUpstreamRequestId, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";

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
      error: { type: "server_error", code: "server_error", message: "secret upstream body" },
    }));
    noteUpstreamRequestId(log, new Headers({ "openai-request-id": "not a token" }));
  } finally {
    console.warn = warn;
  }
  expect(log.upstreamRequestId).toBe("req_abc123");
  expect(log.upstreamErrorCode).toBe("server_error");
  expect(log.upstreamErrorType).toBe("server_error");
  expect(warnings.join("\n")).not.toContain("secret upstream body");
  expect(warnings.some(line => line.includes("code=server_error") && line.includes("request_id=req_abc123"))).toBe(true);
});


for (const shape of ["error", "last_error", "response"] as const) {
  test.each([
    ["rate_limit_error", "rate_limit_exceeded", 429],
    ["rate_limit_error", "rate_limit_error", 429],
    ["server_error", "server_is_overloaded", 503],
    ["overloaded_error", "overloaded_error", 503],
    ["rate_limit_error", undefined, 429],
    ["overloaded_error", undefined, 503],
    // An unrecognized bare error records no status; combo preflight reads explicit event fields.
    ["server_error", "server_error", undefined],
    ["rate_limit_error", "unknown_code", undefined],
    ["server_error", undefined, undefined],
  ] as const)(`bare ${shape} class %s / %s maps status and retains original diagnostics`, (type, code, status) => {
    const log = context();
    const error = { type, code, message: "bounded diagnostic fixture" };
    inspectResponseLogJson(log, JSON.stringify({ type: "error",
      [shape]: shape === "response" ? { error } : error }));
    expect(log.terminalHttpStatus).toBe(status);
    expect(log.upstreamErrorType).toBe(type);
    expect(log.upstreamErrorCode).toBe(code);
    // A genuine terminal replaces provisional status while retaining the original diagnostics.
    inspectResponseLogJson(log, JSON.stringify({ type: "response.failed",
      response: { error: { type: "upstream_error", code: "upstream_server_error", message: "later terminal" } } }));
    expect(log.terminalHttpStatus).toBe(502);
    expect(log.upstreamErrorType).toBe(type);
    expect(log.upstreamErrorCode).toBe(code ?? "upstream_server_error");
  });
}

test.each(["rate_limit_exceeded", "rate_limit_error", "server_is_overloaded", "overloaded_error", "server_error"])(
  "flat bare error %s maps by code without recording its event discriminator as a class", code => {
    const log = context();
    inspectResponseLogJson(log, JSON.stringify({ type: "error", code, message: "diagnostic fixture" }));
    expect(log.terminalHttpStatus).toBe(code.startsWith("rate_limit") ? 429 : code === "server_error" ? undefined : 503);
    expect(log.upstreamErrorCode).toBe(code);
    expect(log.upstreamErrorType).toBeUndefined();
  },
);

test("bare policy refusals retain precedence over a rate-limit type", () => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error",
    error: { type: "rate_limit_error", code: "cyber_policy", message: "blocked by upstream policy" } }));
  expect(log.terminalHttpStatus).toBe(400);
  expect(log.upstreamErrorCode).toBe("cyber_policy");
});

test.each(["", "bad type", "secret\nvalue", "x".repeat(129), { unsafe: "type" }])(
  "upstream error types obey the diagnostic token bounds: %p", type => {
    const log = context();
    inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { type, message: "diagnostic fixture" } }));
    expect(log.upstreamErrorType).toBeUndefined();
  },
);

test("upstream error type records only a known class and keeps the first one", () => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ error: { type: "x".repeat(128) } }));
  expect(log.upstreamErrorType).toBeUndefined();
  inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error" } }));
  inspectResponseLogJson(log, JSON.stringify({ error: { type: "rate_limit_error" } }));
  expect(log.upstreamErrorType).toBe("server_error");
});

test("an opaque configured credential echoed as the error type is never recorded", () => {
  const fixture = "private-provider-key-" + "G".repeat(32);
  const log = context();
  let row: RequestLogEntry | undefined;
  inspectResponseLogJson(log, JSON.stringify({ error: { type: fixture, message: "fixture" } }));
  addFinalRequestLog("probe", Date.now(), log, 503, undefined, entry => { row = entry; });
  expect(log.upstreamErrorType).toBeUndefined();
  expect(JSON.stringify(row)).not.toContain(fixture);
});

test("an unrecognized bare top-level code is never recorded as a diagnostic", () => {
  const fixture = "private-provider-key-" + "H".repeat(32);
  const log = context();
  let row: RequestLogEntry | undefined;
  inspectResponseLogJson(log, JSON.stringify({ type: "error", code: fixture, message: "fixture" }));
  addFinalRequestLog("probe", Date.now(), log, 502, undefined, entry => { row = entry; });
  expect(log.upstreamErrorCode).toBeUndefined();
  expect(JSON.stringify(row)).not.toContain(fixture);
});


test("final request rows expose original upstream error type, code, request id and mapped status", () => {
  const log = context();
  noteUpstreamRequestId(log, new Headers({ "openai-request-id": "req_diagnostic_fixture" }));
  inspectResponseLogJson(log, JSON.stringify({ type: "error",
    error: { type: "overloaded_error", code: "overloaded_error", message: "capacity unavailable" } }));
  const rows: RequestLogEntry[] = [];
  addFinalRequestLog("diagnostic-fixture", Date.now(), log, httpStatusForRequestLogTerminal("failed", log),
    { terminalStatus: "failed", closeReason: "terminal" }, entry => rows.push(entry));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe(503);
  expect(rows[0]!.upstreamErrorType).toBe("overloaded_error");
  expect(rows[0]!.upstreamErrorCode).toBe("overloaded_error");
  expect(rows[0]!.upstreamRequestId).toBe("req_diagnostic_fixture");
});

test("an explicit unknown code outranks a recognized class in a lower-priority envelope", () => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error",
    error: { type: "server_error", code: "unknown_code", message: "transport diagnostic" },
    response: { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } } }));
  expect(log.terminalHttpStatus).toBeUndefined();
  expect(log.upstreamErrorType).toBe("server_error");
  expect(log.upstreamErrorCode).toBe("unknown_code");
});


test.each([
  ["rate_limit_error", "rate_limit_exceeded", 429, "server_error", "server_is_overloaded", 503, "transient"],
  ["server_error", "server_is_overloaded", 503, "invalid_request_error", "invalid_prompt", 400, "caller"],
] as const)("bare %s / %s is provisional until genuine %s", (bareType, bareCode, bareStatus, terminalType, terminalCode, terminalStatus, healthClass) => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { type: bareType, code: bareCode } }));
  expect(log.terminalHttpStatus).toBe(bareStatus);
  const error = { type: terminalType, code: terminalCode };
  inspectResponseLogJson(log, JSON.stringify({ type: "response.failed", response: { error } }));
  expect(log.terminalHttpStatus).toBe(terminalStatus);
  expect(log.terminalHttpStatus).toBe(httpStatusFromTerminalError(error));
  const classifierInput = httpStatusForRequestLogTerminal("failed", log);
  expect(classifierInput).toBe(terminalStatus);
  expect(classifyCodexUpstreamOutcome(classifierInput)).toBe(healthClass);
  expect(classifyCodexUpstreamOutcome(log.terminalHttpStatus!)).not.toBe("quota");
});

test.each(["response.completed", "response.incomplete"])("%s clears provisional quota evidence before pool classification", type => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }));
  expect(log.terminalHttpStatus).toBe(429);
  inspectResponseLogJson(log, JSON.stringify({ type, response: { incomplete_details: { reason: "max_output_tokens" } } }));
  expect(log.terminalHttpStatus).not.toBe(429);
  expect(httpStatusForRequestLogTerminal(type === "response.completed" ? "completed" : "incomplete", log)).toBe(200);
  // Late bare errors cannot reinstate quota evidence after a genuine terminal.
  inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }));
  expect(log.terminalHttpStatus).not.toBe(429);
});

test("a bare rate limit with no genuine terminal remains quota input", () => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }));
  expect(httpStatusForRequestLogTerminal("failed", log)).toBe(429);
  expect(classifyCodexUpstreamOutcome(log.terminalHttpStatus!)).toBe("quota");
});

test("genuine success clears the provisional policy error code", () => {
  const log = context();
  inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { code: "cyber_policy" } }));
  expect(log.terminalErrorCode).toBe("cyber_policy");
  inspectResponseLogJson(log, JSON.stringify({ type: "response.completed", response: { status: "completed" } }));
  expect(log.terminalHttpStatus).toBeUndefined();
  expect(log.terminalErrorCode).toBeUndefined();
});

for (const field of ["error", "last_error", "response"] as const) {
  test(`credential-shaped ${field} type and code never reach the final log row or warning`, () => {
    const fixture = "sk-" + "A".repeat(48);
    const envelope = { type: fixture, code: fixture, message: "fixture" };
    const payload = field === "response" ? { response: { error: envelope } } : { [field]: envelope };
    const log = context();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
    let row: RequestLogEntry | undefined;
    try {
      noteUpstreamRequestId(log, new Headers({ "x-request-id": fixture }));
      inspectResponseLogJson(log, JSON.stringify(payload));
      addFinalRequestLog("probe", Date.now(), log, 502, undefined, entry => { row = entry; });
    } finally {
      console.warn = warn;
    }
    expect(log.upstreamErrorType).toBeUndefined();
    expect(log.upstreamErrorCode).toBeUndefined();
    expect(log.upstreamRequestId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(fixture);
    expect(warnings.join("\n")).not.toContain(fixture);
  });
}
