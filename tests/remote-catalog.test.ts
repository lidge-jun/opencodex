import { describe, expect, test } from "bun:test";
import { downloadClientCatalog, HubClientError } from "../src/client/hub-client";

const JSON_HEADERS = { "Content-Type": "application/json", ETag: '"catalog-v1"' };

function response(body: string, headers: HeadersInit = JSON_HEADERS): Response {
  return new Response(body, { headers });
}

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
