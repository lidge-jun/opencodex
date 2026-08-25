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
import {
  resetProviderRequestPacingForTest,
  setProviderRequestPacingRuntimeForTest,
  providerRequestPacingStatus,
  type RequestPacingRuntime,
} from "../src/providers/request-pacing";
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

function fastConfig(): OcxConfig {
  const value = config();
  value.providers["google-antigravity"]!.requestPacing = { enabled: false };
  return value;
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
  resetProviderRequestPacingForTest();
  clearAntigravityRoutingState();
  rmSync(home, { recursive: true, force: true });
  delete process.env.OPENCODEX_HOME;
});

describe("Antigravity Responses integration", () => {
  test("a fetchResponse attempt uses its pre-acquired pacing slot only once", async () => {
    let now = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    let nextTimer = 1;
    const runtime: RequestPacingRuntime = {
      now: () => now,
      random: () => 0,
      setTimer: (callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: handle => { timers.delete(handle as number); },
      enqueueMicrotask: callback => callback(),
    };
    setProviderRequestPacingRuntimeForTest(runtime);
    let sends = 0;
    const testConfig = config();
    const provider = testConfig.providers["google-antigravity"]! as OcxConfig["providers"][string] & {
      fetch: typeof globalThis.fetch;
    };
    provider.requestPacing = { enabled: true, minIntervalMs: 100 };
    provider.fetch = (async () => {
      sends += 1;
      return completed();
    }) as typeof globalThis.fetch;

    const pending = handleResponses(request(), testConfig, { model: "", provider: "" }, {});
    const response = await Promise.race([pending, Bun.sleep(100).then(() => null)]);
    expect(response).not.toBeNull();
    if (!response) throw new Error("pacing slot was consumed twice");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
    expect({ sends, queued: providerRequestPacingStatus("google-antigravity", provider).queued, timers: timers.size }).toEqual({ sends: 1, queued: 0, timers: 0 });
    expect(providerRequestPacingStatus("google-antigravity", provider).lastStartedAt).toBe(0);
    expect(timers.size).toBe(0);
  });

  test("an empty-completion continuation uses one pacing admission", async () => {
    let now = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    let nextTimer = 1;
    const runtime: RequestPacingRuntime = {
      now: () => now,
      random: () => 0,
      setTimer: (callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: handle => { timers.delete(handle as number); },
      enqueueMicrotask: callback => callback(),
    };
    const advanceBy = (delayMs: number) => {
      const target = now + delayMs;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    };
    setProviderRequestPacingRuntimeForTest(runtime);
    let sends = 0;
    const testConfig = config();
    testConfig.emptyCompletionRetry = true;
    const provider = testConfig.providers["google-antigravity"]! as OcxConfig["providers"][string] & {
      fetch: typeof globalThis.fetch;
    };
    provider.requestPacing = { enabled: true, minIntervalMs: 100 };
    provider.fetch = (async () => {
      sends += 1;
      return sends === 1
        ? Response.json({ response: { candidates: [{ finishReason: "STOP" }] } })
        : completed();
    }) as typeof globalThis.fetch;

    const pending = handleResponses(request(), testConfig, { model: "", provider: "" }, {});
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    expect(sends).toBe(1);
    advanceBy(100);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(sends).toBe(2);
    expect(providerRequestPacingStatus("google-antigravity", provider).queued).toBe(0);
    expect(timers.size).toBe(0);
    expect((await pending).status).toBe(200);
  });

  test("selects the Google adapter and observes a CCA SSE error before returning it", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return new Response(`data: ${JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } })}\n\n`, {
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
    expect(getAntigravityAccountHealthSnapshot(accountId)).toMatchObject({ cooldownSource: "synthetic", cooldownKind: "quota" });
  });

  test("preserves 403 after a geoblock arrives as a 200 SSE error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(`data: ${JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Location is not supported" } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const first = await handleResponses(request(true), fastConfig(), { model: "", provider: "" }, {});
    expect(first.status).toBe(200);
    await first.text();
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    expect(getAntigravityAccountHealthSnapshot(accountId)).toMatchObject({ cooldownKind: "geoblock" });
    const second = await handleResponses(request(), fastConfig(), { model: "", provider: "" }, {});
    expect(second.status).toBe(403);
    expect(calls).toBe(1);
  });

  test("records cooldowns for actual Google envelopes in streaming and buffered Responses", async () => {
    const cases = [
      { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", source: "quota" },
      { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limit exceeded", source: "rate-limit" },
      { code: 403, status: "PERMISSION_DENIED", message: "Location is not supported", source: "geoblock" },
    ] as const;
    for (const stream of [true, false]) {
      for (const expected of cases) {
        clearAntigravityRoutingState();
        globalThis.fetch = (async () => {
          const payload = { error: { code: expected.code, status: expected.status, message: expected.message } };
          return stream
            ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
            : Response.json(payload);
        }) as typeof fetch;
        const response = await handleResponses(request(stream), fastConfig(), { model: "", provider: "" }, {});
        expect(response.status).toBe(200);
        const accountId = getAccountSet("google-antigravity")!.activeAccountId;
        expect(getAntigravityAccountHealthSnapshot(accountId)).toMatchObject({ cooldownSource: "synthetic", cooldownKind: expected.source });
      }
    }
  });

  test("serializes a redacted inline error to Responses clients", async () => {
    const message = "Bearer secret-token api_key=secret-api https://user:secret-password@example.test/path?api_key=secret-url";
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
    const response = await handleResponses(request(true), fastConfig(), { model: "", provider: "" }, {});
    const serialized = await response.text();
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-api");
    expect(serialized).not.toContain("secret-url");
    expect(serialized).not.toContain("secret-password");
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

  test("fails closed when the selected OAuth snapshot has no project", async () => {
    await saveCredential("google-antigravity", {
      access: "access-without-project",
      refresh: "refresh-without-project",
      expires: Date.now() + 3600_000,
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return completed();
    }) as typeof fetch;
    const response = await handleResponses(request(), config(), { model: "", provider: "" }, {});
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("rejects an explicit ai-studio mode before using stale Antigravity project config", async () => {
    const testConfig = config();
    testConfig.providers["google-antigravity"]!.googleMode = "ai-studio";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return completed();
    }) as typeof fetch;

    const response = await handleResponses(request(), testConfig, { model: "", provider: "" }, {});
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

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
    const projects: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fresh-b", refresh_token: "refresh-b", expires_in: 3600 });
      }
      inferenceCalls += 1;
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      projects.push((JSON.parse(String(init?.body)) as { project?: string }).project ?? "");
      return inferenceCalls === 1 ? new Response("expired", { status: 401 }) : completed();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx, {});
    expect(response.status).toBe(200);
    expect(bearers).toEqual(["Bearer access-b", "Bearer fresh-b"]);
    expect(projects).toEqual(["project-b", "project-b"]);
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
  test("records 403 HTTP geoblock cooldown and returns 403 on subsequent requests", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "User location is not supported" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const first = await handleResponses(request(), fastConfig(), { model: "", provider: "" }, {});
    expect(first.status).toBe(403);
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    expect(getAntigravityAccountHealthSnapshot(accountId)).toMatchObject({ cooldownKind: "geoblock" });
    const second = await handleResponses(request(), fastConfig(), { model: "", provider: "" }, {});
    expect(second.status).toBe(403);
    expect(calls).toBe(1);
  });
