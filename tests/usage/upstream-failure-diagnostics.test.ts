import { expect, test } from "bun:test";
import { afterEach, beforeEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { handleResponses } from "../../src/server/responses";
import { saveConfig } from "../../src/config";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { codexWsUpstreamFetch, streamingInit } from "../helpers/ws-upstream-fixtures";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { OutboundCredentialRegistry, credentialComponents, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";
import { diagnosticValueAllowed } from "../../src/server/request-log-terminal-status";
import { INCOMPLETE_RETRY_MS, configuredCredentials } from "../../src/server/configured-credentials";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/api-key-resolve";
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

// ---- #6911: sent-credential registry (private instances; no global state) ----
const noConfigured = { complete: true, matches: () => false };
describe("outbound credential registry", () => {
  test("credential-named headers match at any length; other headers only at 8+ chars; correlation ids are skipped", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember({ "X-Gateway-Credential": "gw-short", "content-api-key": "cak-1", "x-gateway-request-id": "gw-req-opaque-1",
      "x-request-id": "req_client_123", "x-codex-turn-metadata": "tokens" });
    for (const value of ["gw-short", "cak-1", "gw-req-opaque-1"]) expect(reg.matches(value)).toBe(true);
    for (const value of ["req_client_123", "tokens"]) expect(reg.matches(value)).toBe(false);
  });
  test("compound values register every part a server could authenticate with", () => {
    expect(credentialComponents("Token opaque-part-1")).toEqual(["Token opaque-part-1", "opaque-part-1"]);
    expect(credentialComponents('Digest username="u1", response="r-value"')).toContain("r-value");
    // RFC 9110 auth-param allows whitespace around "=" and quoted strings with quoted-pairs.
    expect(credentialComponents('Digest username = "u1", response = "r sp\\"q-0123456789"')).toContain('r sp"q-0123456789');
    expect(credentialComponents("Basic dXNlcjpwYXNzd29yZA==")).not.toContain("=");
    expect(credentialComponents("  ")).toEqual([]);
    expect(credentialComponents('a="unclosed b=after-0123')).toContain("after-0123");
    expect(credentialComponents('a="x\\\\" b="after-quoted"')).toContain("after-quoted");
  });
  test("parameter extraction stays linear on megabyte header values", () => {
    const mib = 1 << 20;
    const started = performance.now();
    for (const value of ["t".repeat(mib), `a="${"t".repeat(mib)}`, 'a="'.repeat(mib / 3), "k=".repeat(mib / 2)]) credentialComponents(value);
    // A quadratic scan of these inputs takes minutes; linear extraction finishes well inside this bound.
    expect(performance.now() - started).toBeLessThan(5_000);
    const reg = new OutboundCredentialRegistry();
    reg.remember({ "x-gateway-credential": "Token opaque-part-1" });
    expect(reg.matches("opaque-part-1")).toBe(true);
    expect(reg.matches("Token")).toBe(false);
  });
  test("authorization registers the full value and the token; standard Basic also registers its parts", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember(new Headers({ Authorization: "Bearer opaque-token-1", "proxy-authorization": "Basic " + btoa("user1:pass-value") }));
    for (const value of ["opaque-token-1", "Bearer opaque-token-1", "user1", "pass-value"]) expect(reg.matches(value)).toBe(true);
    const raw = new OutboundCredentialRegistry();
    raw.remember({ authorization: "Basic key-key" });
    expect(raw.matches("key-key")).toBe(true);
    expect(raw.matches("key")).toBe(false);
  });
  test("cookie values are registered individually and empty values are ignored", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember({ cookie: "a=cookie-one; b=cookie-two", "x-empty": "" });
    expect(reg.matches("cookie-one")).toBe(true);
    expect(reg.matches("cookie-two")).toBe(true);
    expect(reg.matches("")).toBe(false);
  });
  test("exact match at any length, substring only for credentials of 8 chars or more", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember({ "x-api-key": "k", "x-secret-b": "sevenc7", "x-secret-c": "abcDEF78" });
    expect(reg.matches("k")).toBe(true);
    expect(reg.matches("sevenc7")).toBe(true);
    expect(reg.matches("xxsevenc7xx")).toBe(false);
    expect(reg.matches("failed_abcDEF78_retry")).toBe(true);
    const cls = new OutboundCredentialRegistry();
    cls.remember({ "x-api-key": "server_error" });
    expect(diagnosticValueAllowed("server_error", cls, noConfigured)).toBe(false);
  });
  test("strict entry and byte bounds evict in LRU order and mark coverage incomplete", () => {
    const reg = new OutboundCredentialRegistry({ maxEntries: 2 });
    reg.remember({ "x-secret-1": "value-one" });
    reg.remember({ "x-secret-2": "value-two" });
    reg.remember({ "x-secret-1": "value-one" });
    expect(reg.complete()).toBe(true);
    reg.remember({ "x-secret-3": "value-three" });
    expect(reg.complete()).toBe(false);
    expect(reg.matches("value-two")).toBe(false);
    expect(reg.matches("value-one")).toBe(true);
    const bytes = new OutboundCredentialRegistry({ maxBytes: 10 });
    bytes.remember({ "x-secret-1": "123456" });
    bytes.remember({ "x-secret-2": "abcdef" });
    expect(bytes.complete()).toBe(false);
    const big = new OutboundCredentialRegistry({ maxValueBytes: 4 });
    big.remember({ "x-secret-1": "12345" });
    expect(big.complete()).toBe(false);
    expect(big.matches("12345")).toBe(false);
  });
  test("high-cardinality metadata churn never disables diagnostics", () => {
    const reg = new OutboundCredentialRegistry({ maxEntries: 4 });
    reg.remember({ authorization: "Bearer churn-bearer-1" });
    for (let turn = 0; turn < 50; turn++) reg.remember({ "x-codex-turn-state": `turn-state-${turn}-opaque`, session_id: `session-${turn}-opaque` });
    expect(reg.complete()).toBe(true);
    expect(reg.matches("churn-bearer-1")).toBe(true);
    expect(diagnosticValueAllowed("req_safe_after_churn", reg, noConfigured)).toBe(true);
  });
  test("configured coverage gaps fail closed for every field", () => {
    const reg = new OutboundCredentialRegistry();
    expect(diagnosticValueAllowed("server_error", reg, { complete: false, matches: () => false })).toBe(false);
    expect(diagnosticValueAllowed("server_error", reg, { complete: true, matches: value => value === "server_error" })).toBe(false);
    expect(diagnosticValueAllowed("server_error", reg, noConfigured)).toBe(true);
  });
  test("Request headers without init are read case-insensitively", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember(new Request("https://upstream.invalid/x", { headers: { "X-Api-Key": "request-key-value" } }).headers);
    expect(reg.matches("request-key-value")).toBe(true);
  });
});

describe("diagnostic wiring against a swapped registry", () => {
  test("a value captured before eviction is dropped from later warnings and the row, the type included; status remains", () => {
    const reg = new OutboundCredentialRegistry({ maxEntries: 1 });
    const restore = setOutboundCredentialRegistryForTests(reg);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
    let row: RequestLogEntry | undefined;
    try {
      const log = context();
      inspectResponseLogJson(log, JSON.stringify({ type: "error", error: { type: "overloaded_error", code: "opaque_code_value", message: "x" } }));
      expect(log.upstreamErrorCode).toBe("opaque_code_value");
      const statusBefore = httpStatusForRequestLogTerminal("failed", log);
      reg.remember({ "x-secret-1": "first-value" });
      reg.remember({ "x-secret-2": "second-value" });
      expect(reg.complete()).toBe(false);
      warnings.length = 0;
      noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_later" }));
      addFinalRequestLog("wiring", Date.now(), log, httpStatusForRequestLogTerminal("failed", log), undefined, entry => { row = entry; });
      expect(warnings.length).toBe(0);
      expect(log.upstreamRequestId).toBeUndefined();
      expect(row!.upstreamErrorCode).toBeUndefined();
      // A closed vocabulary does not prove an evicted credential was not also a class name.
      expect(row!.upstreamErrorType).toBeUndefined();
      expect(row!.status).toBe(statusBefore);
    } finally {
      console.warn = warn;
      restore();
    }
  });
  test("an incomplete registry fails closed for new code, request id and type", () => {
    const reg = new OutboundCredentialRegistry({ maxValueBytes: 1 });
    reg.remember({ "x-secret-1": "too-long" });
    const restore = setOutboundCredentialRegistryForTests(reg);
    const warn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    try {
      const log = context();
      noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_safe" }));
      inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: "server_error" } }));
      expect(log.upstreamRequestId).toBeUndefined();
      expect(log.upstreamErrorCode).toBeUndefined();
      expect(log.upstreamErrorType).toBeUndefined();
    } finally {
      console.warn = warn;
      restore();
    }
  });
});

// ---- #6911 regression block: base-compatible (imports only modules that exist before the fix) ----
const secret = (label: string): string => `opaque-${label}-${randomBytes(16).toString("hex")}`;
let regHome: string;
let regRelease: (() => void) | undefined;
const regPreviousHome = process.env.OPENCODEX_HOME;
describe("sent credentials echoed into upstream diagnostics", () => {
  beforeEach(() => {
    regHome = mkdtempSync(join(tmpdir(), "ocx-cred-echo-"));
    process.env.OPENCODEX_HOME = regHome;
    regRelease = acquireOwnedSpendHome();
  });
  afterEach(() => {
    regRelease?.();
    if (regPreviousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = regPreviousHome;
    removeTreeWithRetry(regHome);
  });

  /** Echo the credential that actually arrived in `header` into the requested diagnostic slot. */
  const echoingExecutor = (slot: string, header: (headers: Headers) => string | null) => (async (_url, init) => {
    const sent = header(new Headers(init?.headers)) ?? "";
    const envelope = { type: "server_error", code: sent, message: "fixture" };
    const body = slot === "last_error" ? { last_error: envelope } : slot === "response" ? { response: { error: envelope } } : { error: envelope };
    const responseHeaders: Record<string, string> = slot === "openai-request-id" ? { "openai-request-id": sent } : { "x-request-id": sent };
    return Response.json(body, { status: 503, headers: responseHeaders });
  }) as typeof fetch;
  const bearer = (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const run = async (provider: Record<string, unknown>, extraProviders: Record<string, unknown> = {}) => {
    const config = { port: 0, defaultProvider: "echo", providers: { echo: { adapter: "openai-responses", authMode: "key",
      baseUrl: "https://upstream.invalid/v1", models: ["fixture-model"], defaultModel: "fixture-model", ...provider }, ...extraProviders } } as unknown as OcxConfig;
    await saveConfig(config);
    const log: RequestLogContext = { model: "", provider: "" };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
    let row: RequestLogEntry | undefined;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "echo/fixture-model", input: "hello", stream: false }) }), config, log);
      await response.text().catch(() => "");
      addFinalRequestLog("echo", Date.now(), log, 503, undefined, entry => { row = entry; });
    } finally {
      console.warn = warn;
    }
    return { log, row: JSON.stringify(row ?? {}), warnings: warnings.join("\n") };
  };
  const expectMasked = (value: string, result: { log: RequestLogContext; row: string; warnings: string }) => {
    expect(`${result.log.upstreamErrorCode ?? ""} ${result.log.upstreamRequestId ?? ""}`).not.toContain(value);
    expect(result.row).not.toContain(value);
    expect(result.warnings).not.toContain(value);
  };
  const recording = (name: string, received: string[], transform: (value: string) => string = value => value) =>
    (headers: Headers) => {
      const value = headers.get(name);
      if (value) received.push(value);
      return value === null ? null : transform(value);
    };

  for (const name of ["Content-Api-Key", "X-Gateway-Request-Id"]) {
    test(`a configured credential in a ${name} header is masked whatever its name`, async () => {
      const value = secret("named");
      const received: string[] = [];
      const result = await run({ apiKey: secret("unused"), headers: { [name]: value }, fetch: echoingExecutor("error", recording(name, received)) });
      expect(received).toContain(value);
      expectMasked(value, result);
    });
  }

  test("the bare token of a compound configured credential echoed back is masked", async () => {
    const token = secret("compound");
    const received: string[] = [];
    const result = await run({ apiKey: secret("unused"), headers: { "X-Gateway-Credential": `Token ${token}` },
      fetch: echoingExecutor("error", recording("x-gateway-credential", received, value => value.replace(/^Token\s+/, ""))) });
    expect(received).toContain(`Token ${token}`);
    expectMasked(token, result);
  });

  for (const framing of ["compact", "spaced"]) {
    test(`a ${framing} quoted digest parameter echoed back is masked`, async () => {
      const response = randomBytes(16).toString("hex");
      const header = framing === "spaced" ? `Digest username = "u1", response = "${response}"` : `Digest username="u1", response="${response}"`;
      const received: string[] = [];
      const result = await run({ apiKey: secret("unused"), headers: { "X-Gateway-Credential": header },
        fetch: echoingExecutor("error", recording("x-gateway-credential", received, value => /response\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? "")) });
      expect(received).toContain(header);
      expectMasked(response, result);
    });
  }

  test("a configured credential echoed before this process ever sent it is masked", async () => {
    const otherKey = secret("never-sent");
    const sent: string[] = [];
    const result = await run({ apiKey: secret("active"), fetch: echoingExecutor("error", headers => {
      sent.push(bearer(headers) ?? "");
      return otherKey;
    }) }, { other: { adapter: "openai-responses", authMode: "key", baseUrl: "https://other.invalid/v1", apiKey: otherKey,
      apiKeyPool: [{ id: "o", key: otherKey }], models: ["fixture-model"], defaultModel: "fixture-model" } });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(otherKey);
    expectMasked(otherKey, result);
  });

  test("an OAuth token from the credential store is masked before it is ever sent", async () => {
    const { saveCredential } = await import("../../src/oauth/store");
    const access = secret("oauth-unsent");
    const refresh = secret("oauth-refresh");
    await saveCredential("github-copilot", { access, refresh, expires: Date.now() + 3_600_000, accountId: "u", source: "oauth" });
    for (const value of [access, refresh]) {
      const log = context();
      inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: value } }));
      noteUpstreamRequestId(log, new Headers({ "x-request-id": value }));
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(value);
    }
  });

  test("a short credential inside a decorated diagnostic is masked", async () => {
    const short = "abcDEF789";
    const result = await run({ apiKey: short, fetch: echoingExecutor("error", headers => `failed_${bearer(headers)}_retry`) });
    expectMasked(short, result);
  });

  test("a per-turn header carried in a reused WebSocket frame instead of the upgrade is registered", async () => {
    const { setCodexWsReuseAcrossTurns } = await import("../../src/config/codex-ws-reuse-setting");
    const turnSecret = secret("ws-frame");
    const unregister = registerUpstreamRewriter("ws-frame-fixture", target => {
      if (target.transport === "websocket") target.url = "ws://127.0.0.1:1/backend-api/codex/responses";
    });
    setCodexWsReuseAcrossTurns(true);
    try {
      const init = streamingInit();
      (init.headers as Record<string, string>)["x-codex-turn-state"] = turnSecret;
      const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses", init,
        (async () => new Response("fallback", { status: 500 })) as typeof fetch);
      await response.text().catch(() => "");
      const log = context();
      inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: turnSecret } }));
      noteUpstreamRequestId(log, new Headers({ "x-request-id": turnSecret }));
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(turnSecret);
    } finally {
      setCodexWsReuseAcrossTurns(false);
      unregister();
    }
  });

  for (const slot of ["error", "last_error", "response", "openai-request-id"]) {
    test(`a key-auth credential echoed in ${slot} never reaches the context, row or warning`, async () => {
      const key = secret("key");
      const { log, row, warnings } = await run({ apiKey: key, fetch: echoingExecutor(slot, bearer) });
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(key);
      expect(row).not.toContain(key);
      expect(warnings).not.toContain(key);
    });
  }

  test("an apiKeyPool member echoed back is masked", async () => {
    const a = secret("pool-a");
    const b = secret("pool-b");
    const { log, row } = await run({ apiKey: a, apiKeyPool: [{ id: "a", key: a }, { id: "b", key: b }], fetch: echoingExecutor("error", bearer) });
    for (const key of [a, b]) {
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(key);
      expect(row).not.toContain(key);
    }
  });

  test("an operator-configured arbitrary header echoed back is masked", async () => {
    const gateway = secret("gateway");
    const { log, row } = await run({ apiKey: secret("unused"), headers: { "x-gateway-credential": gateway },
      fetch: echoingExecutor("error", headers => headers.get("x-gateway-credential")) });
    expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(gateway);
    expect(row).not.toContain(gateway);
  });

  test("a plugin-added HTTP credential echoed back is masked", async () => {
    const pluginSecret = secret("plugin-http");
    const unregister = registerUpstreamRewriter("cred-fixture", target => { target.headers.set("x-plugin-credential", pluginSecret); });
    try {
      const { log, row } = await run({ apiKey: secret("unused"), fetch: echoingExecutor("error", headers => headers.get("x-plugin-credential")) });
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(pluginSecret);
      expect(row).not.toContain(pluginSecret);
    } finally {
      unregister();
    }
  });

  test("a value captured before its credential is sent is dropped from later warnings and the row", async () => {
    const late = secret("late");
    const log = context();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
    let row: RequestLogEntry | undefined;
    try {
      inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: late } }));
      const send = providerFetch({ adapter: "openai-responses", authMode: "key", apiKey: late, baseUrl: "https://upstream.invalid/v1",
        fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch } as never);
      await (await send("https://upstream.invalid/v1/responses", { method: "POST", headers: { authorization: `Bearer ${late}` }, body: "{}" })).text();
      warnings.length = 0;
      noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_after_send" }));
      addFinalRequestLog("late", Date.now(), log, 502, undefined, entry => { row = entry; });
    } finally {
      console.warn = warn;
    }
    expect(warnings.join("\n")).not.toContain(late);
    expect(JSON.stringify(row ?? {})).not.toContain(late);
  });

  test("a plugin-rewritten WebSocket dial credential is registered before the session and fallback", async () => {
    const wsSecret = secret("plugin-ws");
    const bearerSecret = secret("ws-bearer");
    const unregister = registerUpstreamRewriter("ws-cred-fixture", target => {
      if (target.transport !== "websocket") return;
      target.headers.set("x-plugin-ws-credential", wsSecret);
      target.url = "ws://127.0.0.1:1/backend-api/codex/responses";
    });
    try {
      const init = streamingInit();
      (init.headers as Record<string, string>).authorization = `Bearer ${bearerSecret}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses", init,
          (async () => new Response("fallback", { status: 500 })) as typeof fetch);
        await response.text().catch(() => "");
      }
      for (const value of [wsSecret, bearerSecret]) {
        const log = context();
        inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: value } }));
        noteUpstreamRequestId(log, new Headers({ "x-request-id": value }));
        expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(value);
      }
    } finally {
      unregister();
    }
  });

test("OAuth bearers of a reselected account (custom executor, 429 rotation) are both masked", async () => {
    const { saveCredential, getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const tokens = { a: secret("oauth-a"), b: secret("oauth-b") };
    for (const account of ["a", "b"] as const) await saveCredential("github-copilot", {
      access: tokens[account], refresh: `refresh-${account}`, expires: Date.now() + 3_600_000,
      accountId: account, apiBaseUrl: `https://${account}.copilot.invalid`, source: "oauth",
    });
    const rows = getAccountSet("github-copilot")!.accounts;
    await setActiveAccount("github-copilot", rows.find(row => row.credential.accountId === "a")!.id);
    const seen: string[] = [];
    const executor = (async (url, init) => {
      const path = new URL(String(url)).pathname;
      const token = bearer(new Headers(init?.headers)) ?? "";
      if (path === "/models") return Response.json({ data: [{ id: "gpt-4o", model_picker_enabled: true, supported_endpoints: ["/chat/completions"] }] });
      seen.push(token);
      return Response.json({ error: { type: "server_error", code: token, message: "fixture" } },
        { status: seen.length === 1 ? 429 : 503, headers: { "x-request-id": token, "retry-after": "1" } });
    }) as typeof fetch;
    const config = { port: 0, defaultProvider: "github-copilot", providers: { "github-copilot": {
      adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.githubcopilot.com", models: ["gpt-4o"],
      defaultModel: "gpt-4o", selectedModels: ["gpt-4o"], fetch: executor,
    } }, oauthAccountFailover: { enabled: true } } as unknown as OcxConfig;
    await saveConfig(config);
    const log: RequestLogContext = { model: "", provider: "" };
    const warn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    let row: RequestLogEntry | undefined;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "github-copilot/gpt-4o", input: "hello", stream: false }) }), config, log);
      await response.text().catch(() => "");
      addFinalRequestLog("oauth", Date.now(), log, 503, undefined, entry => { row = entry; });
    } finally {
      console.warn = warn;
    }
    expect(seen).toContain(tokens.a);
    expect(seen).toContain(tokens.b);
    for (const token of Object.values(tokens)) {
      expect(`${log.upstreamErrorCode ?? ""} ${log.upstreamRequestId ?? ""}`).not.toContain(token);
      expect(JSON.stringify(row ?? {})).not.toContain(token);
      // The chat path does not record raw upstream codes itself, so prove registration directly:
      // both bearers this request actually sent, before and after reselection, are refused later.
      const later = context();
      inspectResponseLogJson(later, JSON.stringify({ error: { type: "server_error", code: token } }));
      noteUpstreamRequestId(later, new Headers({ "x-request-id": token }));
      expect(`${later.upstreamErrorCode ?? ""} ${later.upstreamRequestId ?? ""}`).not.toContain(token);
    }
  });

  test("safe diagnostics are still recorded after credentials were refused", async () => {
    const key = secret("before-safe");
    await run({ apiKey: key, fetch: echoingExecutor("error", bearer) });
    const log = context();
    noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_safe" }));
    inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: "server_error" } }));
    expect(log.upstreamRequestId).toBe("req_safe");
    expect(log.upstreamErrorCode).toBe("server_error");
  });
});

// ---- #6911: configured credential source (private home per test; no global registry state) ----
describe("configured credential source", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-configured-cred-"));
    process.env.OPENCODEX_HOME = home;
  });
  afterEach(() => {
    setProviderKeychainEntryFactoryForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });
  const writeConfig = (value: unknown) => writeFileSync(join(home, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
  const keychain = (entries: Map<string, string>) => setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => entries.get(account) ?? null,
    setPassword: () => {},
    deletePassword: () => true,
  }));

  test("a keychain that becomes readable restores coverage after the retry delay, without a warning", () => {
    const entries = new Map<string, string>();
    keychain(entries);
    const key = "kc-" + randomBytes(12).toString("hex");
    writeConfig({ providers: { p: { apiKey: "keychain:p" } } });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { warnings.push(String(line)); }) as typeof console.warn;
    try {
      const start = Date.now();
      expect(configuredCredentials(start).complete).toBe(false);
      entries.set("p", key);
      expect(configuredCredentials(start + 1_000).complete).toBe(false);
      const recovered = configuredCredentials(start + INCOMPLETE_RETRY_MS);
      expect(recovered.complete).toBe(true);
      expect(recovered.matches(key)).toBe(true);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
  });

  test("a changed environment reference is picked up without a file change", () => {
    const name = "OCX_6911_CONFIGURED_ENV_KEY";
    const previous = process.env[name];
    try {
      process.env[name] = "env-first-" + randomBytes(8).toString("hex");
      writeConfig({ providers: { p: { apiKey: "$" + "{" + name + "}", headers: { "x-env-header": "$" + name } } } });
      expect(configuredCredentials().matches(process.env[name]!)).toBe(true);
      const first = process.env[name]!;
      process.env[name] = "env-second-" + randomBytes(8).toString("hex");
      expect(configuredCredentials().matches(process.env[name]!)).toBe(true);
      expect(configuredCredentials().matches(first)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("an existing store with an unexpected shape is incomplete; a missing one is not", () => {
    expect(configuredCredentials().complete).toBe(true);
    writeConfig("null");
    expect(configuredCredentials().complete).toBe(false);
    writeConfig({ providers: [] });
    expect(configuredCredentials().complete).toBe(false);
    writeConfig({ providers: {} });
    expect(configuredCredentials().complete).toBe(true);
    writeFileSync(join(home, "auth.json"), "[]");
    expect(configuredCredentials().complete).toBe(false);
  });

  test("only credential fields are collected, not labels such as authMode", () => {
    writeConfig({ providers: { p: { authMode: "oauth", adapter: "openai-responses", apiKey: "configured-key-value" } } });
    const configured = configuredCredentials();
    expect(configured.matches("configured-key-value")).toBe(true);
    for (const label of ["oauth", "openai-responses"]) expect(configured.matches(label)).toBe(false);
  });

  test("the returned view carries no cache metadata or environment values", () => {
    const name = "OCX_6911_VIEW_ENV_KEY";
    const previous = process.env[name];
    try {
      process.env[name] = "env-view-" + randomBytes(8).toString("hex");
      writeConfig({ providers: { p: { apiKey: "$" + name } } });
      const view = configuredCredentials();
      expect(view.matches(process.env[name]!)).toBe(true);
      expect(Object.keys(view).sort()).toEqual(["complete", "matches"]);
      expect(JSON.stringify(view)).not.toContain(process.env[name]!);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
