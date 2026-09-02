import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE } from "../src/server/responses/context-overflow";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

  test("non-streaming callers retain the upstream 413 status and body", async () => {
    const upstream = upstream413();
    saveConfig(config({ target: provider("openai-responses", upstream) }));
    const server = startServer(0);
    try {
      const response = await request(String(server.url), "target/kimi-k3", false);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        detail: "request body too large; echoed private request marker should-not-reach-client",
      });
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

  test("a combo stops on 413 and does not dispatch a second oversized target", async () => {
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
      const failed = await responseFailed(await request(String(server.url), "combo/fallback", true));
      expect((failed.error as { code?: string }).code).toBe("context_length_exceeded");
      expect(firstHits).toBe(1);
      expect(secondHits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
