import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerSessionId, withCallerSessionIdentity } from "../../src/server/caller-session-identity";
import { withGrokSessionIdentity } from "../../src/grok/session-identity";
import { handleResponses } from "../../src/server/responses/core";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

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
      expect(callerSessionId(callerHeaders({ [explicit]: "caller" }))).toBeUndefined();
    });
  }

  test("ignores empty and unsafe session ids", () => {
    expect(callerSessionId(callerHeaders({ "x-session-id": "" }))).toBeUndefined();
    expect(callerSessionId(callerHeaders({ "x-session-id": "a b" }))).toBeUndefined();
    expect(callerSessionId(callerHeaders({ "x-session-id": "x".repeat(200) }))).toBeUndefined();
  });

  test("the rewritten request keeps its body and abort signal", async () => {
    const controller = new AbortController();
    const original = new Request("http://localhost/v1/responses", {
      method: "POST", headers: callerHeaders(), body: "{\"a\":1}", signal: controller.signal,
    });
    const rewritten = withCallerSessionIdentity(original);
    expect(rewritten.headers.get("session_id")).toBe(SESSION);
    expect(original.headers.has("session_id")).toBe(false);
    controller.abort();
    expect(rewritten.signal.aborted).toBe(true);
    expect(await rewritten.text()).toBe("{\"a\":1}");
  });

  test("returns the same request when nothing is promoted", () => {
    const original = new Request("http://localhost/v1/responses", { method: "POST", body: "{}" });
    expect(withCallerSessionIdentity(original)).toBe(original);
  });

  test("composes after the Grok promotion without double-writing", () => {
    const grok = withGrokSessionIdentity(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: new Headers({ "x-opencodex-grok": "1", "x-grok-conv-id": SESSION }),
      body: "{}",
    }));
    const composed = withCallerSessionIdentity(grok);
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
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "resp_caller", object: "response", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }) as typeof fetch;
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const req = withCallerSessionIdentity(new Request("http://localhost/v1/responses", {
        method: "POST", headers: callerHeaders({ authorization: `Bearer ${token}` }),
        body: JSON.stringify({ model: "openai/gpt-5.6-luna", stream: false, store: false, input: "ping" }),
      }));
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
  expect(source).toContain("await handleResponses(withCallerSessionIdentity(withGrokSessionIdentity(req)), config, logCtx, {");
  expect(source).toContain("await handleClaudeMessages(withCallerSessionIdentity(req), config, logCtx,");
});
