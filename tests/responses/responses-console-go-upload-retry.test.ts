import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;

/** The exact Console Go rejection for a payload it accepts moments later. */
const UPLOAD_REFUSAL = JSON.stringify({
  model: "muse-spark-1.3-contributor",
  error: {
    param: null,
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request.",
  },
});

/** A deterministic 400 on the same wire: a verdict on the request, never a flap. */
const EFFORT_REFUSAL = JSON.stringify({
  model: "muse-spark-1.3-contributor",
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-console-go-upload-retry-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  removeTreeWithRetry(testDir);
});

function config(): OcxConfig {
  return {
    defaultProvider: "go",
    providers: {
      go: {
        adapter: "openai-responses",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
        apiKey: "go-test-key",
      },
    },
  } as OcxConfig;
}

function request(stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "session_id": "thread-console-go-upload-retry",
    },
    body: JSON.stringify({
      model: "go/muse-spark-1.3-contributor",
      stream,
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }),
  });
}

function refusal(status = 400, body = UPLOAD_REFUSAL): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function success(id: string): Response {
  return Response.json({ id, object: "response", status: "completed", model: "muse-spark-1.3-contributor", output: [] });
}

describe("Console Go transient upload refusal recovery", () => {
  test("replays the refusal once and serves the retry with a byte-identical body", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(init?.body));
      return outbound.length === 1 ? refusal() : success("resp-upload-retry-recovered");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    // The replay must be the same request, not a reshaped one. Evidence: usage ledger
    // ocx-ce696fa4a554e4f3e375cf120904b0da (400) vs ocx-ed78f47b96f7d1bb7c (200, +22s).
    expect(outbound[1]).toBe(outbound[0]);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["console-go-upload-retry"]);
  });

  test("does not replay a different 400 from the same wire", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return refusal(400, EFFORT_REFUSAL);
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" });

    expect(response.status).toBe(400);
    expect(sends).toBe(1);
  });

  test("keeps a repeated refusal visible after the single bounded replay", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return refusal();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);

    expect(response.status).toBe(400);
    expect(sends).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["console-go-upload-retry"]);
  });
});

