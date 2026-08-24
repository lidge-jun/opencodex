import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";
import { clearAntigravityRoutingState, getAntigravityAccountHealthSnapshot } from "../src/oauth/antigravity-routing";
import { getAccountSet } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let home = "";

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        ...structuredClone(OAUTH_PROVIDERS["google-antigravity"]!.providerConfig),
        liveModels: false,
        defaultModel: "gemini-3.7-flash",
        project: "test-project",
      },
    },
  } as OcxConfig;
}

function request(stream = false, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream }),
    signal,
  });
}

function completed(): Response {
  return Response.json({ response: { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] } });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-antigravity-responses-"));
  process.env.OPENCODEX_HOME = home;
  clearAntigravityRoutingState();
  await saveCredential("google-antigravity", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3600_000,
    projectId: "project-a",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAntigravityRoutingState();
  rmSync(home, { recursive: true, force: true });
  delete process.env.OPENCODEX_HOME;
});

describe("Antigravity Responses integration", () => {
  test("selects the Google adapter and observes a CCA SSE error before returning it", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return new Response(`data: ${JSON.stringify({ error: { code: "RESOURCE_EXHAUSTED", status: 429, message: "quota exceeded" } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(true), config(), logCtx, {});
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(await response.text()).toContain("quota exceeded");
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    expect(getAntigravityAccountHealthSnapshot(accountId)?.cooldownSource).toBe("synthetic");
  });

  test("replays a short 429 once through the same Google adapter", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
        : completed();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx, {});
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  }, 15_000);

  test("replays one 401 with the selected account generation", async () => {
    await saveCredential("google-antigravity", {
      access: "access-b",
      refresh: "refresh-b",
      expires: Date.now() + 3600_000,
      projectId: "project-b",
      email: "b@example.test",
      accountId: "account-b",
    });
    let inferenceCalls = 0;
    const bearers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fresh-b", refresh_token: "refresh-b", expires_in: 3600 });
      }
      inferenceCalls += 1;
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return inferenceCalls === 1 ? new Response("expired", { status: 401 }) : completed();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx, {});
    expect(response.status).toBe(200);
    expect(bearers).toEqual(["Bearer access-b", "Bearer fresh-b"]);
    expect(inferenceCalls).toBe(2);
  }, 15_000);

  test("cancels the bounded 429 wait before dispatching a replay", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "5" } });
    }) as typeof fetch;
    setTimeout(() => controller.abort(), 500);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const testConfig = config();
    testConfig.providers["google-antigravity"]!.requestPacing = { enabled: false };
    const response = await handleResponses(request(false, {}, controller.signal), testConfig, logCtx, {
      abortSignal: controller.signal,
    });
    expect(response.status).toBe(499);
    expect(calls).toBe(1);
  }, 10_000);
});
