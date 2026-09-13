import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZcodeAdapter } from "../../src/adapters/zcode/adapter";
import { loadZcodeSettings, readZcodeModels, type JsonObject, type ZcodeSettings } from "../../src/adapters/zcode/settings";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { catalogRowSupportsToolUse, modelCapabilityFields } from "../../src/server/models-capabilities";
import { deriveProviderPresets } from "../../src/providers/derive";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): ZcodeSettings {
  const home = mkdtempSync(join(tmpdir(), "ocx-zcode-test-")); roots.push(home);
  const dir = join(home, ".zcode", "cli"); mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "config.json");
  writeFileSync(settingsPath, JSON.stringify({ provider: {
    test: { name: "Test", kind: "anthropic", options: { baseURL: "https://example.invalid", apiKey: "never-log-this" },
      models: { model: { limit: { context: 1000 } } } },
    opencodex: { models: { recursive: {} } },
    alias: { options: { baseURL: "https://127.0.0.1/v1" }, models: { recursive: {} } },
    disabled: { enabled: false, models: { hidden: {} } },
  } }));
  return { command: ["/isolated-launcher"], home, workspace: "/workspace", settingsPath, scope: home };
}
class FakeClient {
  onEvent: (event: JsonObject) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  calls: Array<{ method: string; params: JsonObject }> = [];
  closed = false;
  constructor(private outcome: "ok" | "failed" | "hang" | "session-noise" = "ok") {}
  async request(method: string, params: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "session/create") return { session: { sessionId: "sess_test-1" } };
    if (method === "session/send") {
      if (this.outcome === "session-noise") {
        queueMicrotask(() => {
          this.onEvent({ method: "session/event", params: { type: "turn.completed", payload: { response: "wrong session" } } });
          this.onEvent({ method: "session/event", params: { sessionId: "sess_other", type: "turn.completed", payload: { response: "wrong session" } } });
        });
        setTimeout(() => {
          this.event("model.streaming", { kind: "text_delta", delta: "Hello" });
          this.event("turn.completed", { response: "Hello" });
        }, 5);
        return {};
      }
      queueMicrotask(() => {
        if (this.outcome === "hang") return;
        this.event("model.streaming", { kind: "reasoning_delta", delta: "Thinking" });
        this.event("tool.updated", { kind: "started", toolCallId: "tool-1" });
        this.event("tool.updated", { kind: "result", toolCallId: "tool-1" });
        if (this.outcome === "failed") return this.event("turn.failed", { error: { message: "secret" } });
        this.event("model.streaming", { kind: "text_delta", delta: "Hello" });
        this.event("turn.completed", { response: "Hello" });
      });
    }
    return {};
  }
  event(type: string, payload: JsonObject) {
    this.onEvent({ method: "session/event", params: { sessionId: "sess_test-1", type, payload } });
  }
  async close() { this.closed = true; }
}
const provider: OcxProviderConfig = { adapter: "zcode", baseUrl: "https://zcode.z.ai", authMode: "local" };
const request = (): OcxParsedRequest => ({ modelId: "test/model", stream: true, options: {},
  context: { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] } });
async function run(settings: ZcodeSettings, client: FakeClient, parsed = request(), signal?: AbortSignal) {
  const events: AdapterEvent[] = [];
  const adapter = createZcodeAdapter(provider, { settings: () => settings, client: () => client, timeoutMs: 40 });
  await adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: signal,
    translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
  return events;
}

describe("ZCode local agent", () => {
  test("managed requests select a public model without carrying Desktop secrets", async () => {
    const settings = { ...fixture(), desktopModels: [{ id: "test/model", providerId: "test", modelId: "model", label: "Model" }] };
    const client = new FakeClient();
    expect((await run(settings, client)).at(-1)?.type).toBe("done");
    for (const call of client.calls.filter(c => ["session/create", "session/send"].includes(c.method))) {
      expect(call.params._zcodeModel).toEqual({ providerId: "test", modelId: "model" });
      expect(call.params.runtimeModel).toBeUndefined();
      const serialized = JSON.stringify(call.params);
      expect(serialized).not.toContain("never-log-this");
      expect(serialized).not.toContain("apiKey");
    }
  });
  test("maps Codex effort labels to the official GLM-5.3 thought levels", async () => {
    const settings = { ...fixture(), desktopModels: [{
      id: "builtin:zai-coding-plan/GLM-5.3", providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3", label: "GLM-5.3",
    }] };
    for (const [requested, expected] of [["low", "low"], ["medium", "high"], ["high", "high"],
      ["xhigh", "max"], ["max", "max"], ["ultra", "max"]] as const) {
      const client = new FakeClient();
      const parsed = request(); parsed.modelId = settings.desktopModels[0]!.id; parsed.options.reasoning = requested;
      expect((await run(settings, client, parsed)).at(-1)?.type).toBe("done");
      expect(client.calls.find(call => call.method === "session/create")?.params.thoughtLevel).toBe(expected);
      expect(client.calls.find(call => call.method === "session/send")?.params.thoughtLevel).toBeUndefined();
    }
  });
  test("a revoked or changed managed connection cannot start a queued child", async () => {
    const settings = { ...fixture(), desktopModels: [{ id: "test/model", providerId: "test", modelId: "model", label: "Model" }] };
    let reads = 0; let children = 0;
    const adapter = createZcodeAdapter(provider, { settings: () => ({ ...settings, scope: ++reads === 1 ? "before" : "after" }), client: () => { children++; return new FakeClient(); } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));
    expect(children).toBe(0);
    expect(events.at(-1)?.type).toBe("error");
  });
  test("has no direct HTTP inference path or client-tool capability", () => {
    const adapter = createZcodeAdapter(provider);
    expect(adapter.fetchResponse).toBeUndefined();
    expect(adapter.replaySafe).toBe(false);
    expect(adapter.allowExternalSidecars).toBe(false);
    expect(adapter.allowVisionSidecar).toBe(true);
    expect(() => adapter.buildRequest(request(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }))
      .toThrow("not HTTP");
    expect(modelCapabilityFields({ supportsToolUse: false }).capabilities.supports_tool_use).toBe(false);
    const comboSupportsTools = catalogRowSupportsToolUse(undefined, { targets: [{ provider: "zcode", model: "model" }] }, { zcode: provider });
    expect(comboSupportsTools).toBe(false);
    expect(modelCapabilityFields({ supportsToolUse: comboSupportsTools }).capabilities.supports_tool_use).toBe(false);
    expect(catalogRowSupportsToolUse(undefined, { targets: [{ provider: "other", model: "model" }] }, {
      other: { adapter: "openai-chat", baseUrl: "https://example.invalid" },
    })).toBe(true);
    expect(deriveProviderPresets().find(p => p.id === "zcode")).toMatchObject({ auth: "local", adapter: "zcode" });
  });
  test("requires explicit operator opt-in and an argv launcher, never a shell string", () => {
    expect(() => loadZcodeSettings({})).toThrow("disabled");
    expect(() => loadZcodeSettings({ OCX_ZCODE_NATIVE_TOOLS: "1", OCX_ZCODE_COMMAND: "echo unsafe" })).toThrow("JSON argv");
  });
  test("advanced settings allow an isolated home when the proxy HOME is absent", () => {
    const settings = fixture();
    const env = { OCX_ZCODE_NATIVE_TOOLS: "1", OCX_ZCODE_COMMAND: JSON.stringify(["/isolated-launcher"]),
      OCX_ZCODE_HOME: settings.home, OCX_ZCODE_WORKSPACE: settings.workspace };
    expect(loadZcodeSettings(env)).toMatchObject({ home: settings.home, workspace: settings.workspace });
    expect(() => loadZcodeSettings({ ...env, HOME: settings.home })).toThrow("separate home");
  });
  test("catalog excludes disabled/recursive entries and preserves canonical model identity", () => {
    const models = readZcodeModels(fixture());
    expect(models.map(m => m.id)).toEqual(["test/model"]);
    expect(models[0]?.contextWindow).toBe(1000);
  });
  test("settings parse errors and escaping symlinks disclose no file content", () => {
    const settings = fixture();
    writeFileSync(settings.settingsPath, "{secret-value");
    expect(() => readZcodeModels(settings)).toThrow("unavailable, invalid");
    if (process.platform !== "win32") {
      const outside = fixture(); unlinkSync(settings.settingsPath); symlinkSync(outside.settingsPath, settings.settingsPath);
      expect(() => readZcodeModels(settings)).toThrow("unavailable, invalid");
    }
  });
  test("native execution streams progress without asking the client to execute tools", async () => {
    const settings = fixture(); const client = new FakeClient();
    const events = await run(settings, client);
    expect(events.some(e => e.type.startsWith("tool_call"))).toBe(false);
    expect(events.filter(e => e.type === "text_delta" && e.text === "Hello")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(events)).not.toContain("never-log-this");
    expect(client.closed).toBe(true);
    expect(client.calls.map(c => c.method)).toEqual(["session/create", "session/subscribe", "session/send", "session/stop"]);
  });
  test("ignores terminal events without the active session identity", async () => {
    const events = await run(fixture(), new FakeClient("session-noise"));
    expect(events.filter(e => e.type === "text_delta" && e.text === "wrong session")).toHaveLength(0);
    expect(events.filter(e => e.type === "text_delta" && e.text === "Hello")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
  test("continuation resumes only owner-fenced state and sends the current delta", async () => {
    const settings = fixture();
    const first = await run(settings, new FakeClient());
    const done = first.find(e => e.type === "done");
    const next = request(); next._providerContinuation = done?.providerState;
    next.context.messages.push({ role: "user", content: "Follow up", timestamp: 1 });
    const client = new FakeClient(); await run(settings, client, next);
    expect(client.calls[0]?.method).toBe("session/resume");
    const sent = String(client.calls.find(c => c.method === "session/send")?.params.content);
    expect(sent).toContain("Follow up"); expect(sent).not.toContain("Say hello");
    const other = new FakeClient(); await run(fixture(), other, next);
    expect(other.calls[0]?.method).toBe("session/create");
  });
  test("a fresh ZCode session safely projects replayed reasoning and tool history", async () => {
    const parsed = request();
    parsed.context.messages = [
      { role: "user", content: "Inspect the repository", timestamp: 0 },
      { role: "assistant", timestamp: 1, content: [
        { type: "thinking", thinking: "private reasoning must not cross providers" },
        { type: "toolCall", id: "call_old", name: "exec_command", arguments: { command: "pwd" } },
      ] },
      { role: "toolResult", toolCallId: "call_old", toolName: "exec_command",
        content: "/workspace", isError: false, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "The repository is available." }], timestamp: 3 },
      { role: "user", content: "Continue with the fix", timestamp: 4 },
    ];
    const client = new FakeClient();
    expect((await run(fixture(), client, parsed)).at(-1)?.type).toBe("done");
    const sent = String(client.calls.find(call => call.method === "session/send")?.params.content);
    expect(sent).toContain("[historical tool call: exec_command]");
    expect(sent).toContain("tool exec_command result: /workspace");
    expect(sent).toContain("assistant: The repository is available.");
    expect(sent).toContain("user: Continue with the fix");
    expect(sent).not.toContain("private reasoning");
    expect(sent).not.toContain('"command":"pwd"');
  });
  test("post-send failures are non-retryable incomplete, not failover candidates", async () => {
    const client = new FakeClient("failed"); const events = await run(fixture(), client);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "zcode_agent_interrupted", retryable: false });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(client.calls.filter(c => c.method === "session/send")).toHaveLength(1);
  });
  test("timeout closes the owned app-server and does not resend", async () => {
    const client = new FakeClient("hang"); const events = await run(fixture(), client);
    expect(events.at(-1)?.type).toBe("incomplete"); expect(client.closed).toBe(true);
    expect(client.calls.filter(c => c.method === "session/send")).toHaveLength(1);
  });
  test("a running cancellation closes only its child and never resends", async () => {
    const controller = new AbortController(); const client = new FakeClient("hang");
    const pending = run(fixture(), client, request(), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
    expect((await pending).at(-1)).toMatchObject({ type: "incomplete", retryable: false });
    expect(client.closed).toBe(true);
    expect(client.calls.filter(c => c.method === "session/send")).toHaveLength(1);
  });
  test("profile turns serialize and cancelled waiters never start a child", async () => {
    const settings = fixture(); const first = new FakeClient("hang"); const second = new FakeClient();
    const pending = run(settings, first);
    await new Promise(resolve => setTimeout(resolve, 5));
    const controller = new AbortController(); const waiting = run(settings, second, request(), controller.signal);
    controller.abort();
    expect((await waiting).at(-1)?.type).toBe("error");
    expect(second.calls).toHaveLength(0);
    await pending;
    expect((await run(settings, new FakeClient())).at(-1)?.type).toBe("done");
  });
  test("pre-aborted requests never spawn or send", async () => {
    const client = new FakeClient(); const events = await run(fixture(), client, request(), AbortSignal.abort());
    expect(events.at(-1)?.type).toBe("error"); expect(client.calls).toHaveLength(0);
  });
  test("rejects residual media that escaped text-only normalization", async () => {
    const parsed = request(); parsed.context.messages = [{ role: "user", timestamp: 0,
      content: [{ type: "image", imageUrl: "https://example.invalid/image.png" }] }];
    const client = new FakeClient();
    expect((await run(fixture(), client, parsed)).at(-1)).toMatchObject({
      type: "error", message: "ZCode image input was not converted to text before native dispatch.",
    });
    expect(client.calls).toHaveLength(0);
  });
});
