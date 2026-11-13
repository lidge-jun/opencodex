import { describe, expect, test } from "bun:test";
import { addFinalRequestLog, inspectResponseLogSsePayload, type RequestLogContext } from "../../src/server/request-log";
import { relaySseWithFailedTail } from "../../src/server";
import { relaySseEagerBounded, type EagerRelayHooks } from "../../src/server/relay-eager";
import { createForwardedEvidenceRedaction, createOutboundCredentialMask, createSynthesizedCopyMask, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { OutboundCredentialRegistry, createSentValueGuard, maskSecretSpans, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";
import { noteRelaySyntheticTail, noteRequestSentValueGuard } from "../../src/server/request-log-terminal-status";
import { reduceBareUpstreamEvidence } from "../../src/server/bare-upstream-error";

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
  const exact = createOutboundCredentialMask(headers);
  const rewrite = createTerminalErrorRedactionBlockRewrite(headers, exact);
  const redactForwardedEvidence = createForwardedEvidenceRedaction(headers, exact);
  // Production eager delivery applies the client rewrite to what its boundary emits.
  if (mode === "eager") return drain(relaySseEagerBounded(sourceStream(chunks(raw)), new AbortController(), { ...hooks, rewriteBlocks: rewrite }, { maskCredential, redactForwardedEvidence }));
  return drain(relaySseWithFailedTail(sourceStream(chunks(raw.map(block => rewrite(block).join("\n")))), new AbortController(), undefined, { maskCredential, redactForwardedEvidence }));
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

  test.each(["tee", "eager"] as const)("%s typed error under a terminal event line classifies like the inspector when its code equals a credential", async mode => {
    const credential = "rate_limit_exceeded";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      const frame = { type: "error", code: "rate_limit_exceeded", message: "busy" };
      const out = await deliver(mode, headers, [`event: response.failed\ndata: ${JSON.stringify(frame)}`]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify(frame));
      expect([out.includes("upstream_server_error"), out.includes('"type":"rate_limit_error"'), log.terminalHttpStatus]).toEqual([false, true, 429]);
    });
  });

  test.each([["tee", "one chunk"], ["tee", "split chunks"], ["eager", "one chunk"], ["eager", "split chunks"]] as const)("%s emits one [DONE] around an untyped policy terminal in %s", async (mode, delivery) => {
    const oneChunk = delivery === "one chunk";
    const headers = { "x-auth-token": "fixture-token-8415" };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, ["data: [DONE]", { error: { code: "cyber_policy", message: "blocked" } }, "data: [DONE]"], oneChunk);
      expect([terminalTypes(out), out.split("[DONE]").length - 1]).toEqual([["response.failed"], 1]);
    });
  });

  test.each(["tee", "eager"] as const)("%s never repeats an 8+ character excerpt of a sent credential in a tail or policy terminal", async mode => {
    const credential = "abcdefghijklmnopqrstuv123456";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      for (const frame of [{ error: { code: "mystery_code", message: "echo ijklmnopqrstuv12" } }, { error: { code: "cyber_policy", message: "blocked ijklmnopqrstuv12" } }]) {
        const out = await deliver(mode, headers, [frame]);
        expect([out.includes("ijklmnopqrstuv12"), out.includes("event: response.failed")]).toEqual([false, true]);
      }
    });
  });

  test("a request row never keeps an 8+ character excerpt of a sent credential", () => {
    const credential = "abcdefghijklmnopqrstuv123456";
    const headers = { authorization: `Bearer ${credential}` };
    withRegistry(headers, () => {
      for (const frame of [{ error: { code: "mystery_code", message: "echo ijklmnopqrstuv12" } },
        { type: "response.failed", response: { status: "failed", error: { message: "echo ijklmnopqrstuv12" } } }]) {
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        noteRequestSentValueGuard(log, createSentValueGuard(headers));
        inspectResponseLogSsePayload(log, JSON.stringify(frame));
        expect(log.upstreamError ?? "").not.toContain("ijklmnopqrstuv12");
      }
    });
  });

  test.each([
    ["tee", "unparsable JSON"], ["eager", "unparsable JSON"], ["tee", "a non-target JSON payload"], ["eager", "a non-target JSON payload"],
  ] as const)("%s terminal frame with %s never carries a sent custom value", async (mode, shape) => {
    const sent = "tenantOpaque987654";
    const headers = { "x-tenant": sent };
    await withRegistry(headers, async () => {
      const data = shape === "unparsable JSON" ? `data: {"message":"${sent}"` : `data: ${JSON.stringify({ type: "other", message: sent })}`;
      const out = await deliver(mode, headers, [`event: response.failed\n${data}`]);
      expect(out).not.toContain(sent);
    });
  });

  test("the sent-value guard reads excerpts of tokens, not of schemes or field names", () => {
    const token = "fixture-key";
    const guard = createSentValueGuard({ authorization: `Bearer ${token}`, cookie: "session=opaqueCookieValue42" });
    expect([
      guard("Upstream stream terminated unexpectedly: fixture reset"),
      guard("the session=expired notice"),
      guard("echo ixture-k"),
      guard("echo queCookieVal"),
    ]).toEqual([false, false, true, true]);
  });

  test("a request row's diagnostic code never keeps an excerpt of a sent credential", () => {
    const credential = "abcdefghijklmnopqrstuv123456";
    const headers = { authorization: `Bearer ${credential}` };
    withRegistry(headers, () => {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      noteRequestSentValueGuard(log, createSentValueGuard(headers));
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { code: "ijklmnopqrstuv12", message: "fixture" } }));
      const rows: unknown[] = [];
      addFinalRequestLog("excerpt-code", 0, log, 502, { terminalStatus: "failed" }, entry => rows.push(entry));
      expect([log.upstreamErrorCode, JSON.stringify(rows).includes("ijklmnopqrstuv12")]).toEqual([undefined, false]);
    });
  });

  test.each([
    ["tee", "a non-target JSON message"], ["eager", "a non-target JSON message"], ["tee", "unparsable data"], ["eager", "unparsable data"],
  ] as const)("%s never emits a sent value placed past the guard's scan window in %s", async (mode, shape) => {
    const sent = "tenantOpaque987654";
    const headers = { "x-tenant": sent };
    await withRegistry(headers, async () => {
      const padded = `${"p".repeat(8_192)}${sent}`;
      const data = shape === "unparsable data" ? `data: {"message":"${padded}"` : `data: ${JSON.stringify({ type: "other", message: padded })}`;
      const out = await deliver(mode, headers, [`event: response.failed\n${data}`]);
      expect(out).not.toContain(sent);
    });
  });

  test.each(["tee", "eager"] as const)("%s never emits a sent value as a non-target terminal key or an SSE comment", async mode => {
    const sent = "tenantOpaque987654";
    const headers = { "x-tenant": sent };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [`event: response.failed\n: ${sent}\ndata: ${JSON.stringify({ type: "other", [sent]: "as a key" })}`]);
      expect(out).not.toContain(sent);
    });
  });

  test.each(["tee", "eager"] as const)("%s keeps refusal copy that repeats a sent value classifiable under a terminal event line", async mode => {
    const sent = "opaque-secret-12345";
    const headers = { "x-tenant": sent };
    await withRegistry(headers, async () => {
      const frame = { type: "error", message: `This request was blocked by our safety systems. ${sent}` };
      const out = await deliver(mode, headers, [`event: response.failed\ndata: ${JSON.stringify(frame)}`]);
      expect([out.includes(sent), out.includes('"code":"invalid_prompt"'), out.includes("upstream_server_error")]).toEqual([false, true, false]);
    });
  });

  test("synthesized copy keeps a public error identity that equals a sent value", () => {
    const mask = createSynthesizedCopyMask({ "x-custom": "rate_limit_exceeded" });
    expect([mask("rate_limit_exceeded"), mask("rate_limit_error"), mask("echo rate_limit_exceeded")]).toEqual(["rate_limit_exceeded", "rate_limit_error", "[REDACTED]"]);
  });

  test.each(["tee", "eager"] as const)("%s classifies a refusal whose wording overlaps a sent value from the provider's own frame", async mode => {
    const headers = { "x-tenant": "safety systems" };
    await withRegistry(headers, async () => {
      const frame = { type: "error", message: "This request was blocked by our safety systems." };
      const out = await deliver(mode, headers, [`event: response.failed\ndata: ${JSON.stringify(frame)}`]);
      expect([out.includes("safety systems"), out.includes('"code":"invalid_prompt"'), out.includes("upstream_server_error")]).toEqual([false, true, false]);
    });
  });

  test.each(["tee", "eager"] as const)("%s masks a sent credential in a typed error frame it forwards", async mode => {
    const credential = "fixture-forwarded-cred-8415";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ type: "error", code: "mystery_code", message: `echo ${credential}` }]);
      expect(out).not.toContain(credential);
    });
  });

  test.each(["tee", "eager"] as const)("%s never repeats an excerpt of a sent credential that contains '='", async mode => {
    const headers = { "x-api-key": "abcdefghijk=ZYXWVUTS987" };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [{ error: { code: "abcdefghijk", message: "echo abcdefghijk" } }]);
      expect(out).not.toContain("abcdefghijk");
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      noteRequestSentValueGuard(log, createSentValueGuard(headers));
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { code: "abcdefghijk", message: "echo abcdefghijk" } }));
      expect(`${log.upstreamError ?? ""} ${log.upstreamErrorCode ?? ""}`).not.toContain("abcdefghijk");
    });
  });

  test.each(["tee", "eager"] as const)("%s typed policy terminal never keeps a sent value in its own lines", async mode => {
    const credential = "abcdefghijklmnop123456";
    const headers = { "x-auth-token": credential };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [`: ${credential}\ndata: ${JSON.stringify({ type: "error", code: "cyber_policy", message: "blocked" })}`]);
      expect([out.includes(credential), out.includes('"code":"cyber_policy"')]).toEqual([false, true]);
    });
  });

  test.each(["tee", "eager"] as const)("%s never emits a sent value as a JSON number", async mode => {
    const headers = { "x-tenant": "123456789" };
    await withRegistry(headers, async () => {
      const typed = await deliver(mode, headers, [{ type: "error", code: "mystery_code", message: "fixture", extra: 123456789 }]);
      const policy = await deliver(mode, headers, [{ error: { code: "cyber_policy", message: "blocked" }, sequence_number: 123456789 }]);
      expect([typed.includes("123456789"), policy.includes("123456789")]).toEqual([false, false]);
    });
  });

  test("excerpt indexing fails closed instead of growing past its cap", () => {
    const guard = createSentValueGuard({ authorization: `Bearer ${"a".repeat(200_000)}` });
    expect(guard("ordinary copy")).toBe(true);
  });

  test.each(["tee", "eager"] as const)("%s turns a genuine terminal into the policy terminal when masking removes its policy wording", async mode => {
    const headers = { "x-auth-token": "high-risk cybersecurity" };
    await withRegistry(headers, async () => {
      const incomplete = { type: "response.incomplete", response: { status: "incomplete", error: { message: "high-risk cybersecurity" } } };
      const out = await deliver(mode, headers, [`event: response.incomplete\ndata: ${JSON.stringify(incomplete)}`]);
      expect([terminalTypes(out), out.includes('"code":"cyber_policy"'), out.includes("high-risk cybersecurity")]).toEqual([["response.failed"], true, false]);
    });
  });

  test.each(["tee", "eager"] as const)("%s never forwards a sent credential as a provider event name", async mode => {
    const credential = "fixturecredential123456";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      const typed = await deliver(mode, headers, [`event: ${credential}\ndata: ${JSON.stringify({ type: "error", code: "unknown", message: "upstream failed" })}`]);
      const policy = await deliver(mode, headers, [`event: error\nevent: ${credential}\ndata: ${JSON.stringify({ type: "error", code: "cyber_policy", message: "blocked" })}`]);
      expect([typed.includes(credential), policy.includes(credential), policy.includes('"code":"cyber_policy"')]).toEqual([false, false, true]);
    });
  });

  test("a client-stream row keeps the relay's refusal verdict when a forwarded copy masked its wording", async () => {
    const headers = { "x-tenant": "safety systems" };
    await withRegistry(headers, async () => {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const frame = { type: "error", message: "This request was blocked by our safety systems." };
      const exact = createOutboundCredentialMask(headers);
      const relayed = await drain(relaySseWithFailedTail(sourceStream([`data: ${JSON.stringify(frame)}\n\n`]), new AbortController(), undefined, {
        maskCredential: createSynthesizedCopyMask(headers),
        redactForwardedEvidence: createForwardedEvidenceRedaction(headers, exact),
        onSyntheticTail: (payload, verdict) => noteRelaySyntheticTail(log, payload, verdict),
      }));
      // The WebSocket observer reads every client frame into the row.
      for (const block of relayed.split("\n\n")) {
        const data = block.split("\n").find(line => line.startsWith("data: "))?.slice("data: ".length);
        if (data && data !== "[DONE]") inspectResponseLogSsePayload(log, data);
      }
      expect([relayed.includes("safety systems"), log.terminalHttpStatus]).toEqual([false, 400]);
    });
  });

  test.each([["tee", "\r"], ["eager", "\r"], ["tee", "\r\n"], ["eager", "\r\n"]] as const)("%s masks extension lines whatever the line ending (%j)", async (mode, eol) => {
    const credential = "secretABC123456";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      const block = `data: ${JSON.stringify({ type: "error", error: { message: "oops" } })}${eol}event: ${credential}${eol}: ${credential}`;
      const out = await deliver(mode, headers, [block]);
      expect(out).not.toContain(credential);
    });
  });

  test.each(["tee", "eager"] as const)("%s emits the held [DONE] as the bare sentinel, without its upstream lines", async mode => {
    const credential = "secretABC123456";
    const headers = { authorization: `Bearer ${credential}` };
    await withRegistry(headers, async () => {
      const out = await deliver(mode, headers, [`: ${credential}\ndata: [DONE]`, { error: { code: "cyber_policy", message: "blocked" } }], true);
      expect([out.includes(credential), out.split("[DONE]").length - 1, terminalTypes(out)]).toEqual([false, 1, ["response.failed"]]);
    });
  });

  test.each(["tee", "eager"] as const)("%s masks credential excerpts in a genuine terminal and keeps it whole otherwise", async mode => {
    const credential = "secretABC123456";
    const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
    await withRegistry(headers, async () => {
      const longText = "x".repeat(10_000) + "END-OF-OUTPUT";
      const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "echo ABC12345 in application/json" },
        output: [{ type: "message", content: [{ type: "output_text", text: longText }] }] } };
      const out = await deliver(mode, headers, [`event: response.failed\ndata: ${JSON.stringify(failed)}`]);
      expect([out.includes("ABC12345"), out.includes("application/json"), out.includes("END-OF-OUTPUT")]).toEqual([false, true, true]);
    });
  });

  test("a sensitive key keeps its redaction when the selected credential is a substring of it", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: "Bearer auth" });
    const failed = { type: "response.failed", response: { status: "failed", error: { message: "fixture", authorization: "fixture-unpatterned-value-8415" } } };
    const block = `event: response.failed\ndata: ${JSON.stringify(failed)}`;
    expect(rewrite(block).join("\n")).not.toContain("fixture-unpatterned-value-8415");
  });

  test("excerpt masking of a large genuine terminal stays linear in the frame size", () => {
    // Every distinct matching window used to rescan the whole text: about 64k windows over a ~4 MB
    // frame stalled the event loop for seconds. One marking pass keeps it to tens of milliseconds.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const credentials = [1, 2, 3, 4].map(seed => {
      let state = seed;
      let value = "";
      for (let i = 0; i < 16_000; i++) { state = (state * 1103515245 + 12345) & 0x7fffffff; value += alphabet[state % 62]; }
      return value;
    });
    const rewrite = createTerminalErrorRedactionBlockRewrite(Object.fromEntries(credentials.map((value, i) => [`x-api-key-${i}`, value])));
    const echoed = credentials.map(value => value.slice(0, -1)).join(" ");
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: echoed + " " + "z".repeat(3_900_000 - echoed.length) } } };
    const startedAt = performance.now();
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    const elapsed = performance.now() - startedAt;
    expect(credentials.some(value => out.includes(value.slice(100, 140)))).toBe(false);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("exact masking of a self-overlapping credential stays linear in the frame size", () => {
    // Restarting the search one character after each match rechecked the long overlapping secret at
    // every position: a 16,000-character repetitive key over a 1 MB message took seconds.
    const credential = "a".repeat(16_000);
    const rewrite = createTerminalErrorRedactionBlockRewrite({ "x-api-key": credential });
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: `keep ${"a".repeat(1_000_000)} tail` } } };
    const startedAt = performance.now();
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    const elapsed = performance.now() - startedAt;
    expect([out.includes("aaaaaaaa"), out.includes("keep [REDACTED] tail")]).toEqual([false, true]);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("exact masking stays linear with many repeated or self-overlapping credentials", () => {
    // One full-text scan per secret, duplicates included, took seconds for 100 headers over ~4 MB.
    const repeated = createTerminalErrorRedactionBlockRewrite(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`x-api-key-${i}`, "aaaaaaaa"])));
    const overlapping = Array.from({ length: 100 }, (_, i) => `ab${String(i).padStart(6, "0")}ab`);
    const distinct = createTerminalErrorRedactionBlockRewrite(Object.fromEntries(overlapping.map((value, i) => [`x-api-key-${i}`, value])));
    const frame = (message: string) => `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message } } })}`;
    const startedAt = performance.now();
    const repeatedOut = repeated(frame("a".repeat(3_900_000))).join("\n");
    const distinctOut = distinct(frame(`${overlapping.join(" ")} ${"q".repeat(3_900_000)}`)).join("\n");
    const elapsed = performance.now() - startedAt;
    expect([repeatedOut.includes("aaaaaaaa"), overlapping.some(value => distinctOut.includes(value))]).toEqual([false, false]);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("exact masking stays linear with thousands of distinct credential components", () => {
    // One native search per distinct component, each over the whole text: thousands of components
    // of one header over ~4 MB took seconds. One lookup pass over the text finds them all.
    const components = Array.from({ length: 20_000 }, (_, i) => `c${String(i).padStart(8, "0")}`);
    const rewrite = createTerminalErrorRedactionBlockRewrite({ "x-api-key": components.join(" ") });
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: `${components.slice(0, 50).join(" ")} ${"q".repeat(3_900_000)}` } } };
    const startedAt = performance.now();
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    const elapsed = performance.now() - startedAt;
    expect(components.slice(0, 50).some(value => out.includes(value))).toBe(false);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("exact masking stays linear when a long credential's prefix repeats near the end of a frame", () => {
    // Each candidate rebuilt the credential's border table before any budget was charged, even
    // where the credential could not fit in the text left: a 1 MB credential took seconds.
    const n = 1_000_000;
    const tailRun = Math.floor(Math.sqrt(8 * n));
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: `Bearer ${"a".repeat(n - 1)}b` });
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "z".repeat(n - tailRun) + "a".repeat(tailRun) } } };
    const startedAt = performance.now();
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    expect(out).not.toContain("aaaaaaaa");
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  test("a prefix shared by absent self-overlapping credentials keeps the rest of a terminal", () => {
    // Every self-overlapping credential started a full scan at its 8-character prefix, present or
    // not, so ten keys sharing "sk-proj-" exhausted the budget and blanked an ordinary message.
    const headers = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`x-api-key-${i}`, `sk-proj-${i}-abcdefghijklmnop-s`]));
    const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
    const message = `sk-proj- is a project key prefix. ${"ordinary text ".repeat(12_000)}END-OF-MESSAGE`;
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message } } };
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    expect([out.includes("is a project key prefix"), out.includes("END-OF-MESSAGE")]).toEqual([true, true]);
  });

  test("masking a terminal with many fields stays linear in the frame, not fields times credentials", () => {
    // The exact mask rebuilt and walked its secret set for every string of the frame: thousands of
    // short metadata strings times thousands of credential components stalled the rewrite.
    const components = Array.from({ length: 5_000 }, (_, i) => `k${String(i).padStart(8, "0")}`);
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: `Bearer ${components.join(",")}` });
    const metadata = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`m${i}`, `value-${i}`]));
    const failed = { type: "response.failed", response: { status: "failed", metadata, error: { code: "server_error", message: `echo ${components[7]}` } } };
    const startedAt = performance.now();
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    const elapsed = performance.now() - startedAt;
    expect([out.includes(components[7]!), out.includes("value-19999")]).toEqual([false, true]);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("repeated mentions of a prefix several credentials share keep the rest of a terminal", () => {
    // Each candidate was charged its full length before comparing, so five sk-proj- keys and a
    // response that mentions the prefix twenty times exhausted the budget and blanked the output.
    const headers = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-api-key-${i}`, `sk-proj-${String(i).repeat(79)}`]));
    const rewrite = createTerminalErrorRedactionBlockRewrite(headers);
    const text = `${"The sk-proj- prefix identifies a project key. ".repeat(20)}END-OF-OUTPUT`;
    const failed = { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "failed" },
      output: [{ type: "message", content: [{ type: "output_text", text }] }] } };
    const out = rewrite(`event: response.failed\ndata: ${JSON.stringify(failed)}`).join("\n");
    expect([out.includes("prefix identifies a project key"), out.includes("END-OF-OUTPUT")]).toEqual([true, true]);
  });

  test("classifying an untyped envelope stays linear in its message size", () => {
    // Pattern redaction of the full message rescanned an unterminated line from every multipart
    // candidate, so a 176 KB message stalled the boundary for seconds.
    const startedAt = performance.now();
    const evidence = reduceBareUpstreamEvidence(undefined, { error: { code: "rate_limit_exceeded", message: "name=token ".repeat(16_000) } });
    expect(evidence?.verdict.terminalStatus).toBe(429);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    const jwtStartedAt = performance.now();
    const jwtEvidence = reduceBareUpstreamEvidence(undefined, { error: { code: "rate_limit_exceeded", message: "eyJabcdefgh-".repeat(32_000) } });
    expect(jwtEvidence?.verdict.terminalStatus).toBe(429);
    expect(performance.now() - jwtStartedAt).toBeLessThan(1_500);
  });

  test("checking an untyped envelope against the registry is one pass, not one per recorded value", () => {
    // The registry check ran one includes() per recorded value over the whole message, so a ~4 MB
    // message against tens of thousands of values took seconds.
    const registry = new OutboundCredentialRegistry({ maxEntries: 40_000, maxBytes: 4 << 20 });
    for (let i = 0; i < 20_000; i++) registry.remember({ [`x-meta-${i}`]: `value-${String(i).padStart(8, "0")}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const startedAt = performance.now();
      const evidence = reduceBareUpstreamEvidence(undefined, { error: { code: "mystery_code", message: "y".repeat(3_900_000) } });
      expect(evidence?.verdict.terminalStatus).toBe(502);
      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect([registry.matches("echo value-00012345 here"), registry.matches("value-0001234")]).toEqual([true, false]);
    } finally {
      restore();
    }
  });
});
