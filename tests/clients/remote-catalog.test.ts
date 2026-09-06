import { describe, expect, test } from "bun:test";
import { downloadClientCatalog, downloadDesktop3pModels, HubClientError } from "../../src/client/hub-client";

const JSON_HEADERS = { "Content-Type": "application/json", ETag: '"catalog-v1"' };

const desktopModel = {
  name: "claude-opus-4-8-20260101",
  labelOverride: "Remote model",
  anthropicFamilyTier: "opus" as const,
};

function response(body: string, headers: HeadersInit = JSON_HEADERS): Response {
  return new Response(body, { headers });
}

describe("remote Desktop snapshot consumer", () => {
  test.each(["https://hub.example.test", "http://127.0.0.1:2345", "http://localhost:2345", "http://[::1]:2345"])(
    "uses authenticated opt-in discovery at permitted origin %s", async origin => {
      const result = await downloadDesktop3pModels(origin, "ocx_data_test", {
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe(`${origin}/v1/models?ids=desktop&format=desktop-config`);
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("manual");
          const headers = new Headers(init?.headers);
          expect(headers.get("anthropic-version")).toBe("2023-06-01");
          expect(headers.get("x-opencodex-api-key")).toBe("ocx_data_test");
          expect(headers.get("accept")).toBe("application/json");
          expect(headers.has("if-none-match")).toBe(false);
          return response(JSON.stringify({ version: 1, models: [desktopModel] }));
        },
      });
      expect(result).toEqual({ version: 1, models: [desktopModel] });
    },
  );

  test("refuses insecure transport before constructing credential headers or fetching", async () => {
    let calls = 0;
    await expect(downloadDesktop3pModels("http://hub.example.test", "invalid\nheader", {
      fetchImpl: async () => { calls++; return response("{}"); },
    })).rejects.toMatchObject({ code: "insecure_http_refused" });
    expect(calls).toBe(0);
  });

  test("does not follow redirects or reflect their destination/body", async () => {
    let calls = 0;
    await expect(downloadDesktop3pModels("https://hub.example.test", "secret-marker", {
      fetchImpl: async (_input, init) => {
        calls++;
        expect(init?.redirect).toBe("manual");
        return new Response("response-marker", { status: 302, headers: { Location: "https://destination-marker.test" } });
      },
    })).rejects.toMatchObject({ code: "redirect_refused", message: "Hub Desktop model snapshot request failed" });
    expect(calls).toBe(1);
  });

  test.each([304, 401, 403, 404, 500])("refuses HTTP %s with a fixed error", async status => {
    await expect(downloadDesktop3pModels("https://hub.example.test", "secret-marker", {
      fetchImpl: async () => new Response(status === 304 ? null : "remote-body-marker", { status }),
    })).rejects.toMatchObject({ code: `desktop_snapshot_http_${status}`, message: "Hub Desktop model snapshot request failed" });
  });

  test.each([
    ["old catalog", { data: [] }, "desktop_snapshot_unsupported"],
    ["future version", { version: 2, models: [] }, "desktop_snapshot_unsupported"],
    ["null", null, "desktop_snapshot_invalid"],
    ["array envelope", [], "desktop_snapshot_invalid"],
    ["missing models", { version: 1 }, "desktop_snapshot_invalid"],
    ["object models", { version: 1, models: {} }, "desktop_snapshot_invalid"],
    ["null row", { version: 1, models: [null] }, "desktop_snapshot_invalid"],
    ["array row", { version: 1, models: [[]] }, "desktop_snapshot_invalid"],
    ["missing name", { version: 1, models: [{ labelOverride: "Label", anthropicFamilyTier: "opus" }] }, "desktop_snapshot_invalid"],
    ["bad label type", { version: 1, models: [{ ...desktopModel, labelOverride: 1 }] }, "desktop_snapshot_invalid"],
    ["bad name", { version: 1, models: [{ ...desktopModel, name: "remote-marker" }] }, "desktop_snapshot_invalid"],
    ["duplicate", { version: 1, models: [desktopModel, desktopModel] }, "desktop_snapshot_invalid"],
    ["bracket label", { version: 1, models: [{ ...desktopModel, labelOverride: "remote-marker[1m]" }] }, "desktop_snapshot_invalid"],
    ["long label", { version: 1, models: [{ ...desktopModel, labelOverride: "x".repeat(81) }] }, "desktop_snapshot_invalid"],
    ["bad family", { version: 1, models: [{ ...desktopModel, anthropicFamilyTier: "remote-marker" }] }, "desktop_snapshot_invalid"],
    ["bad default", { version: 1, models: [{ ...desktopModel, isFamilyDefault: 1 }] }, "desktop_snapshot_invalid"],
    ["false supports1m", { version: 1, models: [{ ...desktopModel, supports1m: false }] }, "desktop_snapshot_invalid"],
    ["false prefer1m", { version: 1, models: [{ ...desktopModel, prefer1m: false }] }, "desktop_snapshot_invalid"],
    ["null flag", { version: 1, models: [{ ...desktopModel, supports1m: null }] }, "desktop_snapshot_invalid"],
  ] as const)("rejects %s without reflecting remote values", async (_label, value, code) => {
    let caught: unknown;
    try {
      await downloadDesktop3pModels("https://hub.example.test", "secret-marker", {
        fetchImpl: async () => response(JSON.stringify(value)),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HubClientError);
    expect((caught as HubClientError).code).toBe(code);
    expect((caught as Error).cause).toBeUndefined();
    expect(String(caught)).not.toContain("remote-marker");
    expect(String(caught)).not.toContain("secret-marker");
  });

  test("projects only known fields while keeping valid capability flags and an 80-character label", async () => {
    const known = { ...desktopModel, labelOverride: "x".repeat(80), isFamilyDefault: false, supports1m: true, prefer1m: true };
    const result = await downloadDesktop3pModels("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => response(JSON.stringify({ version: 1, models: [{ ...known, apiKey: "remote-marker", endpoint: "http://wrong.test" }], unknown: 1 })),
    });
    expect(result).toEqual({ version: 1, models: [known] });
  });

  test("accepts empty snapshots and 2000 rows, refuses 2001", async () => {
    for (const count of [0, 2000, 2001]) {
      const models = Array.from({ length: count }, (_, index) => ({ ...desktopModel, name: `claude-test-${index}` }));
      const pending = downloadDesktop3pModels("https://hub.example.test", "ocx_data_test", {
        fetchImpl: async () => response(JSON.stringify({ version: 1, models })),
      });
      if (count <= 2000) expect((await pending).models).toEqual(models);
      else await expect(pending).rejects.toMatchObject({ code: "desktop_snapshot_invalid" });
    }
  });

  test("enforces the 1 MiB streamed cap even without or with a forged content-length", async () => {
    const prefix = '{"version":1,"models":[]}';
    for (const extra of [0, 1]) {
      for (const declared of [undefined, "1"]) {
        const body = prefix + " ".repeat(1024 * 1024 - prefix.length + extra);
        const pending = downloadDesktop3pModels("https://hub.example.test", "ocx_data_test", {
          fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const bytes = new TextEncoder().encode(body);
              controller.enqueue(bytes.subarray(0, 512 * 1024));
              controller.enqueue(bytes.subarray(512 * 1024));
              controller.close();
            },
          }), { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": declared } : {}) } }),
        });
        if (extra === 0) expect(await pending).toEqual({ version: 1, models: [] });
        else await expect(pending).rejects.toMatchObject({ code: "body_too_large" });
      }
    }
  });

  test("rejects wrong content type, malformed JSON and unsafe error causes", async () => {
    for (const [body, type] of [["{remote-marker", "application/json"], ['{"version":1,"models":[]}', "text/html"]]) {
      let caught: unknown;
      try {
        await downloadDesktop3pModels("https://hub.example.test", "secret-marker", {
          fetchImpl: async () => response(body!, { "Content-Type": type! }),
        });
      } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "desktop_snapshot_invalid", message: "Hub Desktop model snapshot was invalid" });
      expect((caught as Error).cause).toBeUndefined();
    }
    let caught: unknown;
    try {
      await downloadDesktop3pModels("https://hub.example.test", "secret-marker", {
        fetchImpl: async () => { throw new Error("secret-marker remote-marker"); },
      });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "unreachable", message: "Hub Desktop model snapshot request failed" });
    expect((caught as Error).cause).toBeUndefined();
  });

  test("normalizes a /v1 URL and accepts JSON-compatible content types", async () => {
    expect(await downloadDesktop3pModels("https://hub.example.test/v1/", "ocx_data_test", {
      fetchImpl: async input => {
        expect(String(input)).toBe("https://hub.example.test/v1/models?ids=desktop&format=desktop-config");
        return response('{"version":1,"models":[]}', { "Content-Type": "application/vnd.opencodex+json; charset=utf-8" });
      },
    })).toEqual({ version: 1, models: [] });
  });

  test("enforces the Desktop total deadline even while a loopback body keeps progressing", async () => {
    const timeoutMs = 1000;
    const observed: {
      headers: boolean;
      chunks: number;
      bytes: number;
      chunksAtDeadline: number;
      signal?: AbortSignal;
    } = { headers: false, chunks: 0, bytes: 0, chunksAtDeadline: 0 };
    let timer: ReturnType<typeof setInterval> | undefined;
    let finishedNaturally = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":1,"models":[]}'));
            let ticks = 0;
            // Progress is twenty times more frequent than the inactivity deadline. The
            // whole valid body is under 100 bytes, so neither inactivity nor size is
            // the intended rejection. A broken total deadline would finish successfully.
            timer = setInterval(() => {
              controller.enqueue(new Uint8Array([0x20]));
              if (++ticks === 40) {
                clearInterval(timer);
                finishedNaturally = true;
                controller.close();
              }
            }, 50);
          },
          cancel() { clearInterval(timer); },
        }), { headers: JSON_HEADERS });
      },
    });
    try {
      await expect(downloadDesktop3pModels(`http://127.0.0.1:${server.port}`, "ocx_data_test", {
        timeoutMs,
        fetchImpl: async (input, init) => {
          observed.signal = init?.signal ?? undefined;
          observed.signal?.addEventListener("abort", () => {
            observed.chunksAtDeadline = observed.chunks;
          }, { once: true });
          const received = await fetch(input, init);
          observed.headers = true;
          // Count bytes actually delivered to the consumer, not merely server enqueues.
          const body = received.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              observed.chunks++;
              observed.bytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }));
          return new Response(body, { status: received.status, headers: received.headers });
        },
      })).rejects.toMatchObject({ code: "unreachable" });
      expect(observed.headers).toBe(true);
      expect(observed.chunksAtDeadline).toBeGreaterThanOrEqual(2);
      expect(observed.signal?.aborted).toBe(true);
      expect(observed.bytes).toBeGreaterThan(0);
      expect(observed.bytes).toBeLessThan(100);
      expect(finishedNaturally).toBe(false);
    } finally {
      clearInterval(timer);
      server.stop(true);
    }
  });

  test("bounds stalled response headers and streamed bodies without exposing their errors", async () => {
    await expect(downloadDesktop3pModels("https://hub.example.test", "ocx_data_test", {
      timeoutMs: 25,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })).rejects.toMatchObject({ code: "unreachable" });
    await expect(downloadDesktop3pModels("https://hub.example.test", "ocx_data_test", {
      timeoutMs: 25,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"version":1,"models":[')); },
      }), { headers: JSON_HEADERS }),
    })).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("remote catalog adversarial consumer", () => {
  test("allows a catalog download to exceed five seconds while bytes keep arriving", async () => {
    const chunks = ['{"models":[', '{"slug":"provider/model"}', ']}'];
    const server = Bun.serve({
      port: 0,
      fetch() {
        let index = 0;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const send = () => {
              const chunk = chunks[index++];
              if (chunk === undefined) return controller.close();
              controller.enqueue(new TextEncoder().encode(chunk));
              if (index < chunks.length) setTimeout(send, 2_600);
              else controller.close();
            };
            send();
          },
        }), { headers: JSON_HEADERS });
      },
    });
    try {
      const result = await downloadClientCatalog(`http://127.0.0.1:${server.port}`, "ocx_data_test");
      expect(JSON.parse(result.body)).toEqual({ models: [{ slug: "provider/model" }] });
    } finally {
      server.stop(true);
    }
  }, { timeout: 8_000 });

  test("fails a stalled catalog download within the explicit inactivity bound", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"models":['));
          },
        }), { headers: JSON_HEADERS });
      },
    });
    const startedAt = performance.now();
    try {
      await expect(downloadClientCatalog(`http://127.0.0.1:${server.port}`, "ocx_data_test", {
        timeoutMs: 50,
      })).rejects.toMatchObject({ code: "unreachable" });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test("accepts additive fields only after the required model schema and key id pass", async () => {
    const body = JSON.stringify({ models: [{ slug: "provider/model", future: { enabled: true } }], futureTop: 1 });
    const result = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => response(body, { ...JSON_HEADERS, "X-OpenCodex-Key-Id": "client-key-1" }),
    });
    // No etag in the result: /v1/catalog emits no validator (Phase 1, D2), and the fixture's
    // ETag header is deliberately left in place to prove the client ignores one even when a
    // hub sends it.
    expect(result).toEqual({ kind: "fresh", body, keyId: "client-key-1" });
  });

  test.each([
    ["malformed JSON", "{", "catalog_invalid"],
    ["null top level", "null", "catalog_schema_invalid"],
    ["array top level", "[]", "catalog_schema_invalid"],
    ["missing models", "{}", "catalog_schema_invalid"],
    ["non-array models", '{"models":{}}', "catalog_schema_invalid"],
    ["non-object row", '{"models":[null]}', "catalog_schema_invalid"],
    ["empty slug", '{"models":[{"slug":""}]}', "catalog_schema_invalid"],
    ["control slug", '{"models":[{"slug":"bad\\u0000slug"}]}', "catalog_schema_invalid"],
    ["duplicate slug", '{"models":[{"slug":"a"},{"slug":"a"}]}', "catalog_schema_invalid"],
  ])("rejects %s without returning writable bytes", async (_label, body, code) => {
    let caught: unknown;
    try {
      await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
        fetchImpl: async () => response(body),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HubClientError);
    expect((caught as HubClientError).code).toBe(code);
  });

  test("rejects 2,001 rows and a forged small Content-Length with oversized chunks", async () => {
    const rows = JSON.stringify({ models: Array.from({ length: 2_001 }, (_, index) => ({ slug: `p/m-${index}` })) });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => response(rows),
    })).rejects.toMatchObject({ code: "catalog_schema_invalid" });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":['));
        controller.enqueue(new Uint8Array(128).fill(0x61));
        controller.close();
      },
    });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      maxBytes: 32,
      fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "application/json", "Content-Length": "1" } }),
    })).rejects.toMatchObject({ code: "body_too_large" });
  });

  test("allows the exact byte cap", async () => {
    const body = '{"models":[]}';
    const exact = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      maxBytes: new TextEncoder().encode(body).byteLength,
      fetchImpl: async () => response(body),
    });
    expect(exact.kind).toBe("fresh");
  });

  test("no request carries a conditional header", async () => {
    // The retry-after-304 branch this replaces existed to recover from a conditional request
    // the client no longer makes. With no validator to send, a 304 is a protocol error
    // (asserted below) rather than something to retry past.
    let sentConditional: boolean | null = null;
    const result = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async (_input, init) => {
        sentConditional = new Headers(init?.headers).has("if-none-match");
        return response('{"models":[]}');
      },
    });
    expect(sentConditional).toBe(false);
    expect(result.kind).toBe("fresh");
  });

  test("any 304 is a protocol error and non-JSON content is refused", async () => {
    // The client sends no conditional request — /v1/catalog emits no validator (Phase 1,
    // D2) — so a 304 can only come from a hub that is misconfigured or being impersonated.
    // Earlier revisions of this phase distinguished "304 with no last-known-good" from
    // "304 whose ETag disagrees with the one we sent"; neither situation is reachable now,
    // and the single refusal below is strictly wider than both.
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response(null, { status: 304 }),
    })).rejects.toMatchObject({ code: "catalog_unexpected_304" });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response(null, { status: 304, headers: { ETag: '"other"' } }),
    })).rejects.toMatchObject({ code: "catalog_unexpected_304" });
    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async () => new Response('{"models":[]}', { headers: { "Content-Type": "text/html" } }),
    })).rejects.toMatchObject({ code: "catalog_content_type_invalid" });
  });
});
