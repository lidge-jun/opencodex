import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE, isSidecarContextOverflow } from "../../src/server/responses/context-overflow";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #7316: a provider refusing an oversized turn behind the web-search or image sidecar must end
// the turn the way the main path does -- a terminal context_length_exceeded -- so Codex compacts
// instead of resending the identical payload through its retry budget.

let testDir = "";
let previousOcxHome: string | undefined;
const upstreams: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousOcxHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-sidecar-overflow-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function upstream(respond: () => Response): { server: ReturnType<typeof Bun.serve>; hits: () => number } {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits += 1; return respond(); } });
  upstreams.push(server);
  return { server, hits: () => hits };
}

/** The issue's shape: a relay answers 413 with a plain-text body the formatter cannot read. */
const plain413 = () => new Response("Request body exceeds the 8 MiB limit. should-not-reach-client", { status: 413 });
const overflow400 = () => Response.json({ error: {
  message: "This model's maximum context length is 8192 tokens. should-not-reach-client",
  type: "invalid_request_error",
} }, { status: 400 });
const badRequest400 = () => Response.json({ error: { message: "tool schema is invalid", type: "invalid_request_error" } }, { status: 400 });
/** A rate refusal whose wording alone would read as an overflow; only its code says otherwise. */
const rateCoded400 = () => Response.json({ error: { message: "too many tokens", type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: 400 });

type Sidecar = "web-search" | "images";

function sidecarConfig(sidecar: Sidecar, server: ReturnType<typeof Bun.serve>): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "relay",
    ...(sidecar === "web-search"
      ? { webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" } }
      : { images: { bridgeEnabled: true } }),
    providers: {
      relay: {
        adapter: "openai-chat",
        baseUrl: `${String(server.url).replace(/\/$/, "")}/v1`,
        authMode: "key",
        apiKey: "fixture-relay-key",
        allowPrivateNetwork: true,
        defaultModel: "kimi-k3",
      },
      // The image bridge arms only when an xAI image backend is configured; it is never called here.
      ...(sidecar === "images"
        ? { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key", models: ["fixture"] } }
        : {}),
    },
  } as OcxConfig;
}

function send(serverUrl: string, sidecar: Sidecar, stream: boolean): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "relay/kimi-k3",
      stream,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "oversized turn" }] }],
      tools: [sidecar === "web-search" ? { type: "web_search" } : { type: "image_generation" }],
    }),
  });
}

async function failedFrame(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).not.toContain("should-not-reach-client");
  const frame = text.split("\n\n").find(block => block.startsWith("event: response.failed\n"));
  expect(frame).toBeDefined();
  const data = frame!.split("\n").find(line => line.startsWith("data: "))!.slice(6);
  return (JSON.parse(data) as { response: Record<string, unknown> }).response;
}

const overflowError = {
  message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
  type: "invalid_request_error",
  code: "context_length_exceeded",
};

describe("sidecar provider input overflow (#7316)", () => {
  for (const sidecar of ["web-search", "images"] as const) {
    for (const [label, respond] of [["a plain-text 413", plain413], ["a 400 overflow message", overflow400]] as const) {
      test(`${sidecar}: streaming ${label} ends as a terminal context_length_exceeded`, async () => {
        const relay = upstream(respond);
        saveConfig(sidecarConfig(sidecar, relay.server));
        const server = startServer(0);
        try {
          const failed = await failedFrame(await send(String(server.url), sidecar, true));
          expect(failed.status).toBe("failed");
          expect(failed.error).toEqual(overflowError);
          expect(relay.hits()).toBe(1);
        } finally {
          await server.stop(true);
        }
      });
    }

    for (const [label, respond, wording] of [
      ["an unrelated 400", badRequest400, "tool schema is invalid"],
      ["a rate_limit_exceeded 400", rateCoded400, "too many tokens"],
    ] as const) {
      test(`${sidecar}: ${label} keeps its own failure`, async () => {
        const relay = upstream(respond);
        saveConfig(sidecarConfig(sidecar, relay.server));
        const server = startServer(0);
        try {
          const response = await send(String(server.url), sidecar, true);
          const text = await response.text();
          expect(text).not.toContain("context_length_exceeded");
          expect(text).toContain(wording);
        } finally {
          await server.stop(true);
        }
      });
    }
  }

  test("web-search: a non-streaming 413 keeps HTTP 413 with the context classification", async () => {
    const relay = upstream(plain413);
    saveConfig(sidecarConfig("web-search", relay.server));
    const server = startServer(0);
    try {
      const response = await send(String(server.url), "web-search", false);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: overflowError });
    } finally {
      await server.stop(true);
    }
  });
});

describe("isSidecarContextOverflow", () => {
  test("classifies by status, definite provider wording, or an adapter's own code", () => {
    expect(isSidecarContextOverflow(413, "Provider error 413")).toBe(true);
    expect(isSidecarContextOverflow(400, "Provider error 400: prompt exceeds the context window")).toBe(true);
    expect(isSidecarContextOverflow(502, "kiro refused", "context_length_exceeded")).toBe(true);
    expect(isSidecarContextOverflow(400, "Provider error 400: tool schema is invalid")).toBe(false);
    expect(isSidecarContextOverflow(429, "too many tokens per minute")).toBe(false);
    expect(isSidecarContextOverflow(400, "Provider error 400: too many tokens per minute")).toBe(false);
    expect(isSidecarContextOverflow(400, "Provider error 400: maximum context length", "rate_limit_exceeded")).toBe(false);
    expect(isSidecarContextOverflow(502, "Provider stream error: maximum context length")).toBe(false);
    expect(isSidecarContextOverflow(413, "translator", "translation_buffer_limit")).toBe(false);
  });
});
