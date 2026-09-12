import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { resetReasoningMetadataCachesForTests } from "../../src/providers/reasoning-metadata";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

/**
 * Rejected-rung learning on the request path: a rung the catalog advertises can still be refused
 * upstream because the ladder describes the model, not this account's entitlement (max on
 * muse-spark-1.3-contributor needs an active Muse Code subscription). The pipeline must learn the
 * refusal, replay once at the next published rung, and never replay an unrelated 400.
 */

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const MODEL = "muse-spark-1.3-contributor";
const REFUSAL = JSON.stringify({
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});
const UNRELATED = JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid upload request." } });

let testDir = "";

function writeSnapshot(values: string[]): void {
  writeFileSync(join(testDir, "reasoning-metadata-cache.json"), JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    source: "test",
    providers: { "opencode-go": { [MODEL]: { reasoning: true, options: [{ type: "effort", values }] } } },
  }));
}

function config(): OcxConfig {
  return {
    defaultProvider: "first",
    providers: {
      first: {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

function request(stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "first/" + MODEL,
      stream,
      store: false,
      reasoning: { effort: "max" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
    }),
  });
}

function success(): Response {
  return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-reasoning-downgrade-"));
  process.env.OPENCODEX_HOME = testDir;
  resetReasoningMetadataCachesForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetReasoningMetadataCachesForTests();
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("rejected reasoning rungs", () => {
  test("clamps a rung the model does not publish before dispatch", async () => {
    writeSnapshot(["minimal", "low", "medium", "high", "xhigh"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.reasoning_effort).toBe("xhigh");
  });

  test("learns the refusal and replays once at the next published rung", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.reasoning_effort).toBe("max");
    expect(outbound[1]?.reasoning_effort).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });

  test("does not replay an unrelated 400", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNRELATED, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(1);
    expect(response.ok).toBe(false);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
  });
  test("replays once on the streamed passthrough path too", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(true), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(outbound[1]?.reasoning_effort).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });
});
