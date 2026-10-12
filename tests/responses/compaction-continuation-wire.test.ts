/** Synthetic outbound construction only; no model/provider acceptance is established. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import type { ProviderAdapter } from "../../src/adapters/base";
import { buildSystemPrompt } from "../../src/adapters/coding-agent/protocol";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { createGoogleAdapter } from "../../src/adapters/google";
import { createKiroAdapter } from "../../src/adapters/kiro";
import { createOllamaNativeAdapter } from "../../src/adapters/ollama-native";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { CHECKPOINT_CONTINUATION_NOTE, encodeCompactionSummary } from "../../src/responses/compaction";
import { parseRequest } from "../../src/responses/parser";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const SENTINEL = "Existing instruction sentinel.";
const OLD_REQUEST = "Old user request sentinel.";
const oldRequest = { type: "message", role: "user", content: OLD_REQUEST };
const checkpoint = { type: "compaction", encrypted_content: encodeCompactionSummary("A complete; authorized B unfinished.") };
const controls = [
  { name: "no checkpoint", input: [oldRequest] },
  { name: "opaque native blob", input: [oldRequest, { type: "compaction", encrypted_content: "gAAAAB-native-opaque-blob" }] },
  { name: "compaction/summarizer turn", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] },
];

type SystemInstruction = { parts: Array<{ text: string }> };
type KiroUserEntry = { userInputMessage?: { content: string } };
interface WireBody {
  messages: Array<{ role: string; content: string }>;
  system: Array<{ text: string }>;
  systemInstruction: SystemInstruction;
  request: { systemInstruction: SystemInstruction };
  params: { system: string };
  conversationState: { history?: KiroUserEntry[]; currentMessage: KiroUserEntry };
}

const messageSystem = (body: WireBody): string => body.messages
  .filter(message => message.role === "system" || message.role === "developer")
  .map(message => message.content).join("\n\n");
const googleSystem = (body: WireBody): string => body.systemInstruction.parts.map(part => part.text).join("\n");
const syntheticKey = "synthetic-wire-key";
const routes: Array<{ name: string; model: string; create: () => ProviderAdapter; system: (body: WireBody) => string }> = [
  { name: "OpenAI Chat", model: "local-model", create: () => createOpenAIChatAdapter({
    adapter: "openai-chat", baseUrl: "https://chat.example.invalid/v1", apiKey: syntheticKey,
  }), system: messageSystem },
  { name: "Anthropic", model: "claude-sonnet-4-6", create: () => createAnthropicAdapter({
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: syntheticKey,
  }), system: body => body.system.map(part => part.text).join("\n") },
  { name: "Google AI Studio", model: "gemini-3-pro", create: () => createGoogleAdapter({
    adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: syntheticKey,
  }), system: googleSystem },
  { name: "Google Vertex", model: "gemini-3-pro", create: () => createGoogleAdapter({
    adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex",
    apiKey: syntheticKey, project: "synthetic-project", location: "global",
  }), system: googleSystem },
  { name: "Cloud Code Assist", model: "gemini-3-pro", create: () => createGoogleAdapter({
    adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist",
    apiKey: "synthetic-oauth-token", project: "synthetic-project",
  }), system: body => body.request.systemInstruction.parts.map(part => part.text).join("\n") },
  { name: "Kiro", model: "claude-sonnet-4.5", create: () => createKiroAdapter({
    adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "key", apiKey: "ksk_synthetic-wire-key",
  }), system: body => {
    // Kiro puts system instructions before the first user's text, rather than in a separate field.
    const state = body.conversationState;
    const content = state.history?.find(entry => entry.userInputMessage)?.userInputMessage?.content
      ?? state.currentMessage.userInputMessage?.content;
    expect(content).toBeDefined();
    const boundary = content!.indexOf(OLD_REQUEST);
    expect(boundary).toBeGreaterThanOrEqual(0);
    return content!.slice(0, boundary);
  } },
  { name: "Ollama native", model: "glm-5.3-flash", create: () => createOllamaNativeAdapter({
    adapter: "ollama-native", baseUrl: "https://ollama.com", authMode: "key", apiKey: syntheticKey,
  }), system: messageSystem },
  { name: "Command Code", model: "deepseek/deepseek-v4-flash", create: () => createCommandCodeAdapter({
    adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth", apiKey: syntheticKey,
    projectContext: "off",
  }), system: body => body.params.system },
];

let fixtureHome: string;
let previousHome: string | undefined;
let fetchGuard: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-checkpoint-wire-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("wire construction must not use network or ADC");
  });
});
afterEach(() => {
  fetchGuard.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(fixtureHome);
});

function parsed(model: string, input: unknown[]) {
  const request = parseRequest({ model, instructions: SENTINEL, input });
  // Explicit synthetic metadata avoids consulting imported Kiro credentials.
  request._kiroAuthContext = { apiRegion: "us-east-1" };
  return request;
}

describe("checkpoint continuation wire construction", () => {
  for (const route of routes) {
    test(`${route.name}: system field retains instructions and the prompt contract`, async () => {
      const request = await withTestTranslatorBudget(route.create()).buildRequest(parsed(route.model, [oldRequest, checkpoint]));
      const system = route.system(JSON.parse(request.body) as WireBody);
      expect(system).toContain(SENTINEL);
      expect(system).toContain(CHECKPOINT_CONTINUATION_NOTE);
      expect(fetchGuard).not.toHaveBeenCalled();
    });
    for (const control of controls) {
      test(`${route.name}: wire construction excludes the note for ${control.name}`, async () => {
        const request = await withTestTranslatorBudget(route.create()).buildRequest(parsed(route.model, control.input));
        const system = route.system(JSON.parse(request.body) as WireBody);
        expect(system).toContain(SENTINEL);
        expect(system).not.toContain(CHECKPOINT_CONTINUATION_NOTE);
        expect(fetchGuard).not.toHaveBeenCalled();
      });
    }
  }

  // Cursor and Devin runTurn routes are not covered. Claude CLI, CodeBuddy and Qoder
  // per-CLI runTurn routes are also not covered by this shared prompt-construction assertion.
  test("coding-agent prompt contract: shared builder retains parsed instructions and note", () => {
    const system = buildSystemPrompt(parsed("coding-model", [oldRequest, checkpoint]));
    expect(system).toContain(SENTINEL);
    expect(system).toContain(CHECKPOINT_CONTINUATION_NOTE);
  });
  for (const control of controls) {
    test(`coding-agent prompt contract: shared builder excludes the note for ${control.name}`, () => {
      const system = buildSystemPrompt(parsed("coding-model", control.input));
      expect(system).toContain(SENTINEL);
      expect(system).not.toContain(CHECKPOINT_CONTINUATION_NOTE);
    });
  }
});
