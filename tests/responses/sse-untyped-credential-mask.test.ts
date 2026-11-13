import { describe, expect, test } from "bun:test";
import { inspectResponseLogSsePayload, type RequestLogContext } from "../../src/server/request-log";
import { relaySseWithFailedTail } from "../../src/server";
import { createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { OutboundCredentialRegistry, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sourceStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe("untyped error envelopes never carry a value this request sent", () => {
  test("a selected credential in a custom credential header is masked in an untyped error", () => {
    // Custom credential headers are recognized by the outbound registry's rule, not only the fixed list.
    const custom = createTerminalErrorRedactionBlockRewrite({ "x-auth-token": "custom-credential-ALPHA12345", "x-proxy-secret": "Token custom-part-BRAVO67890" });
    const echoed = custom(`data: ${JSON.stringify({ error: { message: "echo custom-credential-ALPHA12345 and custom-part-BRAVO67890" } })}`).join("\n");
    expect([echoed.includes("ALPHA12345"), echoed.includes("BRAVO67890")]).toEqual([false, false]);
  });

  test.each([
    ["a Digest parameter that is a protocol word", { authorization: 'Digest username="response", response="a1b2c3d4e5f6"' }, true],
    ["a header whose name only contains a credential word", { "x-author": "response" }, false],
  ] as const)("masking keeps the terminal frame's protocol fields: %s", (_name, headers, digestSent) => {
    const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "echo a1b2c3d4e5f6" } } };
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    expect(out).toContain("event: response.failed");
    const parsed = JSON.parse(out.slice(out.indexOf("data: ") + "data: ".length));
    // The Digest response value is still a credential this request sent, so its echo is masked.
    expect([parsed.type, parsed.response?.status, out.includes("a1b2c3d4e5f6")]).toEqual(["response.failed", "failed", !digestSent]);
  });

  test.each([
    ["a custom header value", { "x-tenant": "opaque-secret-12345" }, "opaque-secret-12345"],
    ["a short Basic password", { authorization: "Basic YWNjb3VudGxvbmc6cGluNDI=" }, "pin42"],
  ] as const)("an untyped error repeating %s this request sent is masked", (_name, headers, echoed) => {
    const registry = new OutboundCredentialRegistry();
    registry.remember(headers);
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
      const out = rewrite(`data: ${JSON.stringify({ error: { code: "mystery_code", message: echoed } })}`).join("\n");
      expect(out).not.toContain(echoed);
      expect(JSON.parse(out.slice("data: ".length)).error.code).toBe("mystery_code");
    } finally { restore(); }
  });

  test("masking a sent value inside untyped refusal copy keeps the refusal for the relay tail", async () => {
    const headers = { "x-tenant": "opaque-secret-12345" };
    const registry = new OutboundCredentialRegistry();
    registry.remember(headers);
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
      const raw = `data: ${JSON.stringify({ error: { message: "This request was blocked by our safety systems. opaque-secret-12345" } })}\n\n`;
      const rewritten = rewrite(raw.trimEnd()).join("\n") + "\n\n";
      const out = await drain(relaySseWithFailedTail(sourceStream([rewritten]), new AbortController()));
      expect(out).not.toContain("opaque-secret-12345");
      expect([out.includes("event: response.failed"), out.includes('"code":"invalid_prompt"')]).toEqual([true, true]);
    } finally { restore(); }
  });

  test("a value this request sent is masked in an untyped frame's extra fields and keys", () => {
    const restore = setOutboundCredentialRegistryForTests(new OutboundCredentialRegistry());
    try {
      const sent = "tenantSecret123";
      const rewrite = createTerminalErrorRedactionBlockRewrite({ "x-tenant": sent });
      const out = rewrite(`data: ${JSON.stringify({ error: { message: "fixture", [sent]: "as a key" }, extra: `echo ${sent}` })}`).join("\n");
      expect(out).not.toContain(sent);
    } finally { restore(); }
  });

  test("overlapping recorded values are masked as one span", () => {
    const registry = new OutboundCredentialRegistry();
    registry.remember({ "x-first": "abcdefghijkl", "x-second": "ijklmnopqrst" });
    expect(registry.mask("denied abcdefghijklmnopqrst", "[REDACTED]")).toBe("denied [REDACTED]");
  });

  test("a sent value too large for the registry is still masked and recognized in bounded copy", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const huge = Array.from({ length: 16_400 }, (_, i) => alphabet[(i * 7 + (i >> 5)) % alphabet.length]).join("");
    const headers = { "x-tenant": huge };
    const registry = new OutboundCredentialRegistry();
    registry.remember(headers);
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const out = createTerminalErrorRedactionBlockRewrite(headers)(`data: ${JSON.stringify({ error: { message: `echo ${huge}` } })}`).join("\n");
      expect([out.includes(huge.slice(0, 64)), out.includes(huge.slice(8_000, 8_064))]).toEqual([false, false]);
      expect([registry.matches(`echo ${huge}`.slice(0, 500)), registry.matches(huge.slice(3_000, 3_400))]).toEqual([true, true]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { message: `echo ${huge}` } }));
      expect(log.upstreamError ?? "").not.toContain(huge.slice(0, 64));
    } finally { restore(); }
  });

  test("a sensitive key keeps its redaction when the selected credential is a substring of it", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: "Bearer auth" });
    const block = `data: ${JSON.stringify({ error: { message: "fixture", authorization: "fixture-unpatterned-value-8415" } })}`;
    expect(rewrite(block).join("\n")).not.toContain("fixture-unpatterned-value-8415");
  });
});
