import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, spyOn, test } from "bun:test";
import {
  AgentServerMessageSchema,
  CreatePlanArgsSchema,
  CreatePlanRequestQuerySchema,
  GetUsableModelsResponseSchema,
  InteractionQuerySchema,
  KvServerMessageSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  InteractionUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { CONNECT_FLAG_END_STREAM, encodeConnectFrame } from "../src/adapters/cursor/framing";
import { fetchCursorUsableModels } from "../src/adapters/cursor/live-models";
import { armTimeoutDestroyFallback, createLiveCursorTransport, createTerminalSettler } from "../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache, getProviderDiscoveryStatus } from "../src/codex/model-cache";
import { handleManagementAPI } from "../src/server/management-api";

async function withDiscoveryServer<T>(
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", (stream, headers) => handler(stream, headers));
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

async function cursorDiscoveryDto(provider: string): Promise<Record<string, unknown>> {
  const requestUrl = new URL("http://127.0.0.1/api/providers");
  const response = await handleManagementAPI(
    new Request(requestUrl),
    requestUrl,
    {
      providers: {
        [provider]: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          models: [],
        },
      },
    },
  );
  const providers = await response!.json() as Array<Record<string, unknown>>;
  return providers[0] ?? {};
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

  test("filters every shared model-id control-character class", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [
        create(ModelDetailsSchema, { modelId: "good-model" }),
        create(ModelDetailsSchema, { modelId: "bad-del\u007f" }),
        create(ModelDetailsSchema, { modelId: "bad-c1\u0085" }),
        create(ModelDetailsSchema, { modelId: "bad-line\u2028separator" }),
      ],
    }));
    const result = await withDiscoveryServer(respond(200, body), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toEqual({ ok: true, models: ["good-model"] });
  });

  test("rejects a cleartext non-loopback discovery URL before connecting", async () => {
    const result = await fetchCursorUsableModels({
      apiKey: "test-token",
      baseUrl: "http://api2.cursor.sh",
    });

    expect(result).toEqual({
      ok: false,
      error: "transport",
      detail: "Cursor discovery URL must use HTTPS",
    });
  });

  test("HTTP/1.1 discovery uses fetch with Bun's protocol pin", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "claude-opus-5" })],
    }));
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
    }) as typeof fetch;

    const result = await fetchCursorUsableModels({
      apiKey: "test-token",
      baseUrl: "https://api2.cursor.sh",
      upstreamHttpVersion: "http1.1",
      fetch: fetchImpl,
    });

    expect(result).toEqual({ ok: true, models: ["claude-opus-5"] });
    expect(seenUrl).toBe("https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.redirect).toBe("manual");
    expect((seenInit as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer test-token");
  });

  test("HTTP/1.1 discovery rejects announced and streamed 4 MiB overflow before decode", async () => {
    let announcedCalls = 0;
    const announced = await fetchCursorUsableModels({
      apiKey: "test-token",
      baseUrl: "https://api2.cursor.sh",
      upstreamHttpVersion: "http1.1",
      fetch: (async () => {
        announcedCalls += 1;
        return new Response(new Uint8Array(), {
          status: 200,
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        });
      }) as typeof fetch,
    });
    expect(announced).toMatchObject({ ok: false, error: "too_large" });
    expect(announcedCalls).toBe(1);

    let streamedCalls = 0;
    const streamed = await fetchCursorUsableModels({
      apiKey: "test-token",
      baseUrl: "https://api2.cursor.sh",
      upstreamHttpVersion: "http1.1",
      fetch: (async () => {
        streamedCalls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            controller.enqueue(Uint8Array.of(0));
            controller.close();
          },
        }), { status: 200 });
      }) as typeof fetch,
    });
    expect(streamed).toMatchObject({ ok: false, error: "too_large" });
    expect(streamedCalls).toBe(1);
  });

  test("discovery rejects a cleartext non-loopback URL before exposing the token, even with an HTTP/1.1 pin", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCursorUsableModels({
      apiKey: "must-not-leave-process",
      baseUrl: "http://api2.cursor.sh",
      upstreamHttpVersion: "http1.1",
      fetch: fetchImpl,
    });

    expect(result).toEqual({ ok: false, error: "transport", detail: "Cursor discovery URL must use HTTPS" });
    expect(fetchCalls).toBe(0);
  });

  test("HTTP/1.1 discovery rejects an admitted loopback URL without retrying or invoking fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCursorUsableModels({
      apiKey: "must-not-leave-process",
      baseUrl: "http://127.0.0.1:1",
      upstreamHttpVersion: "http1.1",
      fetch: fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      error: "policy",
      detail: "Cursor HTTP/1.1 discovery requires HTTPS",
    });
    expect(fetchCalls).toBe(0);
  });

  test("Cursor catalog propagates the provider HTTP/1.1 pin to discovery", async () => {
    const providerName = "cursor-http1-discovery";
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "claude-opus-5" })],
    }));
    let seenProtocol: string | undefined;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenProtocol = (init as RequestInit & { protocol?: string } | undefined)?.protocol;
      return new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [providerName]: {
            adapter: "cursor",
            baseUrl: "https://api2.cursor.sh",
            apiKey: "test-token",
            upstreamHttpVersion: "http1.1",
            models: ["claude-opus-5"],
            fetch: fetchImpl,
          } as Parameters<typeof gatherRoutedModels>[0]["providers"][string] & { fetch: typeof fetch },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toContain(`${providerName}/claude-opus-5`);
      expect(seenProtocol).toBe("http1.1");
    } finally {
      clearModelCache(providerName);
    }
  });

  test("classifies authentication failures", async () => {
    const result = await withDiscoveryServer(respond(401), baseUrl =>
      fetchCursorUsableModels({ apiKey: "bad-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "auth", detail: "HTTP 401" });
  });

  test("Cursor catalog discovery failure records provider status", async () => {
    const provider = "cursor-discovery-failed";
    const rawDetail = "HTTP 401";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = await withDiscoveryServer(respond(401), baseUrl => gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "cursor",
            baseUrl,
            apiKey: "bad-token",
            models: ["auto"],
          },
        },
      }));

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([`${provider}/auto`]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "provider" });
      const dto = await cursorDiscoveryDto(provider);
      expect(dto).toMatchObject({ discovery: { status: "failed", reason: "provider" } });
      expect(JSON.stringify(dto)).not.toContain(rawDetail);
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("does not warn when a failed Cursor discovery belongs to a cleared generation", async () => {
    const provider = "cursor-discovery-stale-warning";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    let stream!: http2.ServerHttp2Stream;
    try {
      await withDiscoveryServer(candidate => {
        stream = candidate;
        release();
      }, async baseUrl => {
        const pending = gatherRoutedModels({
          providers: {
            [provider]: {
              adapter: "cursor",
              baseUrl,
              apiKey: "test-token",
              models: ["auto"],
            },
          },
        });
        await started;
        clearModelCache(provider);
        stream.respond({ ":status": 401, "content-type": "application/proto" });
        stream.end();
        await pending;
      });

      expect(warning.mock.calls.some(args => String(args[0]).includes(
        `Cursor model discovery for "${provider}" failed`,
      ))).toBe(false);
      expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
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

  test("Cursor model discovery rejects announced and streamed 4 MiB overflow before decode", async () => {
    const announced = await withDiscoveryServer(stream => {
      stream.respond({
        ":status": 200,
        "content-type": "application/proto",
        "content-length": String(4 * 1024 * 1024 + 1),
      });
      stream.end();
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));
    expect(announced).toMatchObject({ ok: false, error: "too_large" });

    const streamed = await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/proto" });
      stream.write(Buffer.alloc(4 * 1024 * 1024));
      stream.end(Buffer.alloc(1));
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));
    expect(streamed).toMatchObject({ ok: false, error: "too_large" });
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
      // 120ms was enough on a quiet machine but the retry attempt shares the
      // same budget (min(timeoutMs, retry cap)) and flaked on loaded CI
      // runners: the second, succeeding attempt also timed out. 1s keeps the
      // test deterministic; the never-responding first attempt still bounds
      // total runtime at ~1.5s.
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 1_000 }));

    expect(requests).toBe(2);
    expect(result).toEqual({ ok: true, models: ["gpt-5.5-high"] });
  });

  test("retries an HTTP/2 stream that ends before response headers", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "gpt-5.5-high" })],
    }));
    let requests = 0;
    const result = await withDiscoveryServer(stream => {
      requests += 1;
      if (requests === 1) {
        stream.close(http2.constants.NGHTTP2_NO_ERROR);
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/proto" });
      stream.end(body);
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

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
  test("synthesizes done after assistant text on clean Connect EOF without turnEnded", async () => {
    const textFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text: "hello" }),
          },
        }),
      },
    })));
    const kvFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "kvServerMessage",
        value: create(KvServerMessageSchema, { id: 7 }),
      },
    })));
    const connectEnd = encodeConnectFrame(new TextEncoder().encode("{}"), {
      flags: CONNECT_FLAG_END_STREAM,
    });

    await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from(new Uint8Array([...textFrame, ...kvFrame, ...connectEnd])));
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: 2_000,
      });
      const messages: Array<{ type: string }> = [];
      try {
        for await (const message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_clean_eof_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          messages.push(message);
        }
      } finally {
        await transport.close?.();
      }

      expect(messages).toContainEqual({ type: "text", text: "hello" });
      expect(messages.at(-1)).toMatchObject({ type: "done" });
    });
  });
  test("sends the injected session id as Connect x-session-id", async () => {
    let seenSessionId: string | undefined;
    await withDiscoveryServer((stream, headers) => {
      const raw = headers["x-session-id"];
      seenSessionId = Array.isArray(raw) ? raw[0] : raw;
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end();
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: 2_000,
        sessionId: "cursor_from_gjc_session",
      });
      try {
        for await (const _ of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_header_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) { /* drain */ }
      } catch { /* fixture closes immediately */ }
      finally {
        await transport.close?.();
      }
    });
    expect(seenSessionId).toBe("cursor_from_gjc_session");
  });

  test("settles as a failure when clean EOF synthesis exceeds the transport budget", async () => {
    const textFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text: "x" }),
          },
        }),
      },
    })));
    const connectEnd = encodeConnectFrame(new TextEncoder().encode("{}"), {
      flags: CONNECT_FLAG_END_STREAM,
    });

    await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from(new Uint8Array([
        ...Array.from({ length: 37 }, () => [...textFrame]).flat(),
        ...connectEnd,
      ])));
    }, async baseUrl => {
      const budget = createTestTranslatorBudget({ maxTurnBytes: 1_000 });
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: budget,
        firstFrameTimeoutMs: 2_000,
      });
      const iterator = transport.run({
        modelId: "composer-2",
        conversationId: "cursor_clean_eof_budget_test",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })[Symbol.asyncIterator]();
      let failure: Error | undefined;
      try {
        expect(await iterator.next()).toMatchObject({ value: { type: "text" } });
        await Bun.sleep(20);
        while (!(await iterator.next()).done) {}
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }

      expect(failure).toMatchObject({
        name: "TranslatorBudgetExceededError",
        code: "translation_buffer_limit",
      });
      expect(budget.snapshot().currentBytes).toBe(0);
    });
  });

  test("synthesizes done after createPlanRequestQuery text on clean Connect EOF", async () => {
    const planFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: create(InteractionQuerySchema, {
          id: 7,
          query: {
            case: "createPlanRequestQuery",
            value: create(CreatePlanRequestQuerySchema, {
              args: create(CreatePlanArgsSchema, {
                name: "Fix bridge",
                overview: "Two steps.",
                plan: "1. read\n2. patch",
              }),
            }),
          },
        }),
      },
    })));
    const connectEnd = encodeConnectFrame(new TextEncoder().encode("{}"), {
      flags: CONNECT_FLAG_END_STREAM,
    });

    await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from(new Uint8Array([...planFrame, ...connectEnd])));
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: 2_000,
      });
      const messages: Array<{ type: string; text?: string }> = [];
      try {
        for await (const message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_plan_eof_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          messages.push(message);
        }
      } finally {
        await transport.close?.();
      }

      expect(messages.some(message => message.type === "text" && message.text?.includes("Fix bridge"))).toBe(true);
      expect(messages.at(-1)).toMatchObject({ type: "done" });
    });
  });

  test("open tool call plus clean Connect EOF emits a truncation error, not a thrown failure", async () => {
    const startedFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "toolCallStarted",
            value: create(ToolCallStartedUpdateSchema, {
              callId: "call_1",
              modelCallId: "model_1",
              toolCall: create(ToolCallSchema, {
                tool: {
                  case: "mcpToolCall",
                  value: create(McpToolCallSchema, {
                    args: create(McpArgsSchema, {
                      name: "ocx_client_get_time",
                      toolName: "ocx_client_get_time",
                      toolCallId: "call_1",
                      providerIdentifier: "opencodex-responses",
                    }),
                  }),
                },
              }),
            }),
          },
        }),
      },
    })));
    const connectEnd = encodeConnectFrame(new TextEncoder().encode("{}"), {
      flags: CONNECT_FLAG_END_STREAM,
    });

    await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from(new Uint8Array([...startedFrame, ...connectEnd])));
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: 2_000,
      });
      const messages: Array<{ type: string; message?: string }> = [];
      let failure: Error | undefined;
      try {
        for await (const message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_open_tool_eof_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
          tools: [{ name: "get_time", description: "t", parameters: { type: "object", properties: {} } }],
        })) {
          messages.push(message);
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }

      expect(failure).toBeUndefined();
      expect(messages.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("incomplete tool call"),
      });
    });
  });

  test("zero-frame stream end surfaces as a transport error, not success", async () => {
    // Real h2c peer that accepts the request stream and immediately ends it with no
    // response frames — the shape the WP4 reviewer reproduced as a silent success.
    await withDiscoveryServer(stream => {
      stream.on("error", () => {});
      stream.end();
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
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

describe("Cursor live transport incomplete-frame EOF", () => {
  function validEmptyFrame(): Uint8Array {
    return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {})));
  }

  // A valid protobuf message whose size comes from an unknown field the decoder
  // skips — lets tests drive exact payload boundaries with parseable frames.
  function paddedPayload(totalBytes: number): Uint8Array {
    const content = totalBytes - 5; // 1-byte tag + 4-byte varint length
    if (content < 0) throw new Error("payload too small to pad");
    const out = new Uint8Array(totalBytes);
    out[0] = (15 << 3) | 2; // unknown field 15, length-delimited
    out[1] = (content & 0x7f) | 0x80;
    out[2] = ((content >> 7) & 0x7f) | 0x80;
    out[3] = ((content >> 14) & 0x7f) | 0x80;
    out[4] = (content >> 21) & 0x7f;
    return out;
  }

  async function runTurn(
    script: (stream: import("node:http2").ServerHttp2Stream) => void,
  ): Promise<{ failure: Error | undefined }> {
    return withDiscoveryServer(script, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: 2_000,
      });
      let failure: Error | undefined;
      try {
        for await (const _message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_eof_partial_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          // drain
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
      return { failure };
    });
  }

  test("complete frame followed by a trailing partial frame fails typed frame_incomplete", async () => {
    const { failure } = await runTurn(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(validEmptyFrame()));
      // Three bytes of the next header, then the peer drops: previously a silent success.
      stream.end(Buffer.from([0, 0, 0]));
    });
    expect(failure).toBeDefined();
    expect((failure as { code?: unknown } | undefined)?.code).toBe("frame_incomplete");
  });

  test("only a partial header before EOF fails typed frame_incomplete", async () => {
    const { failure } = await runTurn(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from([0, 0]));
    });
    expect(failure).toBeDefined();
    expect((failure as { code?: unknown } | undefined)?.code).toBe("frame_incomplete");
  });

  test("chunked delivery of small frames completes cleanly", async () => {
    const { failure } = await runTurn(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      const frame = validEmptyFrame();
      // Byte-at-a-time delivery exercises the incremental append path.
      for (let index = 0; index < frame.byteLength; index += 1) {
        stream.write(Buffer.from(frame.subarray(index, index + 1)));
      }
      stream.write(Buffer.from(validEmptyFrame()));
      stream.end();
    });
    expect(failure).toBeUndefined();
  });

  test("chunked delivery sweep across chunk sizes decodes identically", async () => {
    for (const chunkSize of [1, 3, 7, 64 * 1024]) {
      const { failure } = await runTurn(stream => {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        const frame = encodeConnectFrame(paddedPayload(100 * 1024));
        for (let index = 0; index < frame.byteLength; index += chunkSize) {
          stream.write(Buffer.from(frame.subarray(index, Math.min(index + chunkSize, frame.byteLength))));
        }
        stream.end();
      });
      expect(failure).toBeUndefined();
    }
  });

  test("an exact 16 MiB effective payload completes at the boundary", async () => {
    const budget = createTestTranslatorBudget();
    const result = await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.from(encodeConnectFrame(paddedPayload(16 * 1024 * 1024))));
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: budget,
        firstFrameTimeoutMs: 10_000,
      });
      let failure: Error | undefined;
      try {
        for await (const _message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_boundary_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          // drain
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
      return { failure };
    });
    expect(result.failure).toBeUndefined();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("frame_incomplete EOF releases the backlog lease to zero", async () => {
    const budget = createTestTranslatorBudget();
    const result = await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(validEmptyFrame()));
      stream.end(Buffer.from([0, 0, 0]));
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: budget,
        firstFrameTimeoutMs: 2_000,
      });
      let failure: Error | undefined;
      try {
        for await (const _message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_lease_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          // drain
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
      return { failure };
    });
    expect((result.failure as { code?: unknown } | undefined)?.code).toBe("frame_incomplete");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a rejected over-cap chunk never debits the pre-existing lease", async () => {
    const budget = createTestTranslatorBudget();
    // Transport A parks an incomplete frame (16 MiB + 4 charged) with its
    // stream open; transport B's own incomplete frame overflows the SHARED
    // turn budget and must be rejected without debiting A's ownership.
    // (Filler must be an incomplete frame — zero bytes would decode as free
    // zero-length frames and never accumulate.)
    const declared = new Uint8Array(5);
    new DataView(declared.buffer).setUint32(1, 16 * 1024 * 1024, false);
    await withDiscoveryServer(streamA => {
      streamA.respond({ ":status": 200, "content-type": "application/connect+proto" });
      streamA.write(Buffer.from(declared));
      streamA.write(Buffer.alloc(16 * 1024 * 1024 - 1));
      // Stream A stays open: the frame never completes and the lease stays live.
    }, async baseUrlA => {
      await withDiscoveryServer(streamB => {
        streamB.respond({ ":status": 200, "content-type": "application/connect+proto" });
        streamB.write(Buffer.from(declared));
        // Body 8 bytes short of the declaration: stays in the backlog, and
        // (16 MiB + 4) + (5 + 16 MiB - 8) = 32 MiB + 1 overflows the budget.
        streamB.end(Buffer.alloc(16 * 1024 * 1024 - 8));
      }, async baseUrlB => {
        const transportA = createLiveCursorTransport({
          provider: { adapter: "cursor", baseUrl: baseUrlA, apiKey: "test-token" },
          translatorBudget: budget,
          firstFrameTimeoutMs: 30_000,
        });
        const transportB = createLiveCursorTransport({
          provider: { adapter: "cursor", baseUrl: baseUrlB, apiKey: "test-token" },
          translatorBudget: budget,
          firstFrameTimeoutMs: 30_000,
        });
        const runA = (async () => {
          try {
            for await (const _message of transportA.run({
              modelId: "composer-2",
              conversationId: "cursor_overflow_lease_a",
              system: [],
              messages: [{ role: "user", content: "hello" }],
            })) {
              // drain
            }
          } catch {
            // A ends via close() below; the failure shape is not under test here.
          }
        })();
        // Give A a beat to park its incomplete frame before B overflows.
        for (let attempt = 0; attempt < 200 && budget.snapshot().currentBytes < 16 * 1024 * 1024 + 4; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(budget.snapshot().currentBytes).toBe(16 * 1024 * 1024 + 4);
        let failureB: Error | undefined;
        try {
          for await (const _message of transportB.run({
            modelId: "composer-2",
            conversationId: "cursor_overflow_lease_b",
            system: [],
            messages: [{ role: "user", content: "hello" }],
          })) {
            // drain
          }
        } catch (err) {
          failureB = err instanceof Error ? err : new Error(String(err));
        }
        expect(failureB).toBeDefined();
        // A's lease is untouched by B's rejected reservation and cleanup.
        expect(budget.snapshot().currentBytes).toBe(16 * 1024 * 1024 + 4);
        await transportA.close?.();
        await runA;
        await transportB.close?.();
        expect(budget.snapshot().currentBytes).toBe(0);
      });
    });
  }, 20_000);

  test("data arriving after terminal failure is never charged", async () => {
    const budget = createTestTranslatorBudget();
    await withDiscoveryServer(stream => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      // A complete frame whose payload is NOT valid protobuf: handling fails
      // and settles the turn. Two more bytes arrive afterwards.
      stream.write(Buffer.from(encodeConnectFrame(new Uint8Array([1, 2, 3, 4]))));
      setTimeout(() => {
        try { stream.write(Buffer.from([0, 0])); } catch { /* closed */ }
        stream.end();
      }, 25);
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: budget,
        firstFrameTimeoutMs: 5_000,
      });
      let failure: Error | undefined;
      try {
        for await (const _message of transport.run({
          modelId: "composer-2",
          conversationId: "cursor_late_data_test",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) {
          // drain
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      expect(failure).toBeDefined();
      // Let the delayed bytes land, then prove no lease formed.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(budget.snapshot().currentBytes).toBe(0);
      await transport.close?.();
      expect(budget.snapshot().currentBytes).toBe(0);
    });
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
