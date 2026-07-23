import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, spyOn, test } from "bun:test";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { fetchCursorUsableModels } from "../src/adapters/cursor/live-models";
import { armTimeoutDestroyFallback, createLiveCursorTransport, createTerminalSettler } from "../src/adapters/cursor/live-transport";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";

async function withDiscoveryServer<T>(
  handler: (stream: http2.ServerHttp2Stream) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function respond(status: number, body = new Uint8Array()): (stream: http2.ServerHttp2Stream) => void {
  return stream => {
    stream.respond({ ":status": status, "content-type": "application/proto" });
    stream.end(body);
  };
}

describe("Cursor live-model discovery hardening", () => {
  test("returns discovered models as typed success", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "gpt-5.5-high" })],
    }));
    const result = await withDiscoveryServer(respond(200, body), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toEqual({ ok: true, models: ["gpt-5.5-high"] });
  });

  test("classifies authentication failures", async () => {
    const result = await withDiscoveryServer(respond(401), baseUrl =>
      fetchCursorUsableModels({ apiKey: "bad-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "auth", detail: "HTTP 401" });
  });

  test("classifies non-auth HTTP failures", async () => {
    const result = await withDiscoveryServer(respond(503), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "http", detail: "HTTP 503" });
  });

  test("classifies timeouts", async () => {
    const result = await withDiscoveryServer(stream => {
      stream.on("error", () => {});
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 20 }));

    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  test("classifies protobuf decode failures", async () => {
    const malformed = Uint8Array.of(0x0a, 0x05, 0x01);
    const result = await withDiscoveryServer(respond(200, malformed), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "decode" });
  });

  test("classifies valid empty responses", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {}));
    const result = await withDiscoveryServer(respond(200, body), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toEqual({ ok: false, error: "empty" });
  });

  test("catalog warns with the failure class before preserving its degradation order", async () => {
    const providerName = "cursor-hardening-warning";
    clearModelCache(providerName);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = await withDiscoveryServer(respond(503), baseUrl => gatherRoutedModels({
        providers: {
          [providerName]: {
            adapter: "cursor",
            baseUrl,
            apiKey: "test-token",
            models: ["auto"],
          },
        },
      }));

      expect(models.some(model => model.provider === providerName && model.id === "auto")).toBe(true);
      expect(warning.mock.calls.some(args => String(args[0]).includes(
        `Cursor model discovery for "${providerName}" failed [http]`,
      ))).toBe(true);
    } finally {
      warning.mockRestore();
      clearModelCache(providerName);
    }
  });
});

describe("Cursor discovery bounded retry", () => {
  test("retries a transient timeout once with a fresh session and returns the success", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "gpt-5.5-high" })],
    }));
    let requests = 0;
    const result = await withDiscoveryServer(stream => {
      requests += 1;
      if (requests === 1) {
        // First attempt: accept the stream but never respond (client times out).
        stream.on("error", () => {});
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/proto" });
      stream.end(body);
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 30 }));

    expect(requests).toBe(2);
    expect(result).toEqual({ ok: true, models: ["gpt-5.5-high"] });
  });

  test("does not retry deterministic auth failures", async () => {
    let requests = 0;
    const result = await withDiscoveryServer(stream => {
      requests += 1;
      stream.respond({ ":status": 401, "content-type": "application/proto" });
      stream.end();
    }, baseUrl => fetchCursorUsableModels({ apiKey: "bad-token", baseUrl }));

    expect(requests).toBe(1);
    expect(result).toMatchObject({ ok: false, error: "auth" });
  });

  test("does not retry completed non-2xx http responses", async () => {
    let requests = 0;
    const result = await withDiscoveryServer(stream => {
      requests += 1;
      stream.respond({ ":status": 404, "content-type": "application/proto" });
      stream.end();
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(requests).toBe(1);
    expect(result).toMatchObject({ ok: false, error: "http", detail: "HTTP 404" });
  });
});

describe("Cursor catalog discovery cooldown", () => {
  test("second refresh during cooldown does not re-invoke discovery", async () => {
    const providerName = "cursor-hardening-cooldown";
    clearModelCache(providerName);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let requests = 0;
      await withDiscoveryServer(stream => {
        requests += 1;
        stream.respond({ ":status": 404, "content-type": "application/proto" });
        stream.end();
      }, async baseUrl => {
        const providers = {
          providers: {
            [providerName]: {
              adapter: "cursor",
              baseUrl,
              apiKey: "test-token",
              models: ["auto"],
            },
          },
        };
        const first = await gatherRoutedModels(providers);
        expect(first.some(model => model.provider === providerName && model.id === "auto")).toBe(true);
        const requestsAfterFirst = requests;
        // Cooldown (markModelsFetchFailure) must make the second poll skip discovery entirely.
        const second = await gatherRoutedModels(providers);
        expect(second.some(model => model.provider === providerName && model.id === "auto")).toBe(true);
        expect(requests).toBe(requestsAfterFirst);
      });
      expect(requests).toBeGreaterThanOrEqual(1);
    } finally {
      warning.mockRestore();
      clearModelCache(providerName);
    }
  });
});

describe("Cursor terminal settler", () => {
  function harness() {
    const calls = { fail: 0, finish: 0, clear: 0, lastError: undefined as Error | undefined };
    const settler = createTerminalSettler({
      fail: error => { calls.fail += 1; calls.lastError = error; },
      finish: () => { calls.finish += 1; },
      clearTimer: () => { calls.clear += 1; },
    });
    return { calls, settler };
  }

  test("fail-then-fail fires the fail hook exactly once", () => {
    const { calls, settler } = harness();
    settler.settleFail(new Error("first"));
    settler.settleFail(new Error("second"));
    expect(calls).toMatchObject({ fail: 1, finish: 0, clear: 1 });
    expect(calls.lastError?.message).toBe("first");
  });

  test("fail-then-finish keeps the failure terminal", () => {
    const { calls, settler } = harness();
    settler.settleFail(new Error("stream error"));
    settler.settleFinish();
    expect(calls).toMatchObject({ fail: 1, finish: 0, clear: 1 });
    expect(settler.settled()).toBe(true);
  });

  test("finish-then-fail keeps the success terminal (end + late session error)", () => {
    const { calls, settler } = harness();
    settler.settleFinish();
    settler.settleFail(new Error("late session error"));
    expect(calls).toMatchObject({ fail: 0, finish: 1, clear: 1 });
  });

  test("finish-then-finish fires the finish hook exactly once", () => {
    const { calls, settler } = harness();
    settler.settleFinish();
    settler.settleFinish();
    expect(calls).toMatchObject({ fail: 0, finish: 1, clear: 1 });
  });
});

describe("Cursor timeout destroy fallback", () => {
  test("destroys stream and session that ignored close()", async () => {
    const stream = { destroyed: false, destroys: 0, destroy() { this.destroys += 1; this.destroyed = true; } };
    const session = { destroyed: false, destroys: 0, destroy() { this.destroys += 1; this.destroyed = true; } };
    armTimeoutDestroyFallback(stream, session, 10);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(stream.destroys).toBe(1);
    expect(session.destroys).toBe(1);
  });

  test("skips targets that already closed cleanly", async () => {
    const stream = { destroyed: true, destroys: 0, destroy() { this.destroys += 1; } };
    const session = { destroyed: true, destroys: 0, destroy() { this.destroys += 1; } };
    armTimeoutDestroyFallback(stream, session, 10);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(stream.destroys).toBe(0);
    expect(session.destroys).toBe(0);
  });
});

describe("Cursor live transport unexpected EOF", () => {
  test("zero-frame stream end surfaces as a transport error, not success", async () => {
    // Real h2c peer that accepts the request stream and immediately ends it with no
    // response frames — the shape the WP4 reviewer reproduced as a silent success.
    await withDiscoveryServer(stream => {
      stream.on("error", () => {});
      stream.end();
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        firstFrameTimeoutMs: 2_000,
      });
      let failure: Error | undefined;
      let sawMessage = false;
      try {
        for await (const _message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_eof_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          sawMessage = true;
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        // The client session outlives the failed turn; close it so the local
        // fixture server can shut down without waiting on the open connection.
        await transport.close?.();
      }
      expect(sawMessage).toBe(false);
      expect(failure).toBeDefined();
      expect(failure?.message).toContain("unexpected EOF");
    });
  });
});
