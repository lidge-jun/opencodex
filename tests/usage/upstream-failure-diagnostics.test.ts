import { expect, test } from "bun:test";
import { afterEach, beforeEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import { OutboundCredentialRegistry, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";
import { diagnosticValueAllowed } from "../../src/server/request-log-terminal-status";
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
describe("outbound credential registry", () => {
  test("records sent values but not denylisted non-credential headers", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember({ "X-Gateway-Credential": "gw-secret-value", "content-type": "application/json",
      "user-agent": "agent/1.0", "x-request-id": "req_123", "openai-beta": "responses=v1" });
    expect(reg.matches("gw-secret-value")).toBe(true);
    for (const value of ["application/json", "agent/1.0", "req_123", "responses=v1"]) expect(reg.matches(value)).toBe(false);
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
  test("exact match at any length, substring only for credentials of 12 chars or more", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember({ "x-a": "k", "x-b": "elevenchars", "x-c": "twelve-chars" });
    expect(reg.matches("k")).toBe(true);
    expect(reg.matches("elevenchars")).toBe(true);
    expect(reg.matches("xxelevencharsxx")).toBe(false);
    expect(reg.matches("xxtwelve-charsxx")).toBe(true);
    const cls = new OutboundCredentialRegistry();
    cls.remember({ "x-api-key": "server_error" });
    expect(diagnosticValueAllowed("upstreamErrorCode", "server_error", cls)).toBe(false);
  });
  test("entry and byte bounds evict in LRU order and mark coverage incomplete", () => {
    const reg = new OutboundCredentialRegistry({ maxEntries: 2 });
    reg.remember({ "x-1": "value-one" });
    reg.remember({ "x-2": "value-two" });
    reg.remember({ "x-1": "value-one" });
    expect(reg.complete()).toBe(true);
    reg.remember({ "x-3": "value-three" });
    expect(reg.complete()).toBe(false);
    expect(reg.matches("value-two")).toBe(false);
    expect(reg.matches("value-one")).toBe(true);
    const bytes = new OutboundCredentialRegistry({ maxBytes: 10 });
    bytes.remember({ "x-1": "123456" });
    bytes.remember({ "x-2": "abcdef" });
    expect(bytes.complete()).toBe(false);
    const big = new OutboundCredentialRegistry({ maxValueBytes: 4 });
    big.remember({ "x-1": "12345" });
    expect(big.complete()).toBe(false);
    expect(big.matches("12345")).toBe(false);
  });
  test("Request headers without init are read case-insensitively", () => {
    const reg = new OutboundCredentialRegistry();
    reg.remember(new Request("https://upstream.invalid/x", { headers: { "X-Api-Key": "request-key-value" } }).headers);
    expect(reg.matches("request-key-value")).toBe(true);
  });
});

describe("diagnostic wiring against a swapped registry", () => {
  test("a value captured before eviction is dropped from later warnings and the row, while type and status remain", () => {
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
      reg.remember({ "x-1": "first-value" });
      reg.remember({ "x-2": "second-value" });
      expect(reg.complete()).toBe(false);
      warnings.length = 0;
      noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_later" }));
      addFinalRequestLog("wiring", Date.now(), log, httpStatusForRequestLogTerminal("failed", log), undefined, entry => { row = entry; });
      expect(warnings.length).toBe(0);
      expect(log.upstreamRequestId).toBeUndefined();
      expect(row!.upstreamErrorCode).toBeUndefined();
      expect(row!.upstreamErrorType).toBe("overloaded_error");
      expect(row!.status).toBe(statusBefore);
    } finally {
      console.warn = warn;
      restore();
    }
  });
  test("an incomplete registry fails closed for new code and request ids but keeps the type vocabulary", () => {
    const reg = new OutboundCredentialRegistry({ maxValueBytes: 1 });
    reg.remember({ "x-1": "too-long" });
    const restore = setOutboundCredentialRegistryForTests(reg);
    const warn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    try {
      const log = context();
      noteUpstreamRequestId(log, new Headers({ "x-request-id": "req_safe" }));
      inspectResponseLogJson(log, JSON.stringify({ error: { type: "server_error", code: "server_error" } }));
      expect(log.upstreamRequestId).toBeUndefined();
      expect(log.upstreamErrorCode).toBeUndefined();
      expect(log.upstreamErrorType).toBe("server_error");
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
  const run = async (provider: Record<string, unknown>) => {
    const config = { port: 0, defaultProvider: "echo", providers: { echo: { adapter: "openai-responses", authMode: "key",
      baseUrl: "https://upstream.invalid/v1", models: ["fixture-model"], defaultModel: "fixture-model", ...provider } } } as unknown as OcxConfig;
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
