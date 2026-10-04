import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerSessionId, withCallerSessionIdentity } from "../../src/server/caller-session-identity";
import { resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { clearComboRecallForTests, recallComboForLane, rememberComboForLane } from "../../src/server/responses/combo-session-recall";
import { withGrokSessionIdentity } from "../../src/grok/session-identity";
import { handleResponses } from "../../src/server/responses/core";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const LOOPBACK = { kind: "loopback", source: "loopback" } as const;
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

function callerHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-session-id": SESSION,
    ...extra,
  });
}

describe("callerSessionId", () => {
  test("promotes the caller's x-session-id when no session header is present", () => {
    expect(callerSessionId(callerHeaders())).toBe(SESSION);
    expect(callerSessionId(callerHeaders({ "x-session-id": `sess-${SESSION}` }))).toBe(`sess-${SESSION}`);
  });

  test("does nothing when the caller sent no x-session-id", () => {
    const headers = callerHeaders();
    headers.delete("x-session-id");
    expect(callerSessionId(headers)).toBeUndefined();
  });

  for (const explicit of ["session_id", "session-id", "thread-id"]) {
    test(`an explicit ${explicit} header wins`, () => {
      for (const value of ["caller", ""]) {
        const req = new Request("http://localhost/v1/responses", { headers: callerHeaders({ [explicit]: value }) });
        expect(callerSessionId(req.headers)).toBeUndefined();
        expect(withCallerSessionIdentity(req, LOOPBACK)).toBe(req);
        expect(req.headers.get(explicit)).toBe(value);
      }
    });
  }

  test("ignores empty and unsafe session ids", () => {
    expect(callerSessionId(callerHeaders({ "x-session-id": "" }))).toBeUndefined();
    expect(callerSessionId(callerHeaders({ "x-session-id": "a b" }))).toBeUndefined();
    expect(callerSessionId(callerHeaders({ "x-session-id": "x".repeat(200) }))).toBeUndefined();
  });

  test("normalizes whitespace and enforces the exact length and character boundaries", () => {
    expect(callerSessionId(callerHeaders({ "x-session-id": `  ${SESSION}  ` }))).toBe(SESSION);
    expect(callerSessionId(callerHeaders({ "x-session-id": "a".repeat(128) }))).toBe("a".repeat(128));
    for (const value of ["a".repeat(129), ".abc", "_abc", ":abc", "-abc", "a/b", "a,b", "é", "   "]) {
      const req = new Request("http://localhost/v1/responses", { headers: callerHeaders({ "x-session-id": value }) });
      expect(callerSessionId(req.headers)).toBeUndefined();
      expect(withCallerSessionIdentity(req, LOOPBACK)).toBe(req);
    }
    expect(callerSessionId(callerHeaders({ "x-session-id": "A0.b_c:d-e" }))).toBe("A0.b_c:d-e");
  });

  test("the rewritten request keeps its body and abort signal", async () => {
    const controller = new AbortController();
    const original = new Request("http://localhost/v1/responses", {
      method: "POST", headers: callerHeaders(), body: "{\"a\":1}", signal: controller.signal,
    });
    const rewritten = withCallerSessionIdentity(original, LOOPBACK);
    expect(rewritten.headers.get("session_id")).toBe(SESSION);
    expect(original.headers.has("session_id")).toBe(false);
    expect(rewritten.method).toBe(original.method);
    expect(rewritten.url).toBe(original.url);
    expect(rewritten.bodyUsed).toBe(false);
    controller.abort();
    expect(rewritten.signal.aborted).toBe(true);
    expect(await rewritten.text()).toBe("{\"a\":1}");
  });

  test("returns the same request when nothing is promoted", () => {
    const original = new Request("http://localhost/v1/responses", { method: "POST", body: "{}" });
    expect(withCallerSessionIdentity(original, LOOPBACK)).toBe(original);
  });

  test("composes after the Grok promotion without double-writing", () => {
    const grok = withGrokSessionIdentity(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: new Headers({ "x-opencodex-grok": "1", "x-grok-conv-id": SESSION, "x-session-id": "different-caller" }),
      body: "{}",
    }));
    const composed = withCallerSessionIdentity(grok, LOOPBACK);
    expect(composed).toBe(grok);
    expect(composed.headers.get("session_id")).toBe(SESSION);
    expect(composed.headers.get("x-grok-conv-id")).toBe(SESSION);
  });
});

describe("Non-Codex callers reach the ChatGPT Codex backend with session_id", () => {
  const originalFetch = globalThis.fetch;
  let isolated: IsolatedCodexHome;
  let home: string;
  let previousHome: string | undefined;
  let releaseSpendHome: (() => void) | undefined;
  let token = "";

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-caller-session-"));
    process.env.OPENCODEX_HOME = home;
    isolated = installIsolatedCodexHome("ocx-caller-session-codex-");
    token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-caller-main" });
    writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "fixture-caller-main" } }));
    releaseSpendHome = acquireOwnedSpendHome();
  });
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    isolated.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("the upstream request carries the promoted session_id", async () => {
    const cfg = { openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== "https://chatgpt.com/backend-api/codex/responses") {
        throw new Error("Unexpected outbound request in caller-session fixture");
      }
      seen.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
      return Response.json({ id: "resp_caller", object: "response", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() { /* No fixture opens an upstream socket. */ } });
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const req = withCallerSessionIdentity(new Request("http://localhost/v1/responses", {
        method: "POST", headers: callerHeaders({ authorization: `Bearer ${token}` }),
        body: JSON.stringify({ model: "openai/gpt-5.6-luna", stream: false, store: false, input: "ping" }),
      }), LOOPBACK);
      const logCtx = { model: "", provider: "" } as Parameters<typeof handleResponses>[2];
      const response = await handleResponses(req, cfg, logCtx, { turnAdmissionLease: lease!, admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses" });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const wire = seen.at(-1)!;
      expect(wire.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(wire.headers.get("session_id")).toBe(SESSION);
      expect(logCtx.conversationId).toBeTruthy();
    } finally { lease?.release(); }
  });
});

test("the public routes hand their handlers the caller-promoted request", () => {
  // Pins the two-line wiring; the cases above call the helper directly.
  const source = readFileSync(repoPath("src", "server", "index", "serve-options.ts"), "utf8");
  expect(source).toContain("const sessionReq = withCallerSessionIdentity(withGrokSessionIdentity(req), admission);");
  expect(source).toContain("await handleResponses(sessionReq, config, logCtx, {");
  expect(source).toContain("const sessionReq = withCallerSessionIdentity(req, admission);");
  expect(source).toContain("await handleClaudeMessages(sessionReq, config, logCtx,");
  expect(source.match(/const sessionReq = withCallerSessionIdentity/g)).toHaveLength(2);
});

function admitted(key: string, source: "dedicated" | "bearer" = "dedicated"): DataPlaneAdmission {
  const result = resolveDataPlaneAdmissionSecret(key, { apiKeys: [{ id: "same-key-id", name: "Caller fixture", createdAt: "2026-01-01T00:00:00.000Z", key }] }, source);
  expect(result).not.toBeNull();
  return result!;
}

function promoted(admission: DataPlaneAdmission, conversation = SESSION): Request {
  return withCallerSessionIdentity(new Request("http://localhost/v1/responses", {
    headers: callerHeaders({ "x-session-id": conversation }),
  }), admission);
}

describe("trusted caller namespaces", () => {
  test("equal caller markers separate credentials and remain stable across credential transports", () => {
    const first = promoted(admitted("caller-fixture-key-a")).headers.get("session_id");
    const second = promoted(admitted("caller-fixture-key-b")).headers.get("session_id");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(SESSION);
    expect(promoted(admitted("caller-fixture-key-a", "bearer")).headers.get("session_id")).toBe(first);
    expect(promoted(admitted("caller-fixture-key-a"), "another-conversation").headers.get("session_id")).not.toBe(first);
  });

  test("environment credentials rotate into a fresh namespace", () => {
    const previous = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.OPENCODEX_API_AUTH_TOKEN = "caller-environment-fixture-a";
      const first = resolveDataPlaneAdmissionSecret(process.env.OPENCODEX_API_AUTH_TOKEN, {})!;
      process.env.OPENCODEX_API_AUTH_TOKEN = "caller-environment-fixture-b";
      const rotated = resolveDataPlaneAdmissionSecret(process.env.OPENCODEX_API_AUTH_TOKEN, {})!;
      expect(first.kind).toBe("environment");
      expect(promoted(rotated).headers.get("session_id")).not.toBe(promoted(first).headers.get("session_id"));
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = previous;
    }
  });

  test("unknown principals decline promotion despite caller-supplied identity claims", () => {
    for (const admission of [{ kind: "configured", keyId: "known-id", source: "dedicated" },
      { kind: "environment", source: "bearer" }] satisfies DataPlaneAdmission[]) {
      const request = new Request("http://localhost/v1/responses", { headers: callerHeaders({
        authorization: "Bearer untrusted-fixture", "x-context-principal-id": "spoofed-principal",
      }) });
      expect(withCallerSessionIdentity(request, admission)).toBe(request);
    }
  });

  test("real combo recall separates equal markers across principals and keeps same-principal continuity", () => {
    clearComboRecallForTests();
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-responses", baseUrl: "https://fixture.example.test/v1" },
    }, combos: { alpha: { targets: [{ provider: "fixture", model: "model-a" }] },
      beta: { targets: [{ provider: "fixture", model: "model-b" }] } } };
    const lane = (key: string) => sessionLaneIdFromRequest(promoted(admitted(key)).headers);
    try {
      rememberComboForLane(lane("recall-fixture-a"), "alpha", { provider: "fixture", model: "model-a" }, "visible-model", captureConfigGeneration());
      expect(recallComboForLane(config, lane("recall-fixture-a"), "visible-model")).toBe("alpha");
      expect(recallComboForLane(config, lane("recall-fixture-b"), "visible-model")).toBeUndefined();
      rememberComboForLane(lane("recall-fixture-b"), "beta", { provider: "fixture", model: "model-b" }, "visible-model", captureConfigGeneration());
      expect(recallComboForLane(config, lane("recall-fixture-a"), "visible-model")).toBe("alpha");
      expect(recallComboForLane(config, lane("recall-fixture-b"), "visible-model")).toBe("beta");
      expect(recallComboForLane(config, lane("recall-fixture-rotated"), "visible-model")).toBeUndefined();
    } finally { clearComboRecallForTests(); }
  });
});
