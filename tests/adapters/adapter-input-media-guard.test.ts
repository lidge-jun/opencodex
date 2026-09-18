import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { withInputMediaGuard } from "../../src/adapters/input-media-guard";
import { createRegisteredAdapter } from "../../src/adapters/registry";
import { parseRequest } from "../../src/responses/parser";
import { untranslatedResponsesInputMedia } from "../../src/responses/input-media";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";

const AUDIO = { type: "input_audio", audio_url: "data:audio/wav;base64,YWJj" };
const FILE = { type: "input_file", filename: "private.pdf", file_data: "data:application/pdf;base64,JVBERi0=" };

function request(content: unknown[]): OcxParsedRequest {
  return parseRequest({ model: "test-model", input: [{ type: "message", role: "user", content }] });
}

function fakeAdapter() {
  const seen = { builds: 0, runs: 0, terminals: 0 };
  const adapter: ProviderAdapter = {
    name: "stub",
    buildRequest() {
      seen.builds++;
      return { url: "https://example.invalid", method: "POST", headers: {}, body: "{}" };
    },
    async *parseStream() { yield { type: "done", endTurn: true }; },
    async runTurn(_parsed, _incoming, emit) { seen.runs++; emit({ type: "done", endTurn: true }); },
    localTerminal() { seen.terminals++; return { reason: "already answered" }; },
  };
  return { adapter: withInputMediaGuard(adapter), seen };
}

describe("typed input media inspection", () => {
  test("recognizes user audio and inline file without inspecting payload strings", () => {
    expect(untranslatedResponsesInputMedia(request([AUDIO])._rawBody)).toBe("audio");
    expect(untranslatedResponsesInputMedia(request([FILE])._rawBody)).toBe("file");
  });

  test("recognizes tool and custom-tool attachments", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
      expect(untranslatedResponsesInputMedia({ input: [{ type, call_id: "call1", output: [AUDIO] }] })).toBe("audio");
      expect(untranslatedResponsesInputMedia({ input: [{ type, call_id: "call1", output: [FILE] }] })).toBe("file");
    }
  });

  test("recognizes file-id-only images but keeps actual image URLs", () => {
    expect(untranslatedResponsesInputMedia({ input: [{ role: "user", content: [{ type: "input_image", file_id: "file-1" }] }] })).toBe("file");
    expect(untranslatedResponsesInputMedia({ input: [{ role: "user", content: [{ type: "input_image", file_id: "file-1", image_url: "https://example.invalid/image.png" }] }] })).toBeUndefined();
  });

  test("does not parse text, tool arguments or schema properties as attachments", () => {
    expect(untranslatedResponsesInputMedia({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify(AUDIO) }] },
        { type: "function_call", name: "f", call_id: "c", arguments: JSON.stringify(FILE) },
        { type: "function_call_output", call_id: "c", output: JSON.stringify(AUDIO) },
      ],
      tools: [{ type: "function", name: "f", parameters: { type: "object", properties: { audio: AUDIO } } }],
    })).toBeUndefined();
  });
});

describe("final translated-adapter boundary", () => {
  test("build refuses before the adapter can serialize or send; errors contain no payload", () => {
    const { adapter, seen } = fakeAdapter();
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };
    for (const part of [AUDIO, FILE]) {
      let failure: unknown;
      try { adapter.buildRequest(request([part]), incoming); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("OpenCodex cannot translate");
      expect(message).not.toContain("private.pdf");
      expect(message).not.toContain("base64");
      expect(message).not.toContain("YWJj");
    }
    expect(seen.builds).toBe(0);
  });

  test("runTurn emits one terminal nonretryable 400 without invoking the transport", async () => {
    const { adapter, seen } = fakeAdapter();
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request([AUDIO]), {
      headers: new Headers(), translatorBudget: createTestTranslatorBudget(),
    }, event => { events.push(event); });
    expect(seen.runs).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", errorType: "invalid_request_error", retryable: false });
  });

  test("local completion cannot hide a rejected attachment", () => {
    const { adapter, seen } = fakeAdapter();
    expect(adapter.localTerminal!(request([FILE]))).toBeUndefined();
    expect(seen.terminals).toBe(0);
    expect(adapter.localTerminal!(request([{ type: "input_text", text: "answered" }]))).toEqual({ reason: "already answered" });
    expect(seen.terminals).toBe(1);
  });

  test("ordinary text still reaches build and runTurn", async () => {
    const { adapter, seen } = fakeAdapter();
    const parsed = request([{ type: "input_text", text: "hello" }]);
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };
    adapter.buildRequest(parsed, incoming);
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, incoming, event => { events.push(event); });
    expect(seen).toMatchObject({ builds: 1, runs: 1 });
    expect(events[0]).toMatchObject({ type: "done" });
  });
});

describe("runtime registry and native passthrough exceptions", () => {
  test("registry construction cannot bypass the guard for translated adapters", async () => {
    for (const adapter of ["openai-chat", "anthropic", "google", "kiro", "cursor", "devin", "codebuddy", "qoder"]) {
      const provider: OcxProviderConfig = {
        adapter, baseUrl: "https://example.invalid/v1", authMode: "key", apiKey: "test-placeholder",
      };
      const runtime = withTestTranslatorBudget(createRegisteredAdapter(provider));
      await expect(Promise.resolve().then(() => runtime.buildRequest(request([AUDIO])))).rejects.toThrow("OpenCodex cannot translate audio");
    }
  });

  test("Responses and both Azure aliases preserve raw media after a rejected translated attempt", async () => {
    for (const adapter of ["openai-responses", "azure", "azure-openai"]) {
      const parsed = request([AUDIO, FILE]);
      const original = structuredClone(parsed._rawBody);
      const rejected = withTestTranslatorBudget(createRegisteredAdapter({
        adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "test-placeholder", authMode: "key",
      }));
      await expect(Promise.resolve().then(() => rejected.buildRequest(parsed))).rejects.toThrow("cannot translate audio");
      const runtime = withTestTranslatorBudget(createRegisteredAdapter({
        adapter, baseUrl: "https://example.invalid/v1", apiKey: "test-placeholder", authMode: "key",
      }));
      const wire = JSON.parse((await runtime.buildRequest(parsed)).body);
      expect(wire.input[0].content).toEqual([AUDIO, FILE]);
      expect(parsed._rawBody).toEqual(original);
    }
  });
});
