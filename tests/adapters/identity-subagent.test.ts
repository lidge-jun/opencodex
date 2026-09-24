import { describe, expect, test } from "bun:test";
import {
  CODEX_GPT5_IDENTITY_LINE,
  identifyRoutedModel,
  nameRoutedIdentity,
  NEUTRAL_IDENTITY_LINE,
  repairIdentityInResponsesBody,
  repairRoutedIdentity,
  stripRoutedIdentity,
} from "../../src/adapters/identity";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig, OcxTextContent } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

/** The sentence the proxy generated for the PARENT session, which a spawned worker inherits (#5217). */
const PARENT_IDENTITY = "You are a coding agent powered by the deepseek-v4.1-flash. If asked which model you are, identify as deepseek-v4.1-flash. Do not claim to be a different model or to have a different creator.";

const WORKER_MODEL = "gpt-6-astra";

function developerItem(text: string) {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function systemPromptOf(instructions: string): string {
  return parseRequest({ model: WORKER_MODEL, instructions, input: [] }).context.systemPrompt!.join("\n\n");
}

function textOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as OcxTextContent[]).map(part => part.text).join("");
}

/** The Responses passthrough forwards `_rawBody` mostly verbatim, so identity repair is its own step. */
function passthroughBody(provider: OcxProviderConfig, instructions: string): Record<string, unknown> {
  const request = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest({
    modelId: WORKER_MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: WORKER_MODEL, instructions, input: "ping" },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("sub-agent identity inheritance (#5217)", () => {
  test("a stale routed identity sentence is rewritten to the destination model", () => {
    const out = repairRoutedIdentity(`${PARENT_IDENTITY}\n\nUse tools carefully.`, WORKER_MODEL);
    expect(out).toContain(`identify as ${WORKER_MODEL}`);
    expect(out).not.toContain("deepseek-v4.1-flash");
    expect(out).toContain("Use tools carefully.");
  });

  test("identifyRoutedModel also repairs a stale sentence and the neutral catalog line", () => {
    expect(identifyRoutedModel(PARENT_IDENTITY, WORKER_MODEL)).toContain(`identify as ${WORKER_MODEL}`);
    expect(identifyRoutedModel(NEUTRAL_IDENTITY_LINE, WORKER_MODEL)).toContain(`identify as ${WORKER_MODEL}`);
  });

  test("nameRoutedIdentity names the model-neutral catalog line", () => {
    // The catalog block is model-neutral on disk (#5217), so a routed adapter that builds its own
    // system text has to be given the destination id here — the neutral text alone names no model.
    const out = nameRoutedIdentity(`${NEUTRAL_IDENTITY_LINE}\n\nUse tools carefully.`, WORKER_MODEL);
    expect(out).toContain(`powered by the ${WORKER_MODEL}`);
    expect(out).toContain(`identify as ${WORKER_MODEL}`);
    expect(out).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(out).toContain("Use tools carefully.");
  });

  test("a native destination drops the routed sentence instead of renaming it", () => {
    const out = stripRoutedIdentity(`${PARENT_IDENTITY}\n\nYou and the user share one workspace.`);
    expect(out).not.toContain("powered by the");
    expect(out).not.toContain("deepseek-v4.1-flash");
    expect(out).toBe("You and the user share one workspace.");
  });

  test("text the proxy did not generate is never rewritten", () => {
    for (const text of [
      "The user asked: which model are you?",
      "```\nYou are a coding agent powered by the thing I wrote myself.\n```",
      "You are a Claude agent built by Anthropic.",
      CODEX_GPT5_IDENTITY_LINE,
    ]) {
      expect(repairRoutedIdentity(text, WORKER_MODEL)).toBe(text);
      expect(nameRoutedIdentity(text, WORKER_MODEL)).toBe(text);
      expect(stripRoutedIdentity(text)).toBe(text.trim());
    }
  });

  test("the parser names the destination in the top-level instructions block", () => {
    // This is a routed adapter's path: some never call identifyRoutedModel, so the stored block
    // reaches the wire as-is unless the parser names the model the request is going to.
    expect(systemPromptOf(PARENT_IDENTITY)).toContain(`identify as ${WORKER_MODEL}`);
    expect(systemPromptOf(PARENT_IDENTITY)).not.toContain("deepseek-v4.1-flash");
    expect(systemPromptOf(NEUTRAL_IDENTITY_LINE)).toContain(`identify as ${WORKER_MODEL}`);
  });

  test("the parser leaves Codex's own GPT identity line alone", () => {
    // Adapters handle that line; naming a routed model is this layer's job only.
    expect(systemPromptOf(CODEX_GPT5_IDENTITY_LINE)).toBe(CODEX_GPT5_IDENTITY_LINE);
  });

  test("the parser repairs the worker's developer item and leaves user turns alone", () => {
    const parsed = parseRequest({
      model: WORKER_MODEL,
      input: [
        developerItem(PARENT_IDENTITY),
        developerItem(NEUTRAL_IDENTITY_LINE),
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    });
    const [developer, neutralDeveloper, user] = parsed.context.messages;
    expect(textOf(developer!.content)).toContain(`identify as ${WORKER_MODEL}`);
    expect(textOf(developer!.content)).not.toContain("deepseek-v4.1-flash");
    expect(textOf(neutralDeveloper!.content)).toContain(`identify as ${WORKER_MODEL}`);
    // A user turn is the caller's own content; it stays byte-identical.
    expect(textOf(user!.content)).toBe(PARENT_IDENTITY);
  });

  test("a routed chat destination sends the worker's own model in the system message", async () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.invalid",
      apiKey: "key",
    } as unknown as OcxProviderConfig;
    const parsed = parseRequest({
      model: "some/routed-worker",
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const { body } = await createOpenAIChatAdapter(provider).buildRequest(parsed);
    const system = (JSON.parse(body).messages as { role: string; content: string }[])
      .find(message => message.role === "system")!;
    expect(system.content).toContain("identify as some/routed-worker");
    expect(system.content).not.toContain("deepseek-v4.1-flash");
  });

  test("the Responses body repair covers instructions and developer items only", () => {
    const body = {
      model: WORKER_MODEL,
      instructions: PARENT_IDENTITY,
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    };
    const routed = repairIdentityInResponsesBody(body, text => nameRoutedIdentity(text, WORKER_MODEL)) as typeof body;
    expect(routed.instructions).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[0]!.content as { text: string }[])[0]!.text).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[1]!.content as { text: string }[])[0]!.text).toBe(PARENT_IDENTITY);
  });

  test("a forward destination drops a stripped instructions value instead of sending it empty", () => {
    const body = { model: WORKER_MODEL, instructions: PARENT_IDENTITY, input: [developerItem(PARENT_IDENTITY)] };
    const native = repairIdentityInResponsesBody(body, stripRoutedIdentity) as {
      instructions?: string;
      input: { content: { text: string }[] }[];
    };
    // `""` is a different request from an absent key, and an instruction item that held only our
    // sentence is a message the caller never wrote.
    expect(native).not.toHaveProperty("instructions");
    expect(native.input).toHaveLength(0);

    const kept = repairIdentityInResponsesBody({
      model: WORKER_MODEL,
      instructions: `${PARENT_IDENTITY}\n\nKeep this.`,
      input: [{
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: PARENT_IDENTITY }, { type: "input_image", image_url: "data:x" }],
      }],
    }, stripRoutedIdentity) as { instructions: string; input: { content: { type: string }[] }[] };
    expect(kept.instructions).toBe("Keep this.");
    // The image part is content, so an item holding one is not empty and stays.
    expect(kept.input).toHaveLength(1);
  });

  test("a body with no proxy identity is returned unchanged", () => {
    const body = { model: WORKER_MODEL, input: [developerItem("plain instructions")] };
    expect(repairIdentityInResponsesBody(body, text => nameRoutedIdentity(text, WORKER_MODEL))).toBe(body);
    expect(repairIdentityInResponsesBody(body, stripRoutedIdentity)).toBe(body);
  });

  test("the Responses passthrough names the destination on a routed destination", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://api.example.invalid/v1",
      authMode: "key",
      apiKey: "key",
    } as unknown as OcxProviderConfig;
    const body = passthroughBody(provider, `${NEUTRAL_IDENTITY_LINE}\n\nUse tools carefully.`);
    expect(body.instructions).toContain(`identify as ${WORKER_MODEL}`);
    expect(body.instructions).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(body.instructions).toContain("Use tools carefully.");
  });

  test("the Responses passthrough drops our sentence on a forward destination", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    } as unknown as OcxProviderConfig;
    // Codex's own identity wording is the correct one at a first-party destination, and an empty
    // instruction string is a different payload from an absent key.
    expect(passthroughBody(provider, `${PARENT_IDENTITY}\n\nKeep this.`).instructions).toBe("Keep this.");
    expect(passthroughBody(provider, PARENT_IDENTITY)).not.toHaveProperty("instructions");
  });
});
