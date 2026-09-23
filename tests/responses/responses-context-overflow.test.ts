import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE } from "../../src/server/responses/context-overflow";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousOcxHome: string | undefined;
const upstreams: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousOcxHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-context-overflow-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function upstreamStatus(status: number, onHit?: () => void): ReturnType<typeof Bun.serve> {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      onHit?.();
      return Response.json({
        detail: "request body too large; echoed private request marker should-not-reach-client",
      }, { status });
    },
  });
  upstreams.push(upstream);
  return upstream;
}

function upstream413(onHit?: () => void): ReturnType<typeof Bun.serve> {
  return upstreamStatus(413, onHit);
}

/**
 * A 413 whose body carries a per-request free-tier cap. `comboFailureDecision` reads that
 * as target-local and hops, so a combo tries every target and then exhausts, which is the
 * mapping site this fixture exercises.
 */
function freePromptCap413(onHit?: () => void): ReturnType<typeof Bun.serve> {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      onHit?.();
      return Response.json({
        detail: "err_free_prompt_cap: prompt exceeds this tier; echoed private request marker should-not-reach-client",
      }, { status: 413 });
    },
  });
  upstreams.push(upstream);
  return upstream;
}

function provider(
  adapter: "openai-responses" | "openai-chat" | "anthropic",
  upstream: ReturnType<typeof Bun.serve>,
): OcxProviderConfig {
  return {
    adapter,
    baseUrl: `${String(upstream.url).replace(/\/$/, "")}/v1`,
    authMode: "key",
    apiKey: "test-context-overflow-key",
    allowPrivateNetwork: true,
    defaultModel: "kimi-k3",
  };
}

function config(providers: Record<string, OcxProviderConfig>): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0]!,
    providers,
  } as OcxConfig;
}

function request(serverUrl: string, model: string, stream: boolean, input?: unknown): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      input: input ?? [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "oversized turn" }],
      }],
    }),
  });
}

async function responseFailed(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).not.toContain("should-not-reach-client");
  const frame = text.split("\n\n").find(block => block.startsWith("event: response.failed\n"));
  expect(frame).toBeDefined();
  const data = frame!.split("\n").find(line => line.startsWith("data: "))?.slice(6);
  expect(data).toBeDefined();
  return (JSON.parse(data!) as { response: Record<string, unknown> }).response;
}

describe("Responses provider input overflow", () => {
  test("streaming passthrough and translated adapters emit a terminal context failure", async () => {
    for (const adapter of ["openai-responses", "openai-chat"] as const) {
      const upstream = upstream413();
      saveConfig(config({ target: provider(adapter, upstream) }));
      const server = startServer(0);
      try {
        const failed = await responseFailed(await request(String(server.url), "target/kimi-k3", true));
        expect(failed.status).toBe("failed");
        expect(failed.retryable).toBe(false);
        expect(failed.error).toEqual({
          message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        });
        expect(failed.last_error).toEqual(failed.error);
      } finally {
        await server.stop(true);
      }
    }
  });

  test.each(["openai-responses", "openai-chat", "anthropic"] as const)("non-streaming %s preserves HTTP 413 with a safe context classification", async adapter => {
    const upstream = upstream413();
    saveConfig(config({ target: provider(adapter, upstream) }));
    const server = startServer(0);
    try {
      const response = await request(String(server.url), "target/kimi-k3", false);
      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        error: {
          message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      });
    } finally {
      await server.stop(true);
    }
  });

  test.each(["openai-responses", "openai-chat"] as const)("routed %s compaction preserves the classified 413 without replay", async adapter => {
    let hits = 0;
    const upstream = upstream413(() => { hits += 1; });
    saveConfig(config({ target: provider(adapter, upstream) }));
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "target/kimi-k3", input: [{ role: "user", content: "summarize this history" }] }),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: {
        message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
        type: "invalid_request_error",
        code: "context_length_exceeded",
      } });
      expect(hits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("local input admission uses the same terminal streaming contract without upstream I/O", async () => {
    let hits = 0;
    const upstream = upstream413(() => { hits += 1; });
    const target = provider("openai-chat", upstream);
    target.modelContextWindows = { "kimi-k3": 1 };
    saveConfig(config({ target }));
    const server = startServer(0);
    try {
      const failed = await responseFailed(await request(
        String(server.url),
        "target/kimi-k3",
        true,
        [{ type: "message", role: "user", content: [{ type: "input_text", text: "x ".repeat(100) }] }],
      ));
      expect((failed.error as { code?: string }).code).toBe("context_length_exceeded");
      expect(hits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("the bounded Anthropic image retry runs once before the terminal failure", async () => {
    let hits = 0;
    const upstream = upstream413(() => { hits += 1; });
    saveConfig(config({ target: provider("anthropic", upstream) }));
    const server = startServer(0);
    try {
      const failed = await responseFailed(await request(
        String(server.url),
        "target/kimi-k3",
        true,
        [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          ],
        }],
      ));
      expect((failed.error as { code?: string }).code).toBe("context_length_exceeded");
      expect(hits).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("unrelated passthrough HTTP failures keep their status and body", async () => {
    for (const status of [400, 503]) {
      const upstream = upstreamStatus(status);
      saveConfig(config({ target: provider("openai-responses", upstream) }));
      const server = startServer(0);
      try {
        const response = await request(String(server.url), "target/kimi-k3", true);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({
          detail: "request body too large; echoed private request marker should-not-reach-client",
        });
      } finally {
        await server.stop(true);
      }
    }
  });

  test.each([true, false])("a combo stops on 413 without dispatching a second target (stream=%s)", async stream => {
    let firstHits = 0;
    let secondHits = 0;
    const first = upstream413(() => { firstHits += 1; });
    const second = upstream413(() => { secondHits += 1; });
    const next = config({
      first: provider("openai-chat", first),
      second: provider("openai-chat", second),
    });
    next.combos = {
      fallback: {
        strategy: "failover",
        targets: [
          { provider: "first", model: "kimi-k3" },
          { provider: "second", model: "kimi-k3" },
        ],
      },
    };
    saveConfig(next);
    const server = startServer(0);
    try {
      const response = await request(String(server.url), "combo/fallback", stream);
      if (stream) {
        const failed = await responseFailed(response);
        expect((failed.error as { code?: string }).code).toBe("context_length_exceeded");
      } else {
        expect(response.status).toBe(413);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ error: {
          message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        } });
      }
      expect(firstHits).toBe(1);
      expect(secondHits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
  // A 413 carrying `err_free_prompt_cap` is a per-request free-tier cap, so
  // `comboFailureDecision` hops instead of stopping. Every target then refuses and the
  // combo falls out of its loop, which is a different mapping site from the "stop" case
  // above and was still gated on `stream === true` after #4127 (#4149).
  test.each([true, false])("an exhausted combo classifies a hopping 413 (stream=%s)", async stream => {
    let firstHits = 0;
    let secondHits = 0;
    const first = freePromptCap413(() => { firstHits += 1; });
    const second = freePromptCap413(() => { secondHits += 1; });
    const next = config({
      first: provider("openai-chat", first),
      second: provider("openai-chat", second),
    });
    next.combos = {
      fallback: {
        strategy: "failover",
        targets: [
          { provider: "first", model: "kimi-k3" },
          { provider: "second", model: "kimi-k3" },
        ],
      },
    };
    saveConfig(next);
    const server = startServer(0);
    try {
      const response = await request(String(server.url), "combo/fallback", stream);
      if (stream) {
        const failed = await responseFailed(response);
        expect((failed.error as { code?: string }).code).toBe("context_length_exceeded");
      } else {
        expect(response.status).toBe(413);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ error: {
          message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        } });
      }
      // Both targets were tried: this is the exhausted path, not the stop path.
      expect(firstHits).toBe(1);
      expect(secondHits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
});
