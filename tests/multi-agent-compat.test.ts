/**
 * Multi-agent compatibility shims (follow-up to devlog/260709_v2_gated_ultra):
 * models are no longer v1-pinned by ocx, but legacy/v1-surface requests still need
 * the Proactive delegation prompt when they arrive with the synthetic top tier.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectDeveloperMessage, multiAgentGuidanceText, sanitizeEncryptedContentInPlace } from "../src/server/responses";
import type { OcxParsedRequest } from "../src/types";

const savedCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

function codexHomeFixture(configToml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v1pin-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), configToml);
  process.env.CODEX_HOME = dir;
  return dir;
}

const V2_ON = "[features.multi_agent_v2]\nenabled = true\n";
const V2_OFF = "[features]\nmulti_agent = true\n";

function parsedFixture(over: {
  reasoning?: string;
  tools?: Array<{ name: string; namespace?: string }>;
  rawInput?: unknown;
}): OcxParsedRequest {
  return {
    modelId: "gpt-5.5",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: (over.tools ?? [{ name: "spawn_agent" }]) as never,
    },
    stream: true,
    options: over.reasoning ? { reasoning: over.reasoning as never } : {},
    _rawBody: { model: "gpt-5.5", input: over.rawInput ?? [] },
  };
}

describe("multiAgentGuidanceText", () => {
  test("v1 tool surface + max injects the tagged Proactive text", async () => {
    codexHomeFixture(V2_OFF); // guidance fires regardless of v2 flag
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }, { name: "send_input", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("v1 tool surface below the top tier stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ tools: v1Tools }))).toBeNull();
  });

  test("v2 or non-agent tool surfaces stay silent even at max", async () => {
    codexHomeFixture(V2_OFF);
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent" }] }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "shell" }] }))).toBeNull();
  });

  test("v2 flag off still fires guidance (ultra is always-on)", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
  });

  test("injectionModel is named in the dynamic section", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "agents" }] }),
      "anthropic/claude-sonnet-5",
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
    expect(text).toContain('"anthropic/claude-sonnet-5"');
    expect(text).toContain("spawn_agent");
  });

  test("no injectionModel produces base prompt only at max", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "agents" }] }),
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
    expect(text).not.toContain("routed model");
  });

  test("injectionModel fires prompt even at low effort", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "high", tools: [{ name: "spawn_agent", namespace: "agents" }] }),
      "opencode-go/glm-5.2",
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
    expect(text).toContain('"opencode-go/glm-5.2"');
  });

  test("injectionModel fires prompt even without effort set", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent", namespace: "agents" }] }),
      "anthropic/claude-opus-4-6",
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("without injectionModel, low effort stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "medium", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }))).not.toBeNull();
  });
});

describe("injectDeveloperMessage", () => {
  test("appends to both the parsed messages and the raw passthrough input", () => {
    const parsed = parsedFixture({ reasoning: "max" });
    injectDeveloperMessage(parsed, "hello there");
    const last = parsed.context.messages.at(-1)!;
    expect(last.role).toBe("developer");
    expect(last.content).toBe("hello there");
    const rawInput = (parsed._rawBody as { input: unknown[] }).input;
    expect(rawInput.at(-1)).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "hello there" }],
    });
  });

  test("string raw input is left alone", () => {
    const parsed = parsedFixture({ reasoning: "max", rawInput: "plain" });
    injectDeveloperMessage(parsed, "note");
    expect((parsed._rawBody as { input: unknown }).input).toBe("plain");
    expect(parsed.context.messages.at(-1)!.content).toBe("note");
  });

  test("inserts BEFORE compaction_trigger so it stays the final input item", () => {
    const parsed = parsedFixture({ reasoning: "max" });
    const rawBody = parsed._rawBody as { input: unknown[] };
    rawBody.input = [
      { type: "message", role: "user", content: "long conversation" },
      { type: "compaction_trigger" },
    ];
    injectDeveloperMessage(parsed, "guidance text");
    const input = rawBody.input;
    expect(input).toHaveLength(3);
    expect((input[1] as { type: string }).type).toBe("message");
    expect((input[1] as { role: string }).role).toBe("developer");
    expect((input[2] as { type: string }).type).toBe("compaction_trigger");
  });
});

describe("sanitizeEncryptedContentInPlace", () => {
  test("plaintext parked in encrypted slots becomes input_text; real blobs survive", () => {
    const blob = "gAAAAAB".padEnd(120, "Qw1_-=");
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: "[CXC-LEAF-GUARD] plain text with spaces" },
        { type: "input_text", text: "untouched" },
      ] },
      { type: "function_call_output", call_id: "c1", output: { content: [
        { type: "encrypted_content", encrypted_content: blob },
        { type: "encrypted_content", encrypted_content: "short" },
      ] } },
    ];
    const rewritten = sanitizeEncryptedContentInPlace(input);
    expect(rewritten).toBe(2);
    const msgParts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(msgParts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] plain text with spaces" });
    expect(msgParts[1]).toEqual({ type: "input_text", text: "untouched" });
    const outParts = ((input[1] as { output: { content: Array<Record<string, unknown>> } }).output).content;
    expect(outParts[0]).toEqual({ type: "encrypted_content", encrypted_content: blob });
    expect(outParts[1]).toEqual({ type: "input_text", text: "short" });
  });

  test("non-array input is a no-op", () => {
    expect(sanitizeEncryptedContentInPlace("plain")).toBe(0);
    expect(sanitizeEncryptedContentInPlace(undefined)).toBe(0);
  });

  test("mixed slot (hook preamble + embedded Fernet task) splits into text + encrypted parts", () => {
    const fernet = "gAAAA" + "Ab1_-".repeat(20) + "==";
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: `[CXC-LEAF-GUARD] follow the rules.\n\n${fernet}` },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] follow the rules.\n\n" });
    expect(parts[1]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });

  test("pure Fernet slot stays byte-identical", () => {
    const fernet = "gAAAA" + "Ab1_-".repeat(20) + "==";
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: fernet },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(0);
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts[0]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });
});
