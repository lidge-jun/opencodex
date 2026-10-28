import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { frame, chat, fixture } from "../helpers/provider-completion-fixture";
import { runProviderCompletionTest, COMPLETION_TEST_PROMPT, COMPLETION_TEST_MAX_BYTES } from "../../src/server/management/provider-completion-test";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import * as keyResolver from "../../src/providers/api-key-resolve";
import type { OcxProviderConfig } from "../../src/types";
import { translatorLiveBudgetCountForTests } from "../../src/lib/translator-budget";

afterEach(() => setProviderKeychainEntryFactoryForTests(null));

describe("completion test applicability and input", () => {
  const invalid = [null, [], false, {}, { model: "test-model" }, { model: "test-model", confirm: false },
    { model: "test-model", confirm: true, prompt: "hello" }, { model: 1, confirm: true },
    ...["", " ", "x".repeat(257), "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "\ntest-model"].map(model => ({ model, confirm: true }))];
  for (const [index, body] of invalid.entries()) test(`invalid body ${index}: 400 and no send`, async () => {
    const f = fixture();
    expect((await f.route(body)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  test("unknown provider: 404 and no send", async () => {
    const f = fixture();
    expect(await f.route(undefined, "absent")).toEqual({ status: 404, body: { error: "unknown provider" } });
    expect(f.calls).toHaveLength(0);
  });
  test("oversized request body: shared management limit answers 413 and no send", async () => {
    const f = fixture();
    const response = await f.route({ model: "test-model", confirm: true, pad: "x".repeat(4 * 1024 * 1024 + 16) });
    expect(response.status).toBe(413);
    expect(f.calls).toHaveLength(0);
  });
  for (const [overrides, reason] of [
    [{ disabled: true, authMode: "oauth" }, "disabled"], [{ authMode: "forward" }, "forward_auth"],
    [{ authMode: "oauth" }, "oauth_auth"], [{ adapter: "anthropic" }, "unsupported_adapter"], [{ adapter: "google" }, "unsupported_adapter"],
  ] as const) test(`${reason} runs before resolving any stored key`, async () => {
    let reads = 0;
    setProviderKeychainEntryFactoryForTests(() => { reads++; throw new Error("must not read"); });
    const spy = spyOn(keyResolver, "resolveProviderApiKey");
    try {
      const f = fixture({ ...overrides, apiKey: "keychain:fixture" });
      expect(await f.run()).toMatchObject({ applicable: false, reason });
      expect(reads).toBe(0);
      expect(spy.mock.calls.every(([reference]) => reference === undefined)).toBe(true);
      expect(f.calls).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  for (const [overrides, detail] of [
    [{ tlsProfile: "chrome" }, "tls_profile"], [{ upstreamHttpVersion: "http1.1" }, "upstream_http_version"],
    [{ requestPacing: { enabled: true } }, "request_pacing"], [{ proxy: false }, "custom_executor_egress"],
  ] as const) test(`unsupported ${detail} has no send`, async () => {
    const f = fixture(overrides as Partial<OcxProviderConfig>);
    expect(await f.run()).toEqual({ applicable: false, reason: "unsupported_transport", detail });
    expect(f.calls).toHaveLength(0);
  });
  for (const [name, reason] of [["openai", "forward_auth"], ["github-copilot", "oauth_auth"]] as const) test(`registry auth gate ${name} needs no credential lookup`, async () => {
    let reads = 0;
    setProviderKeychainEntryFactoryForTests(() => { reads++; throw new Error("must not read"); });
    const f = fixture({ authMode: "local", apiKey: "keychain:fixture" });
    f.config.providers[name] = f.row;
    expect(await runProviderCompletionTest({ config: f.config, name, model: "test-model" })).toEqual({ applicable: false, reason });
    expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
  });
  test("prototype-shaped unknown provider is still 404", async () => {
    const f = fixture();
    expect((await f.route(undefined, "__proto__")).status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });
  test("destination refused before key lookup", async () => {
    let reads = 0;
    setProviderKeychainEntryFactoryForTests(() => { reads++; throw new Error("must not read"); });
    const f = fixture({ baseUrl: "https://127.0.0.1/v1", apiKey: "keychain:fixture" });
    expect(await f.run()).toMatchObject({ error: { code: "destination_refused" } });
    expect(f.calls).toHaveLength(0);
    expect(reads).toBe(0);
  });
  test("missing key refuses without a send", async () => {
    const f = fixture({ apiKey: undefined });
    expect(await f.run()).toMatchObject({ error: { code: "credential_missing" } });
    expect(f.calls).toHaveLength(0);
  });
  test("invalid per-model adapter is ignored by the shared resolver", async () => {
    const f = fixture({ modelAdapters: { "test-model": "anthropic" as any } });
    expect(await f.run()).toMatchObject({ ok: true, wire: "openai-chat" });
    expect(f.calls).toHaveLength(1);
  });
  test("alias to a hard-pinned unsupported wire is rejected before credentials", async () => {
    let reads = 0;
    setProviderKeychainEntryFactoryForTests(() => { reads++; throw new Error("must not read"); });
    const f = fixture({ apiKey: "keychain:fixture", modelAliases: { "minimax-m2.7": "friendly" } });
    f.config.providers["opencode-go"] = f.row;
    expect(await runProviderCompletionTest({ config: f.config, name: "opencode-go", model: "friendly" }))
      .toEqual({ applicable: false, reason: "unsupported_adapter", adapter: "anthropic" });
    expect(reads).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});

describe("bounded wire and model observations", () => {
  test("chat uses exact prompt/body, adapter path, static row, cap, and headers", async () => {
    const f = fixture({ chatCompletionsPath: "/custom/chat", headers: { "X-Provider": "fixture" } });
    const result = await f.run();
    expect(result).toMatchObject({ applicable: true, ok: true, requestedModel: "test-model", wireModel: "test-model", wire: "openai-chat",
      upstreamModel: "test-model", modelComparison: "match", identityVerified: false, outputTokenCap: 32, termination: "completed", error: null });
    if (!result.applicable) throw new Error("applicable");
    expect(result.ttftMs).not.toBeNull();
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(result.ttftMs!);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://provider.example/v1/custom/chat");
    const init = f.calls[0]!.init!;
    expect(JSON.parse(String(init.body))).toEqual({ model: "test-model", messages: [{ role: "user", content: COMPLETION_TEST_PROMPT }], stream: true, max_tokens: 32 });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer opaque-fixture-key");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
    expect(init.redirect).toBe("manual");
    expect(init.signal!.aborted).toBe(true);
  });
  for (const terminal of ["response.completed", "response.incomplete"]) test(`responses override: ${terminal}`, async () => {
    const payload = frame({ type: "response.created", response: { model: "test-model" } })
      + frame({ type: "response.output_text.delta", delta: "OK" }) + frame({ type: terminal, response: { model: "test-model" } });
    const f = fixture({ modelAdapters: { "test-model": "openai-responses" }, responsesPath: "/custom/responses" }, () => new Response(payload));
    expect(await f.run()).toMatchObject({ ok: true, wire: "openai-responses", modelComparison: "match", termination: "completed" });
    expect(f.calls[0]!.url).toBe("https://provider.example/v1/custom/responses");
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({ model: "test-model", input: COMPLETION_TEST_PROMPT, stream: true, max_output_tokens: 32, store: false });
  });
  test("arbitrary SSE byte splits including CRLF and UTF-8", async () => {
    const bytes = new TextEncoder().encode(chat("test-model", "응답").replaceAll("\n", "\r\n"));
    let position = 0;
    const f = fixture({}, () => new Response(new ReadableStream({ pull(c) {
      if (position === bytes.length) c.close(); else c.enqueue(bytes.slice(position, ++position));
    } })));
    expect(await f.run()).toMatchObject({ ok: true, modelComparison: "match" });
  });
  test("role/reasoning-only events do not start TTFT", async () => {
    let clock = 0;
    const frames = [frame({ choices: [{ delta: { role: "assistant", reasoning_content: "private" } }] }), chat()];
    const f = fixture({}, () => new Response(new ReadableStream({ pull(c) {
      clock += 50;
      const next = frames.shift(); if (next) c.enqueue(new TextEncoder().encode(next)); else c.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    expect(await f.run("test-model", { now: () => clock })).toMatchObject({ ok: true, ttftMs: 100, totalLatencyMs: 100 });
  });
  test("fractional clock readings are reported as whole milliseconds", async () => {
    const readings = [10.25, 138.9, 375.61];
    let last = readings[0]!;
    const f = fixture();
    const result = await f.run("test-model", { now: () => (last = readings.shift() ?? last) });
    expect(result).toMatchObject({ ok: true });
    const { ttftMs, totalLatencyMs } = result as { ttftMs: number; totalLatencyMs: number };
    expect(Number.isInteger(ttftMs)).toBe(true);
    expect(Number.isInteger(totalLatencyMs)).toBe(true);
    expect(totalLatencyMs).toBeGreaterThanOrEqual(ttftMs);
  });
  for (const [upstream, expected] of [["other", "mismatch"], ["test-model", "match"], ["", "mismatch"]]) test(`raw upstream comparison ${expected}`, async () => {
    const f = fixture({}, () => new Response(chat(upstream)));
    expect(await f.run()).toMatchObject({ upstreamModel: upstream, modelComparison: expected });
  });
  test("alias and bracket suffix reuse existing model authorities", async () => {
    const f = fixture({ modelAliases: { "native[1m]": "friendly" }, modelSuffixBracketStrip: true }, () => new Response(chat("native")));
    expect(await f.run("friendly")).toMatchObject({ wireModel: "native", requestedModel: "friendly", modelComparison: "match" });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).model).toBe("native");
  });
  for (const adapter of ["openai-chat", "anthropic"] as const) test(`alias resolves native Responses override before ${adapter} applicability`, async () => {
    const payload = frame({ type: "response.created", response: { model: "native" } })
      + frame({ type: "response.output_text.delta", delta: "OK" })
      + frame({ type: "response.completed", response: { model: "native" } });
    const f = fixture({ adapter, modelAliases: { native: "friendly" }, modelAdapters: { native: "openai-responses" } }, () => new Response(payload));
    expect(await f.run("friendly")).toMatchObject({ ok: true, wire: "openai-responses", wireModel: "native", modelComparison: "match" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://provider.example/v1/responses");
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({ model: "native", input: COMPLETION_TEST_PROMPT, stream: true, max_output_tokens: 32, store: false });
  });
  test("native wire override precedes bracket suffix stripping", async () => {
    const f = fixture({ adapter: "openai-responses", modelAliases: { "native[1m]": "friendly" },
      modelAdapters: { "native[1m]": "openai-chat" }, modelSuffixBracketStrip: true }, () => new Response(chat("native")));
    expect(await f.run("friendly")).toMatchObject({ ok: true, wire: "openai-chat", wireModel: "native" });
    expect(f.calls[0]!.url).toBe("https://provider.example/v1/chat/completions");
  });
  test("missing metadata is unknown", async () => {
    const f = fixture({}, () => new Response(frame({ choices: [{ delta: { content: "OK" } }] }) + frame("[DONE]")));
    expect(await f.run()).toMatchObject({ ok: true, upstreamModel: null, modelComparison: "unknown", comparisonNote: "missing_metadata" });
  });
  test("conflicting metadata is unknown and cannot assert identity", async () => {
    const f = fixture({}, () => new Response(frame({ model: "a", choices: [] }) + chat("b")));
    expect(await f.run()).toMatchObject({ ok: true, upstreamModel: null, modelComparison: "unknown", comparisonNote: "conflicting_metadata", identityVerified: false });
  });
  for (const model of ["opaque-fixture-key", "x".repeat(250) + "opaque-fixture-key", "x\u0000opaque-fixture-key\u0000"]) test(`secret masked before cleanup/truncation ${model.length}`, async () => {
    const f = fixture({}, () => new Response(chat(model)));
    const result = await f.run();
    expect(result).toMatchObject({ upstreamModel: "[redacted]", modelComparison: "mismatch" });
    expect(JSON.stringify(result)).not.toContain("opaque-fixture-key");
  });
  test("raw comparison precedes header secret masking", async () => {
    const f = fixture({ headers: { "X-Private": "test-model" } });
    expect(await f.run()).toMatchObject({ upstreamModel: "[redacted]", modelComparison: "match" });
  });
  test("a control-containing configured secret masks the whole raw model", async () => {
    const f = fixture({ apiKey: "opaque\tkey" }, () => new Response(chat("raw opaque\tkey response")));
    expect(await f.run()).toMatchObject({ upstreamModel: "[redacted]" });
  });
  test("model secret masking retains the authority captured before the send", async () => {
    const f = fixture({ headers: { "X-Private": "opaque-original-header" } }, () => {
      f.row.headers!["X-Private"] = "new-value";
      return new Response(chat("opaque-original-header"));
    });
    expect(await f.run()).toMatchObject({ upstreamModel: "[redacted]", modelComparison: "mismatch" });
  });
  test("untrusted metadata is cleaned and bounded", async () => {
    const f = fixture({}, () => new Response(chat("\u0000" + "m".repeat(300) + "\u007f")));
    expect(await f.run()).toMatchObject({ upstreamModel: "m".repeat(256), modelComparison: "mismatch" });
  });
});

describe("failure classification and cleanup", () => {
  for (const outcome of ["success", "http_status", "stream_error", "too_large", "timeout", "aborted"] as const) test(`${outcome} releases its translator budget`, async () => {
    const before = translatorLiveBudgetCountForTests();
    const controller = new AbortController();
    const f = fixture({}, () => {
      if (outcome === "success") return new Response(chat());
      if (outcome === "http_status") return new Response(null, { status: 500 });
      return new Response(new ReadableStream({ start(c) {
        if (outcome === "stream_error") c.enqueue(new TextEncoder().encode(frame({ error: {} })));
        if (outcome === "too_large") c.enqueue(new Uint8Array(COMPLETION_TEST_MAX_BYTES + 1));
        if (outcome === "aborted") setTimeout(() => controller.abort(), 10);
      } }));
    });
    const result = await f.run("test-model", { timeoutMs: 100 }, controller.signal);
    expect(result).toMatchObject(outcome === "success" ? { ok: true } : { error: { code: outcome } });
    expect(translatorLiveBudgetCountForTests()).toBe(before);
  });
  for (const status of [401, 500, 302]) test(`HTTP ${status} never reads a secret body or follows Location`, async () => {
    let cancelled = false;
    const f = fixture({}, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("opaque-fixture-key")); }, cancel() { cancelled = true; } }),
      { status, headers: { location: "https://other.example/secret" } }));
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, termination: "failed", error: { code: status === 302 ? "redirect" : "http_status", ...(status === 302 ? {} : { status }) } });
    expect(JSON.stringify(result)).not.toContain("opaque-fixture-key");
    expect(JSON.stringify(result)).not.toContain("other.example");
    expect(f.calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });
  test("network throw has fixed safe error", async () => {
    const f = fixture({}, () => { throw new Error("opaque-fixture-key https://secret.example"); });
    expect(await f.run()).toMatchObject({ error: { code: "network", message: "Upstream network request failed." } });
    expect(f.calls).toHaveLength(1);
  });
  for (const [wire, payload, code] of [
    ["openai-chat", frame({ error: { message: "opaque-fixture-key" } }), "stream_error"],
    ["openai-responses", frame({ type: "response.failed", response: { error: "opaque-fixture-key" } }), "stream_error"],
    ["openai-chat", frame({ message: "opaque-fixture-key" }, "error"), "stream_error"],
    ["openai-chat", frame({ choices: [{ delta: { content: "OK" } }] }), "premature_eof"],
    ["openai-responses", frame({ type: "response.output_text.delta", delta: "OK" }), "premature_eof"],
    ["openai-chat", frame("[DONE]"), "no_content"],
    ["openai-responses", frame({ type: "response.completed" }), "no_content"],
  ] as const) test(`${wire} ${code} ${payload.length}`, async () => {
    let cancelled = false;
    const f = fixture({ adapter: wire }, () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(payload));
      if (code === "premature_eof") c.close();
    }, cancel() { cancelled = true; } })));
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain("opaque-fixture-key");
    expect(f.calls[0]!.init!.signal!.aborted).toBe(true);
    if (code !== "premature_eof") expect(cancelled).toBe(true);
  });
  test("finish_reason and EOF are sufficient for chat", async () => {
    const f = fixture({}, () => new Response(frame({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })));
    expect(await f.run()).toMatchObject({ ok: true });
  });
  test("counts incomplete frames toward the 64 KiB limit and cancels", async () => {
    let cancelled = false;
    const f = fixture({}, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: " + "x".repeat(COMPLETION_TEST_MAX_BYTES))); }, cancel() { cancelled = true; } })));
    expect(await f.run()).toMatchObject({ termination: "too_large", error: { code: "too_large" } });
    expect(cancelled).toBe(true);
  });
  test("deadline cancels a stalled stream even when executor ignores abort", async () => {
    let cancelled = false;
    const f = fixture({}, () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    expect(await f.run("test-model", { timeoutMs: 20 })).toMatchObject({ termination: "timeout", error: { code: "timeout" } });
    expect(cancelled).toBe(true);
  });
  test("request abort cancels upstream reader", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const f = fixture({}, () => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 10); }, cancel() { cancelled = true; } })));
    expect(await f.run("test-model", {}, controller.signal)).toMatchObject({ termination: "aborted", error: { code: "aborted" } });
    expect(cancelled).toBe(true);
  });
  test("terminal cleanup cannot hang on an executor whose cancel never settles", async () => {
    let cancelled = false;
    const f = fixture({}, () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(chat())); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    })));
    expect(await f.run("test-model", { timeoutMs: 30 })).toMatchObject({ ok: true });
    expect(cancelled).toBe(true);
  });
  test("deadline cancels a late response from an executor ignoring abort", async () => {
    let respond!: (response: Response) => void;
    let observedCancellation!: () => void;
    const cancellation = new Promise<void>(resolve => { observedCancellation = resolve; });
    let cancelled = false;
    const pending = new Promise<Response>(resolve => { respond = resolve; });
    const f = fixture({}, () => pending);
    expect(await f.run("test-model", { timeoutMs: 10 })).toMatchObject({ error: { code: "timeout" } });
    respond(new Response(new ReadableStream({ cancel() { cancelled = true; observedCancellation(); } })));
    await cancellation;
    expect(cancelled).toBe(true);
  });
  test("already aborted request sends nothing", async () => {
    const f = fixture();
    expect(await f.run("test-model", {}, AbortSignal.abort())).toMatchObject({ error: { code: "aborted" } });
    expect(f.calls).toHaveLength(0);
  });
});
