import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../src/codex/subagent-model-fallback";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  flushPendingResponseSpillsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
  type ResponseStateMetrics,
} from "../src/responses/state";
import { responseSpillDirectory } from "../src/responses/spill-store";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const EXPIRED_AGE_MS = 2 * 60 * 60 * 1_000;
const REPLAY_TTL_MS = 60 * 60 * 1_000;
const FIRST_RESPONSE_ID = "resp_issue_702_first";
const HISTORICAL_USER_SENTINEL = "issue-702 historical user context";
const HISTORICAL_ASSISTANT_SENTINEL = "issue-702 historical assistant context";
const CURRENT_USER_SENTINEL = "issue-702 current continuation delta";

let testHome = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;

interface CapturedUpstreamRequest {
  path: string;
  body: Record<string, unknown>;
}

interface ForwardScenario {
  firstStatus: number;
  secondStatus: number;
  secondResponseText: string;
  stateBeforeResume: ResponseStateMetrics;
  upstreamRequests: CapturedUpstreamRequest[];
}

type ForwardScenarioMode = "expired" | "fresh" | "ordinary";

function forwardConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function inputMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function completedSse(responseId: string, text: string): string {
  const item = {
    id: `msg_${responseId}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    "event: response.output_item.done",
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        model: "gpt-5.5",
        output: [item],
      },
    })}`,
    "",
    "",
  ].join("\n");
}

async function waitForRecordedResponseState(): Promise<ResponseStateMetrics> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    const metrics = responseStateMetrics();
    if (metrics.count === 1) return metrics;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("first forward response was not recorded in local replay state");
}

async function runForwardScenario(
  mode: ForwardScenarioMode,
  resumeHeaders: Record<string, string> = {},
): Promise<ForwardScenario> {
  const upstreamRequests: CapturedUpstreamRequest[] = [];
  const realNow = Date.now;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let server: ReturnType<typeof startServer> | null = null;

  try {
    upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        upstreamRequests.push({ path, body });
        const attempt = upstreamRequests.length;
        const responseId = attempt === 1 ? FIRST_RESPONSE_ID : "resp_issue_702_resumed";
        const text = attempt === 1 ? HISTORICAL_ASSISTANT_SENTINEL : "resumed without prior context";
        return new Response(completedSse(responseId, text), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const upstreamUrl = upstream.url;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, upstreamUrl);
        return originalFetch(target, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    saveConfig(forwardConfig());
    server = startServer(0);
    const token = fakeChatGptJwt({ chatgpt_account_id: "acct-issue-702" });
    const requestHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-issue-702",
    };

    let firstStatus = 0;
    try {
      if (mode === "expired") Date.now = () => realNow() - EXPIRED_AGE_MS;
      const firstResponse = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [inputMessage(HISTORICAL_USER_SENTINEL)],
          stream: true,
          store: false,
        }),
      });
      firstStatus = firstResponse.status;
      await firstResponse.text();
      if (mode !== "ordinary") await waitForRecordedResponseState();
    } finally {
      Date.now = realNow;
    }

    const stateBeforeResume = responseStateMetrics();
    if (mode === "ordinary") {
      return {
        firstStatus,
        secondStatus: 0,
        secondResponseText: "",
        stateBeforeResume,
        upstreamRequests,
      };
    }
    const secondResponse = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { ...requestHeaders, ...resumeHeaders },
      body: JSON.stringify({
        model: "gpt-5.5",
        previous_response_id: FIRST_RESPONSE_ID,
        input: [inputMessage(CURRENT_USER_SENTINEL)],
        stream: true,
        store: false,
      }),
    });
    const secondStatus = secondResponse.status;
    const secondResponseText = await secondResponse.text();

    return {
      firstStatus,
      secondStatus,
      secondResponseText,
      stateBeforeResume,
      upstreamRequests,
    };
  } finally {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
    try {
      await server?.stop(true);
    } finally {
      await upstream?.stop(true);
    }
  }
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-issue-702-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  clearResponseStateMemoryForTests();
  resetSubagentModelFallbackStateForTests();
  isolatedCodexHome = installIsolatedCodexHome("ocx-issue-702-codex-");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearResponseStateForTests();
  setResponseStateByteCapForTests(null);
  resetSubagentModelFallbackStateForTests();
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
});

describe("Issue #702 expired forward replay state", () => {
  test("known continuation spill failure returns terminal structured previous_response_not_found before upstream I/O", async () => {
    const responseId = "resp_issue_702_missing_spill";
    setResponseStateByteCapForTests(1_024);
    rememberResponseState(
      { model: "openai/gpt-5.5", input: "x".repeat(8_000), store: false },
      { id: responseId, status: "completed", output: [{ role: "assistant", content: "done" }] },
      undefined,
      { force: true },
    );
    // Windows publishes spills asynchronously; the case is about a spill that later goes
    // MISSING, so let the publication settle before deleting it.
    await flushPendingResponseSpillsForTests();
    const spillDir = responseSpillDirectory(testHome);
    const spill = readdirSync(spillDir).find(name => name.endsWith(".spill.json"));
    expect(spill).toBeDefined();
    unlinkSync(join(spillDir, spill!));

    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      throw new Error("upstream must not be called");
    }) as typeof fetch;
    const routeClasses: Array<{ config: OcxConfig; model: string }> = [
      { config: forwardConfig(), model: "gpt-5.5" },
      {
        config: {
          port: 0,
          hostname: "127.0.0.1",
          openaiProviderTierVersion: 2,
          defaultProvider: "kiro-test",
          providers: {
            "kiro-test": {
              adapter: "kiro",
              baseUrl: "https://runtime.us-east-1.kiro.dev",
              authMode: "key",
              apiKey: "synthetic-token",
              models: ["gpt-5.5"],
            },
          },
        } as OcxConfig,
        model: "kiro-test/gpt-5.5",
      },
      {
        config: {
          port: 0,
          hostname: "127.0.0.1",
          openaiProviderTierVersion: 2,
          defaultProvider: "test-openai",
          providers: {
            "test-openai": {
              adapter: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authMode: "key",
              apiKey: "provider-key",
              models: ["gpt-5.5"],
            },
          },
        } as OcxConfig,
        model: "test-openai/gpt-5.5",
      },
    ];

    try {
      for (const routeClass of routeClasses) {
        saveConfig(routeClass.config);
        const server = startServer(0);
        try {
          const response = await originalFetch(new URL("/v1/responses", server.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: routeClass.model,
              previous_response_id: responseId,
              input: [inputMessage(CURRENT_USER_SENTINEL)],
              stream: true,
            }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: {
              message: "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
              type: "invalid_request_error",
              code: "previous_response_not_found",
            },
          });
        } finally {
          await server.stop(true);
        }
      }
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Three route classes, each binding a real proxy: the per-class servers ARE the
    // assertion that no route reaches upstream, and they measured ~6s against Bun's
    // 5s default.
  }, SERVER_BUDGET_MS);

  test("forward mode fails closed when previous response replay state has expired", async () => {
    let quotaPrimeCalls = 0;
    setSubagentQuotaPrimeForTests(async () => {
      quotaPrimeCalls += 1;
    });
    const scenario = await runForwardScenario("expired", {
      "x-openai-subagent": "collab_spawn",
    });

    expect(scenario.firstStatus).toBe(200);
    expect(scenario.stateBeforeResume.count).toBe(1);
    expect(scenario.stateBeforeResume.oldestAgeMs).toBeGreaterThan(REPLAY_TTL_MS);
    expect(quotaPrimeCalls).toBe(0);
    expect(scenario.upstreamRequests).toHaveLength(1);
    expect(scenario.secondStatus).toBe(400);
    expect(JSON.parse(scenario.secondResponseText)).toMatchObject({
      error: {
        message: expect.stringMatching(/continuation state.*expired/i),
        type: "invalid_request_error",
        code: "invalid_request_error",
      },
    });
  });

  test("forward mode expands fresh replay state before continuing upstream", async () => {
    const scenario = await runForwardScenario("fresh");

    expect(scenario.firstStatus).toBe(200);
    expect(scenario.stateBeforeResume.count).toBe(1);
    expect(scenario.stateBeforeResume.oldestAgeMs).toBeLessThan(REPLAY_TTL_MS);
    expect(scenario.secondStatus).toBe(200);
    expect(scenario.upstreamRequests).toHaveLength(2);

    const resumedRequest = scenario.upstreamRequests[1]!;
    const serialized = JSON.stringify(resumedRequest.body);
    expect(resumedRequest.path).toBe("/responses");
    expect(resumedRequest.body.previous_response_id).toBeUndefined();
    expect(serialized).toContain(HISTORICAL_USER_SENTINEL);
    expect(serialized).toContain(HISTORICAL_ASSISTANT_SENTINEL);
    expect(serialized).toContain(CURRENT_USER_SENTINEL);
  });

  test("forward mode still sends an ordinary request without previous_response_id", async () => {
    const scenario = await runForwardScenario("ordinary");

    expect(scenario.firstStatus).toBe(200);
    expect(scenario.upstreamRequests).toHaveLength(1);
    expect(scenario.upstreamRequests[0]!.path).toBe("/responses");
    expect(scenario.upstreamRequests[0]!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(scenario.upstreamRequests[0]!.body)).toContain(HISTORICAL_USER_SENTINEL);
  });

  test("API-key Responses providers can still forward native previous_response_id state", async () => {
    const upstreamRequests: Record<string, unknown>[] = [];
    const realNow = Date.now;
    let upstream: ReturnType<typeof Bun.serve> | null = null;
    let server: ReturnType<typeof startServer> | null = null;

    try {
      upstream = Bun.serve({
        port: 0,
        async fetch(request) {
          upstreamRequests.push(await request.json() as Record<string, unknown>);
          return new Response(completedSse("resp_issue_702_native", "native continuation"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      saveConfig({
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "test-openai",
        providers: {
          "test-openai": {
            adapter: "openai-responses",
            baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
            allowPrivateNetwork: true,
            apiKey: "provider-key",
            defaultModel: "gpt-5.5",
          },
        },
      } as OcxConfig);
      server = startServer(0);

      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-openai/gpt-5.5",
          previous_response_id: "resp_upstream_native_state",
          input: [inputMessage(CURRENT_USER_SENTINEL)],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]!.previous_response_id).toBe("resp_upstream_native_state");
    } finally {
      Date.now = realNow;
      globalThis.fetch = originalFetch;
      try {
        await server?.stop(true);
      } finally {
        await upstream?.stop(true);
      }
    }
  });
});
