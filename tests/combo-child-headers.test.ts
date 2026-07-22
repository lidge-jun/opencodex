import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { readJsonRequestBody } from "../src/server/request-decompress";
import { buildComboChildHeaders } from "../src/server/responses";

describe("combo child request headers", () => {
  test("strips content-encoding when re-serializing an already-decoded combo body", async () => {
    const payload = {
      model: "combo/xai_grok_fallback",
      input: "hello",
      stream: false,
    };
    const json = JSON.stringify(payload);
    const compressed = zstdCompressSync(Buffer.from(json, "utf8"));

    // Parent request: Codex sends zstd and we decode it once.
    const parent = new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: compressed,
    });
    const decoded = await readJsonRequestBody(parent);
    expect(decoded).toEqual(payload);

    // Child request: combo path re-serializes plain JSON and must not keep zstd.
    const childBody = { ...payload, model: "xai/grok-4.5" };
    const buggyHeaders = new Headers(parent.headers);
    buggyHeaders.delete("content-length");
    await expect(
      readJsonRequestBody(
        new Request(parent.url, {
          method: parent.method,
          headers: buggyHeaders,
          body: JSON.stringify(childBody),
        }),
      ),
    ).rejects.toThrow(/Unknown frame descriptor|Invalid JSON|Unexpected token/i);

    const fixedHeaders = buildComboChildHeaders(parent.headers);
    expect(fixedHeaders.has("content-length")).toBe(false);
    expect(fixedHeaders.has("content-encoding")).toBe(false);
    const childDecoded = await readJsonRequestBody(
      new Request(parent.url, {
        method: parent.method,
        headers: fixedHeaders,
        body: JSON.stringify(childBody),
      }),
    );
    expect(childDecoded).toEqual(childBody);
  });
});
