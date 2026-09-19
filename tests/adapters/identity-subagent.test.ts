import { describe, expect, test } from "bun:test";
import {
  identifyRoutedModel,
  NEUTRAL_IDENTITY_LINE,
  repairIdentityInResponsesBody,
  repairRoutedIdentity,
  stripRoutedIdentity,
} from "../../src/adapters/identity";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig, OcxTextContent } from "../../src/types";

/** The sentence the proxy generated for the PARENT session, which a spawned worker inherits (#5217). */
const PARENT_IDENTITY = "You are a coding agent powered by the deepseek-v4.1-flash. If asked which model you are, identify as deepseek-v4.1-flash. Do not claim to be a different model or to have a different creator.";

const WORKER_MODEL = "gpt-6-astra";

function developerItem(text: string) {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
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
    ]) {
      expect(repairRoutedIdentity(text, WORKER_MODEL)).toBe(text);
      expect(stripRoutedIdentity(text)).toBe(text.trim());
    }
  });

  test("the parser repairs the worker's developer item and leaves user turns alone", () => {
    const parsed = parseRequest({
      model: WORKER_MODEL,
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    });
    const [developer, user] = parsed.context.messages;
    const textOf = (content: unknown): string => (typeof content === "string"
      ? content
      : (content as OcxTextContent[]).map(part => part.text).join(""));
    expect(textOf(developer!.content)).toContain(`identify as ${WORKER_MODEL}`);
    expect(textOf(developer!.content)).not.toContain("deepseek-v4.1-flash");
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
    const routed = repairIdentityInResponsesBody(body, text => repairRoutedIdentity(text, WORKER_MODEL)) as typeof body;
    expect(routed.instructions).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[0]!.content as { text: string }[])[0]!.text).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[1]!.content as { text: string }[])[0]!.text).toBe(PARENT_IDENTITY);

    const native = repairIdentityInResponsesBody(body, stripRoutedIdentity) as typeof body;
    expect(native.instructions).toBe("");
    expect((native.input[0]!.content as { text: string }[])[0]!.text).toBe("");
  });

  test("a body with no proxy identity is returned unchanged", () => {
    const body = { model: WORKER_MODEL, input: [developerItem("plain instructions")] };
    expect(repairIdentityInResponsesBody(body, text => repairRoutedIdentity(text, WORKER_MODEL))).toBe(body);
  });
});
