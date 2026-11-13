import { describe, expect, test } from "bun:test";
import { inspectResponseLogSsePayload, type RequestLogContext } from "../../src/server/request-log";
import { relaySseWithFailedTail } from "../../src/server";
import { relaySseEagerBounded, type EagerRelayHooks } from "../../src/server/relay-eager";
import { createOutboundCredentialMask, createSynthesizedCopyMask, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { OutboundCredentialRegistry, maskSecretSpans, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";

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

const hooks: EagerRelayHooks = {
  inspectChunk() {},
  finishInspection() {},
  sawTerminal: () => false,
  onSynthetic() {},
  onClientCancel() {},
  onDone() {},
};

/**
 * Client output as production composes it: the tee path rewrites each block before the terminal
 * boundary, the eager path feeds the boundary raw frames; both receive the outbound mask.
 */
async function deliver(mode: "tee" | "eager", headers: Record<string, string>, payloads: readonly unknown[], oneChunk = false): Promise<string> {
  const maskCredential = createSynthesizedCopyMask(headers);
  const raw = payloads.map(payload => {
    if (typeof payload === "string") return payload;
    const type = (payload as { type?: unknown }).type;
    return `${typeof type === "string" ? `event: ${type}\n` : ""}data: ${JSON.stringify(payload)}`;
  });
  const chunks = (blocks: string[]): string[] => oneChunk ? [blocks.map(block => `${block}\n\n`).join("")] : blocks.map(block => `${block}\n\n`);
  if (mode === "eager") return drain(relaySseEagerBounded(sourceStream(chunks(raw)), new AbortController(), hooks, { maskCredential }));
  const rewrite = createTerminalErrorRedactionBlockRewrite(headers, createOutboundCredentialMask(headers));
  return drain(relaySseWithFailedTail(sourceStream(chunks(raw.map(block => rewrite(block).join("\n")))), new AbortController(), undefined, { maskCredential }));
}

const terminalTypes = (out: string): string[] => [...out.matchAll(/^event: (response\.[a-z_]+)$/gm)].map(match => match[1]!);

function withRegistry<T>(headers: Record<string, string>, run: () => T): T {
  const registry = new OutboundCredentialRegistry();
  registry.remember(headers);
  const restore = setOutboundCredentialRegistryForTests(registry);
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

describe("untyped error envelopes never carry a value this request sent", () => {
  test.each(["tee", "eager"] as const)("%s never delivers a selected credential from a custom credential header in an untyped error", async mode => {
    // Custom credential headers are recognized by the outbound registry's rule, not only the fixed list.
    const headers = { "x-auth-token": "custom-credential-ALPHA12345", "x-proxy-secret": "Token custom-part-BRAVO67890" };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { message: "echo custom-credential-ALPHA12345 and custom-part-BRAVO67890" } }]);
      expect([out.includes("ALPHA12345"), out.includes("BRAVO67890")]).toEqual([false, false]);
    });
  });

  test.each([
    ["a Digest parameter that is a protocol word", { authorization: 'Digest username="response", response="a1b2c3d4e5f6"' }, true],
    ["a header whose name only contains a credential word", { "x-author": "response" }, false],
    ["a full credential that equals a protocol name", { "x-auth-token": "response" }, false],
  ] as const)("masking keeps the terminal frame's protocol fields: %s", (_name, headers, digestSent) => {
    const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "echo a1b2c3d4e5f6" } } };
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    expect(out).toContain("event: response.failed");
    const parsed = JSON.parse(out.slice(out.indexOf("data: ") + "data: ".length));
    // The Digest response value is still a credential this request sent, so its echo is masked.
    expect([parsed.type, parsed.response?.status, out.includes("a1b2c3d4e5f6")]).toEqual(["response.failed", "failed", !digestSent]);
  });

  test("overlapping selected credentials are masked as one span", () => {
    const mask = createOutboundCredentialMask({ authorization: "Bearer abcdefghijkl", "x-api-key": "ijklmnopqrst" });
    expect(mask("denied abcdefghijklmnopqrst")).toBe("denied [REDACTED]");
  });

  test("repeated and overlapping occurrences are masked as merged runs", () => {
    expect(maskSecretSpans("xaaaybaab", "[R]", ["a", "aab"])).toBe("x[R]yb[R]");
    expect(maskSecretSpans("a".repeat(100_000) + "z", "[R]", ["a"])).toBe("[R]z");
  });

  test.each(["tee", "eager"] as const)("%s untyped policy terminal carries no upstream field beyond its guarded message", async mode => {
    const sent = "custom-value-987654321";
    const headers = { "x-custom": sent };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { code: "cyber_policy", type: sent, message: "blocked" }, extra: sent, response: { note: sent } }]);
      expect(out).not.toContain(sent);
      expect([out.includes("event: response.failed"), out.includes('"code":"cyber_policy"')]).toEqual([true, true]);
    });
  });

  test.each(["tee", "eager"] as const)("%s never delivers the untyped frame, its extra fields or its keys", async mode => {
    await withRegistry({ "x-tenant": "tenantSecret123" }, async () => {
      const sent = "tenantSecret123";
      const out = await deliver(mode, { "x-tenant": sent }, [{ error: { code: "mystery_code", message: "fixture", [sent]: "as a key" }, extra: `echo ${sent}` }]);
      expect(out).not.toContain(sent);
      expect(out).not.toContain('"extra"');
      expect(out).toContain("event: response.failed");
    });
  });

  test.each([
    ["tee", "a custom header value", { "x-tenant": "opaque-secret-12345" }, "opaque-secret-12345"],
    ["eager", "a custom header value", { "x-tenant": "opaque-secret-12345" }, "opaque-secret-12345"],
    ["tee", "a short Basic password", { authorization: "Basic YWNjb3VudGxvbmc6cGluNDI=" }, "pin42"],
    ["eager", "a short Basic password", { authorization: "Basic YWNjb3VudGxvbmc6cGluNDI=" }, "pin42"],
  ] as const)("%s tail never repeats %s this request sent", async (mode, _name, headers, echoed) => {
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { code: "mystery_code", message: echoed } }]);
      expect(out).not.toContain(echoed);
      expect(out).toContain("event: response.failed");
    });
  });

  test.each(["tee", "eager"] as const)("%s keeps a refusal whose copy repeats a sent value", async mode => {
    const headers = { "x-tenant": "opaque-secret-12345" };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { message: "This request was blocked by our safety systems. opaque-secret-12345" } }]);
      expect(out).not.toContain("opaque-secret-12345");
      expect([out.includes("event: response.failed"), out.includes('"code":"invalid_prompt"')]).toEqual([true, true]);
    });
  });

  test.each(["tee", "eager"] as const)("%s classifies a recognized code that equals a sent value the same as the inspector", async mode => {
    const headers = { "x-tenant": "rate_limit_exceeded" };
    await withRegistry(headers, async () => {
      const frame = { error: { code: "rate_limit_exceeded", message: "try again" } };
      const out = await deliver(mode, headers, [frame]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify(frame));
      // The class is read from the provider's own frame; the code word equals a sent value, so it stays masked.
      expect([out.includes("upstream_server_error"), out.includes('"type":"rate_limit_error"'), log.terminalHttpStatus]).toEqual([false, true, 429]);
    });
  });

  test.each(["tee", "eager"] as const)("%s never repeats a sent value too large for the registry", async mode => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const huge = Array.from({ length: 16_400 }, (_, i) => alphabet[(i * 7 + (i >> 5)) % alphabet.length]).join("");
    const headers = { "x-tenant": huge };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { message: `echo ${huge}` } }]);
      expect([out.includes(huge.slice(0, 64)), out.includes(huge.slice(8_000, 8_064))]).toEqual([false, false]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { message: `echo ${huge}` } }));
      expect(log.upstreamError ?? "").not.toContain(huge.slice(0, 64));
    });
  });

  test.each(["tee", "eager"] as const)("%s never repeats any excerpt of a sent value too large for the registry", async mode => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const huge = Array.from({ length: 17_280 }, (_, i) => alphabet[(i * 7 + (i >> 5)) % alphabet.length]).join("");
    const excerpt = huge.slice(80, 180);
    const headers = { "x-tenant": huge };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { message: excerpt } }]);
      expect(out).not.toContain(excerpt);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { message: excerpt } }));
      expect(log.upstreamError ?? "").not.toContain(excerpt);
    });
  });

  test.each(["tee", "eager"] as const)("%s classifies a recognized code that equals a selected credential the same as the inspector", async mode => {
    const headers = { "x-auth-token": "rate_limit_exceeded" };
    await withRegistry(headers, async () => {
      const frame = { error: { code: "rate_limit_exceeded", message: "try again" } };
      const out = await deliver(mode, headers, [frame]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify(frame));
      // The class is read from the provider's own frame; the code word itself is the credential, so it stays masked.
      expect([out.includes("upstream_server_error"), out.includes('"type":"rate_limit_error"'), log.terminalHttpStatus]).toEqual([false, true, 429]);
    });
  });

  test.each(["tee", "eager"] as const)("%s keeps frames that mask alike apart: the verdict follows the provider's own frames", async mode => {
    const headers = { "x-auth-token": "cyber_policy" };
    await withRegistry(headers, async () => {
      const frames = [
        { error: { code: "[REDACTED]", message: "fixture" } },
        { type: "error", code: "rate_limit_exceeded", message: "typed quota" },
        { error: { code: "cyber_policy", message: "fixture" } },
      ];
      const out = await deliver(mode, headers, frames, true);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      for (const frame of frames) inspectResponseLogSsePayload(log, JSON.stringify(frame));
      expect([out.includes('"code":"cyber_policy"'), log.terminalHttpStatus]).toEqual([false, 429]);
    });
  });

  test.each(["tee", "eager"] as const)("%s keeps a policy verdict ahead of many later untyped frames in one chunk", async mode => {
    const headers = { "x-auth-token": "cyber_policy" };
    await withRegistry(headers, async () => {
      const frames = [{ error: { code: "cyber_policy", message: "blocked" } },
        ...Array.from({ length: 9 }, (_, i) => ({ error: { code: "mystery_code", message: `later cyber_policy ${i}` } }))];
      const out = await deliver(mode, headers, frames, true);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      for (const frame of frames) inspectResponseLogSsePayload(log, JSON.stringify(frame));
      expect([terminalTypes(out), out.includes("upstream_server_error"), log.terminalHttpStatus]).toEqual([["response.failed"], false, 400]);
    });
  });

  test.each(["tee", "eager"] as const)("%s ends the stream on an untyped policy terminal", async mode => {
    const headers = { "x-auth-token": "cyber_policy" };
    await withRegistry(headers, async () => {
      const completed = { type: "response.completed", response: { status: "completed" } };
      for (const tail of [[completed], []]) {
        const out = await deliver(mode, headers, [{ error: { code: "cyber_policy", message: "blocked" } }, ...tail]);
        expect(terminalTypes(out)).toEqual(["response.failed"]);
      }
    });
  });

  test.each(["tee", "eager"] as const)("%s untyped policy terminal withholds its copy while the registry is incomplete", async mode => {
    const registry = new OutboundCredentialRegistry({ maxValueBytes: 16 });
    const headers = { "x-custom": "a-value-longer-than-sixteen-bytes" };
    registry.remember(headers);
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      expect(registry.complete()).toBe(false);
      const out = await deliver(mode, headers, [{ error: { code: "cyber_policy", message: "blocked fixture-copy" }, extra: "fixture-extra" }]);
      expect([out.includes("fixture-copy"), out.includes("fixture-extra"), out.includes('"code":"cyber_policy"')]).toEqual([false, false, true]);
    } finally { restore(); }
  });

  test.each(["tee", "eager"] as const)("%s untyped policy terminal is a fresh block without upstream lines", async mode => {
    const sent = "custom-value-987654321";
    const headers = { "x-tenant": sent };
    await withRegistry(headers, async () => {
      const block = `: comment ${sent}\nevent: ${sent}\ndata: ${JSON.stringify({ error: { code: "cyber_policy", message: "blocked" } })}`;
      const out = await deliver(mode, headers, [block]);
      expect(out).not.toContain(sent);
      expect(terminalTypes(out)).toEqual(["response.failed"]);
    });
  });

  test.each(["tee", "eager"] as const)("%s refuses a sent value the global registry no longer holds", async mode => {
    const sent = "tenant-secret-example-12345";
    const restore = setOutboundCredentialRegistryForTests(new OutboundCredentialRegistry());
    try {
      const out = await deliver(mode, { "x-tenant": sent }, [{ error: { code: "mystery_code", message: `echo ${sent}` } }]);
      expect([out.includes(sent), out.includes("event: response.failed")]).toEqual([false, true]);
    } finally { restore(); }
  });

  test.each([
    ["unparsable JSON", 'data: {"message":"fixture-selected-credential"'],
    ["a non-target JSON payload", `data: ${JSON.stringify({ type: "other", message: "fixture-selected-credential" })}`],
  ] as const)("a terminal frame with %s still has its data masked", (_name, data) => {
    const credential = "fixture-selected-credential";
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: `Bearer ${credential}` });
    const out = rewrite(`event: response.failed\n${data}`).join("\n");
    expect([out.includes("fixture-selected-credential"), out.startsWith("event: response.failed")]).toEqual([false, true]);
  });

  test("a sensitive key keeps its redaction when the selected credential is a substring of it", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: "Bearer auth" });
    const failed = { type: "response.failed", response: { status: "failed", error: { message: "fixture", authorization: "fixture-unpatterned-value-8415" } } };
    const block = `event: response.failed\ndata: ${JSON.stringify(failed)}`;
    expect(rewrite(block).join("\n")).not.toContain("fixture-unpatterned-value-8415");
  });
});
