import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  bindUpstreamHistorySlimConfig,
  currentUpstreamHistorySlim,
  slimCodexHistoryJson,
  slimOutboundCodexHistory,
} from "../../src/server/responses/history-slim";

const CODEX = "https://chatgpt.com/backend-api/codex/responses";
const COMPACT = "https://chatgpt.com/backend-api/codex/responses/compact";

function image(bytes: number): Record<string, unknown> {
  return { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(bytes)}` };
}

function user(text: string, extra: unknown[] = []): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }, ...extra] };
}

describe("slimCodexHistoryJson", () => {
  test("keeps the current turn and stubs older inline images", () => {
    const kept = image(5_000);
    const body = JSON.stringify({
      input: [
        user("look", [image(8_000)]),
        {
          type: "custom_tool_call_output",
          call_id: "call_old",
          output: [image(6_000), { type: "input_text", text: "seen" }],
        },
        user("again", [kept]),
        {
          type: "custom_tool_call_output",
          call_id: "call_new",
          output: [image(7_000)],
        },
      ],
    });
    const next = slimCodexHistoryJson(body);
    expect(next).toBeString();
    const parsed = JSON.parse(next!) as { input: Array<Record<string, unknown>> };
    expect(JSON.stringify(parsed.input[0])).not.toContain("data:image");
    expect(JSON.stringify(parsed.input[0])).toContain("original remains in the local session");
    const oldOutput = parsed.input[1]!;
    expect(oldOutput.call_id).toBe("call_old");
    expect(JSON.stringify(oldOutput.output)).not.toContain("data:image");
    expect(JSON.stringify(oldOutput.output)).toContain("seen");
    expect(JSON.stringify(parsed.input[2])).toContain("data:image");
    expect(parsed.input[3]!.call_id).toBe("call_new");
    expect(JSON.stringify(parsed.input[3])).toContain("data:image");
    expect(slimCodexHistoryJson(next!)).toBeNull();
  });

  test("a single user message is sent unchanged, including its image", () => {
    const body = JSON.stringify({ input: [user("only", [image(8_000)])] });
    expect(slimCodexHistoryJson(body)).toBeNull();
  });

  test("leaves file ids and remote urls in place, including long signed urls", () => {
    const signedUrl = `https://example.test/a.png?signature=${"a".repeat(8_000)}`;
    const body = JSON.stringify({
      input: [
        user("earlier"),
        {
          type: "function_call_output",
          call_id: "call_file",
          output: [
            { type: "input_image", file_id: "file_123" },
            { type: "input_image", image_url: "https://example.test/a.png" },
            { type: "input_image", image_url: signedUrl },
            { type: "input_image", image_url: { url: signedUrl } },
          ],
        },
        user("now"),
      ],
    });
    expect(slimCodexHistoryJson(body)).toBeNull();
  });

  test("trims an older tool output above 32 KiB and keeps its call id", () => {
    const body = JSON.stringify({
      input: [
        user("run"),
        {
          type: "function_call_output",
          call_id: "call_fat",
          output: "中".repeat(20_000),
        },
        user("next"),
      ],
    });
    const next = slimCodexHistoryJson(body)!;
    const parsed = JSON.parse(next) as { input: Array<Record<string, unknown>> };
    expect(parsed.input[1]!.call_id).toBe("call_fat");
    const output = parsed.input[1]!.output as string;
    expect(output).toContain("tool output shortened");
    expect(output).toContain("full output remains in the local session");
    expect(Buffer.byteLength(output)).toBeLessThan(32 * 1024);
    expect(slimCodexHistoryJson(next)).toBeNull();
  });

  test("does not trim a large tool output from the current turn", () => {
    const fat = "x".repeat(40_000);
    const body = JSON.stringify({
      input: [
        user("run"),
        { type: "function_call_output", call_id: "call_now", output: fat },
      ],
    });
    expect(slimCodexHistoryJson(body)).toBeNull();
  });

  test("a 20 MiB prefix of screenshots falls under 1 MiB", () => {
    const shots = Array.from({ length: 29 }, (_, index) => ({
      type: "custom_tool_call_output",
      call_id: `call_${index}`,
      output: [image(700_000)],
    }));
    const body = JSON.stringify({
      input: [user("watch"), ...shots, user("continue")],
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(20_000_000);
    const next = slimCodexHistoryJson(body)!;
    expect(Buffer.byteLength(next)).toBeLessThan(1024 * 1024);
    const parsed = JSON.parse(next) as { input: Array<Record<string, unknown>> };
    expect(parsed.input[1]!.call_id).toBe("call_0");
    expect(JSON.stringify(parsed.input.slice(0, -1))).not.toContain("data:image");
    expect(slimCodexHistoryJson(next)).toBeNull();
  });
});

describe("slimOutboundCodexHistory", () => {
  test("budgets a fragmented older tool output against the whole item", () => {
    // Eight 20 KiB parts: no single field crosses 32 KiB, but the item is ~160 KiB.
    const parts = Array.from({ length: 8 }, (_, index) => ({ type: "input_text", text: String(index).padEnd(20 * 1024, "x") }));
    const body = JSON.stringify({
      input: [user("run"), { type: "custom_tool_call_output", call_id: "call_parts", output: parts }, user("next")],
    });
    const next = slimCodexHistoryJson(body)!;
    expect(next).not.toBeNull();
    const item = (JSON.parse(next) as { input: Array<Record<string, unknown>> }).input[1]!;
    expect(item.call_id).toBe("call_parts");
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(32 * 1024);
    const texts = (item.output as Array<{ text: string }>).map(part => part.text);
    expect(texts).toHaveLength(8);
    expect(texts.every(text => text.includes("tool output shortened"))).toBe(true);
    expect(slimCodexHistoryJson(next)).toBeNull();
  });

  test("shortens every part of an output too fragmented to reach the limit, beyond 64 parts", () => {
    const parts = Array.from({ length: 80 }, (_, index) => ({ type: "input_text", text: String(index).padEnd(8 * 1024, "y") }));
    const body = JSON.stringify({
      input: [user("run"), { type: "function_call_output", call_id: "call_many", output: parts }, user("next")],
    });
    const item = (JSON.parse(slimCodexHistoryJson(body)!) as { input: Array<Record<string, unknown>> }).input[1]!;
    const texts = (item.output as Array<{ text: string }>).map(part => part.text);
    expect(texts.every(text => text.includes("tool output shortened"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(Buffer.byteLength(JSON.stringify(parts)) / 2);
  });

  test("stays off until the live config says codex, including compact", () => {
    bindUpstreamHistorySlimConfig({});
    expect(currentUpstreamHistorySlim()).toBe("off");
    const init = { body: JSON.stringify({ input: [user("a", [image(8_000)]), user("b")] }) };
    expect(slimOutboundCodexHistory(CODEX, init)).toBe(init);
    const live: { upstreamHistorySlim?: "off" | "codex" } = { upstreamHistorySlim: "codex" };
    bindUpstreamHistorySlimConfig(live);
    expect(currentUpstreamHistorySlim()).toBe("codex");
    const slimmed = slimOutboundCodexHistory(COMPACT, init);
    expect(slimmed).not.toBe(init);
    expect(String(slimmed?.body)).not.toContain("data:image");
    expect(slimOutboundCodexHistory("https://api.deepseek.com/v1/responses", init)).toBe(init);
    live.upstreamHistorySlim = "off";
    expect(currentUpstreamHistorySlim()).toBe("off");
  });
});
