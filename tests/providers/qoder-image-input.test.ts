import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { buildQoderConversationInput as buildConversationInput } from "../../src/adapters/qoder/image-input";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
beforeEach(() => clearQoderBinaryCache());

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "qoder-pat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], ...overrides } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return { modelId: "Qwen3.8-Max", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, ...overrides } as OcxParsedRequest;
}

function fakeChild(frames: string[], options: { parked?: boolean; exitCode?: number; stderr?: string } = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  const stdout = new PassThrough();
  for (const frame of frames) stdout.write(enc.encode(frame));
  if (!options.parked) stdout.end();
  child.stdout = stdout;
  child.stderr = Readable.from(options.stderr ? [options.stderr] : []);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => {
      stdout.destroy();
      child.emit("close", 0);
    });
    return true;
  };
  if (!options.parked) {
    setTimeout(() => { child.exitCode = options.exitCode ?? 0; child.emit("close", child.exitCode); }, 2);
  }
  return child;
}

describe("Qoder image input", () => {
  const png = { type: "image" as const, imageUrl: `data:image/png;base64,${tinyPng}` };
  const user = (content: Extract<OcxMessage, { role: "user" }>["content"]): OcxMessage => ({ role: "user", content, timestamp: 0 });
  const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "response" }], timestamp: 1 };

  test.each([
    ["URL", "DeepSeek-Flash", [user([{ type: "image", imageUrl: "https://example.test/a.png" }])]],
    ["unsupported scheme", "DeepSeek-Flash", [user([{ type: "image", imageUrl: "ftp://example.test/a.png" }])]],
    ["other media type", "DeepSeek-Flash", [user([{ type: "image", imageUrl: "data:image/jpeg;base64,AA==" }])]],
    ["empty base64", "DeepSeek-Flash", [user([{ type: "image", imageUrl: "data:image/png;base64," }])]],
    ["multiple images", "DeepSeek-Flash", [user([png, png])]],
    ["unverified model", "Qwen3.8-Max", [user([png])]],
    ["history image replay", "DeepSeek-Flash", [user([png]), assistant, user("next")]],
    ["multi-turn image", "DeepSeek-Flash", [user("first"), assistant, user([png])]],
    ["tool-result image", "DeepSeek-Flash", [user("inspect"), assistant, { role: "toolResult", toolCallId: "call_1", content: [png], timestamp: 2 }]],
    ["developer image", "DeepSeek-Flash", [{ role: "developer", content: [png], timestamp: 0 }, user("inspect")]],
  ] as const)("CN refuses unverified %s before CLI discovery or spawn", async (_surface, modelId, messages) => {
    let discovered = 0;
    let spawned = 0;
    const events: AdapterEvent[] = [];
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.cn" }), {
      which: () => { discovered++; return "/bin/qoderclicn"; },
      spawn: () => { spawned++; return fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']); },
    });
    await adapter.runTurn!(parsed({ modelId, context: { messages: [...messages] } }),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", retryable: false });
    expect(events[0]).toMatchObject({ message: expect.stringContaining("qoderclicn 1.1.70") });
    expect(JSON.stringify(events)).not.toContain("example.test");
    expect(discovered).toBe(0);
    expect(spawned).toBe(0);
  });

  test.each(["DeepSeek-Flash", "Qwen3.8-Flash"])("CN forwards the verified single-PNG contract for %s", async modelId => {
    let stdin = "";
    const events: AdapterEvent[] = [];
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({ write(chunk, _encoding, callback) { stdin += chunk.toString(); callback(); } });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.cn" }), { which: () => "/bin/qoderclicn", spawn: () => child });
    await adapter.runTurn!(parsed({ modelId, context: { messages: [user([{ type: "text", text: "colour?" }, png])] } }),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(JSON.parse(stdin.trim()).message.content).toEqual([
      { type: "text", text: "colour?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("cancellation prevents a verified CN image from spawning", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.cn" }), {
      which: () => "/bin/qoderclicn", spawn: () => { spawned++; return fakeChild([]); },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed({ modelId: "DeepSeek-Flash", context: { messages: [user([png])] } }),
      { headers: new Headers(), abortSignal: AbortSignal.abort(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("aborted") });
  });

  test("forwards Qoder CN raw image input through the shared coding-agent projection", async () => {
    let spawned = 0;
    let stdin = "";
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.cn" }), {
      which: () => "/bin/qodercn",
      spawn: () => {
        spawned++;
        return child;
      },
    });
    const request = parsed({ modelId: "DeepSeek-Flash", context: { messages: [user([png])] } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(1);
    const wire = JSON.parse(stdin.trim());
    expect(wire.message.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: tinyPng },
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("shared projection carries multiple images and preserves history ordering", async () => {
    let spawned = 0;
    let stdin = "";
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.com" }), {
      which: () => "/bin/qoder",
      spawn: () => {
        spawned++;
        return child;
      },
    });
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,HIST==" }], timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "I see the first image." }], timestamp: 1 },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these two:" },
              { type: "image", imageUrl: "data:image/jpeg;base64,CURR1==" },
              { type: "image", imageUrl: "data:image/png;base64,CURR2==" },
            ],
            timestamp: 2,
          },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(1);
    const wire = JSON.parse(stdin.trim());
    const images = wire.message.content.filter((part: { type: string }) => part.type === "image");
    expect(images).toHaveLength(3);
    expect(wire.message.content[0].text).toContain("ASSISTANT:\nI see the first image.");
    expect(images[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "HIST==" } });
    expect(images[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "CURR1==" } });
    expect(images[2]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "CURR2==" } });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("shared projection carries toolResult images through shared projection", async () => {
    let spawned = 0;
    let stdin = "";
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.com" }), {
      which: () => "/bin/qoder",
      spawn: () => {
        spawned++;
        return child;
      },
    });
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "take screenshot", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }], timestamp: 1 },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [
              { type: "text", text: "captured screenshot:" },
              { type: "image", imageUrl: "data:image/png;base64,TOOL_IMG==" },
            ],
            timestamp: 2,
          },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(1);
    const wire = JSON.parse(stdin.trim());
    expect(wire.message.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "TOOL_IMG==" },
    });
    const textPart = wire.message.content.find((part: { type: string }) => part.type === "text");
    expect(textPart?.text).toContain("[image attached below]");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("omits unsupported image reference schemes cleanly without crashing", async () => {
    let spawned = 0;
    let stdin = "";
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.com" }), {
      which: () => "/bin/qoder",
      spawn: () => {
        spawned++;
        return child;
      },
    });
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "first turn", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "response" }], timestamp: 1 },
          {
            role: "user",
            content: [
              { type: "text", text: "inspect link" },
              { type: "image", imageUrl: "ftp://invalid-scheme.test/image.png" },
            ],
            timestamp: 2,
          },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(1);
    const wire = JSON.parse(stdin.trim());
    const images = wire.message.content.filter((part: { type: string }) => part.type === "image");
    expect(images).toHaveLength(0);
    const textPart = wire.message.content.find((part: { type: string }) => part.type === "text");
    expect(textPart?.text).toContain("[image omitted: unsupported reference]");
    expect(textPart?.text).toContain("ASSISTANT:\nresponse");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("marks unsupported image references in a single-turn user message", () => {
    const lines = buildConversationInput(parsed({
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "inspect link" },
            { type: "image", imageUrl: "ftp://invalid-scheme.test/image.png" },
          ],
          timestamp: 0,
        }],
      },
    }));

    expect(lines).toHaveLength(1);
    const frame = JSON.parse(lines[0]!);
    expect(frame.message.content).toContainEqual({ type: "text", text: "inspect link" });
    expect(frame.message.content).toContainEqual({ type: "text", text: "[image omitted: unsupported reference]" });
  });

  test("keeps a single-turn frame for an unsupported image-only message", () => {
    const lines = buildConversationInput(parsed({
      context: {
        messages: [{
          role: "user",
          content: [{ type: "image", imageUrl: "ftp://invalid-scheme.test/image.png" }],
          timestamp: 0,
        }],
      },
    }));

    expect(lines).toHaveLength(1);
    const frame = JSON.parse(lines[0]!);
    expect(frame.message.content).toContainEqual({ type: "text", text: "[image omitted: unsupported reference]" });
  });

  test("marks unsupported images in prior user and tool-result history as omitted", () => {
    const lines = buildConversationInput(parsed({
      context: {
        messages: [
          {
            role: "user",
            content: [{ type: "image", imageUrl: "ftp://invalid-scheme.test/user.png" }],
            timestamp: 0,
          },
          { role: "assistant", content: [{ type: "text", text: "I saw the image." }], timestamp: 1 },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "image", imageUrl: "ftp://invalid-scheme.test/tool.png" }],
            timestamp: 2,
          },
          { role: "user", content: "What was attached?", timestamp: 3 },
        ],
      },
    }));

    expect(lines).toHaveLength(1);
    const frame = JSON.parse(lines[0]!);
    const text = frame.message.content.find((part: { type: string }) => part.type === "text")?.text;
    expect(text).toContain("USER:\n[image omitted: unsupported reference]");
    expect(text).toContain("TOOL RESULT (call_id: call_1):\n[image omitted: unsupported reference]");
    expect(frame.message.content.filter((part: { type: string }) => part.type === "image")).toHaveLength(0);
  });

  test("leaves plain text-only requests completely unaffected", async () => {
    let spawned = 0;
    let stdin = "";
    const child = fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdin += chunk.toString();
        callback();
      },
    });
    const adapter = createQoderAdapter(provider({ baseUrl: "https://qoder.com" }), {
      which: () => "/bin/qoder",
      spawn: () => {
        spawned++;
        return child;
      },
    });
    const request = parsed({
      context: {
        messages: [{ role: "user", content: "Hello, plain text only", timestamp: 0 }],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(1);
    const wire = JSON.parse(stdin.trim());
    const images = wire.message.content.filter((part: { type: string }) => part.type === "image");
    expect(images).toHaveLength(0);
    const textPart = wire.message.content.find((part: { type: string }) => part.type === "text");
    expect(textPart?.text).toContain("Hello, plain text only");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

});
