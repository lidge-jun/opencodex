import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokConversationSessionId, withGrokSessionIdentity } from "../../../src/grok/session-identity";
import { handleResponses } from "../../../src/server/responses/core";
import { tryAdmitTurn } from "../../../src/server/lifecycle";
import type { OcxConfig } from "../../../src/types";
import { fakeChatGptJwt } from "../../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { repoPath } from "../../helpers/repo-root";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";

const CONVERSATION = "01a0ffed-6c20-7492-aff0-c9219016f2fb";

function grokHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-opencodex-grok": "1",
    "x-grok-conv-id": CONVERSATION,
    "x-grok-session-id": CONVERSATION,
    ...extra,
  });
}

describe("grokConversationSessionId", () => {
  test("promotes the Grok conversation id on the managed Grok surface", () => {
    expect(grokConversationSessionId(grokHeaders())).toBe(CONVERSATION);
    expect(grokConversationSessionId(grokHeaders({ "x-grok-conv-id": "turn-summary-30bdd565-07f0-4729-a4bc-1d292fa4bf89" })))
      .toBe("turn-summary-30bdd565-07f0-4729-a4bc-1d292fa4bf89");
  });

  test("leaves non-Grok callers alone", () => {
    const headers = grokHeaders();
    headers.delete("x-opencodex-grok");
    expect(grokConversationSessionId(headers)).toBeUndefined();
  });

  for (const explicit of ["session_id", "session-id", "thread-id"]) {
    test(`an explicit ${explicit} header wins`, () => {
      expect(grokConversationSessionId(grokHeaders({ [explicit]: "caller" }))).toBeUndefined();
    });
  }

  test("ignores empty and unsafe conversation ids", () => {
    // Grok's title request sends the header empty.
    expect(grokConversationSessionId(grokHeaders({ "x-grok-conv-id": "" }))).toBeUndefined();
    expect(grokConversationSessionId(grokHeaders({ "x-grok-conv-id": "a b" }))).toBeUndefined();
    expect(grokConversationSessionId(grokHeaders({ "x-grok-conv-id": "x".repeat(200) }))).toBeUndefined();
  });

  test("the rewritten request keeps its body and abort signal", async () => {
    const controller = new AbortController();
    const original = new Request("http://localhost/v1/responses", {
      method: "POST", headers: grokHeaders(), body: "{\"a\":1}", signal: controller.signal,
    });
    const rewritten = withGrokSessionIdentity(original);
    expect(rewritten.headers.get("session_id")).toBe(CONVERSATION);
    expect(original.headers.has("session_id")).toBe(false);
    controller.abort();
    expect(rewritten.signal.aborted).toBe(true);
    expect(await rewritten.text()).toBe("{\"a\":1}");
  });

  test("returns the same request when nothing is promoted", () => {
    const original = new Request("http://localhost/v1/responses", { method: "POST", body: "{}" });
    expect(withGrokSessionIdentity(original)).toBe(original);
  });
});

describe("Grok turns reach the ChatGPT Codex backend with session_id", () => {
  const originalFetch = globalThis.fetch;
  let isolated: IsolatedCodexHome;
  let home: string;
  let previousHome: string | undefined;
  let releaseSpendHome: (() => void) | undefined;
  let token = "";

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-grok-session-"));
    process.env.OPENCODEX_HOME = home;
    isolated = installIsolatedCodexHome("ocx-grok-session-codex-");
    token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-grok-main" });
    writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "fixture-grok-main" } }));
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

  test("the upstream request carries the Grok conversation as session_id", async () => {
    const cfg = { openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "resp_grok", object: "response", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }) as typeof fetch;
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const req = withGrokSessionIdentity(new Request("http://localhost/v1/responses", {
        method: "POST", headers: grokHeaders({ authorization: `Bearer ${token}` }),
        body: JSON.stringify({ model: "openai/gpt-5.6-luna", stream: false, store: false, prompt_cache_key: CONVERSATION, input: "ping" }),
      }));
      const logCtx = { model: "", provider: "" } as Parameters<typeof handleResponses>[2];
      const response = await handleResponses(req, cfg, logCtx, { turnAdmissionLease: lease!, admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses" });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const wire = seen.at(-1)!;
      expect(wire.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(wire.headers.get("session_id")).toBe(CONVERSATION);
      expect(wire.body.prompt_cache_key).toBe(CONVERSATION);
      expect(logCtx.conversationId).toBeTruthy();
    } finally { lease?.release(); }
  });
});

test("the /v1/responses route hands handleResponses the Grok-promoted request", () => {
  // Pins the one-line wiring; the cases above call the helper directly.
  const source = readFileSync(repoPath("src", "server", "index", "serve-options.ts"), "utf8");
  expect(source).toContain("await handleResponses(withGrokSessionIdentity(req), config, logCtx, {");
});
