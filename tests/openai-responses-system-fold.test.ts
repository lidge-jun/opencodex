import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const canonicalForward = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

const officialOpenAi = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "key" as const,
  apiKey: "sk-test",
};

const nonCanonicalForward = {
  adapter: "openai-responses",
  baseUrl: "https://provider.example/v1/",
  authMode: "forward" as const,
};

const codingAgentSystem = { type: "message", role: "system", content: "You are a coding agent." };
const userHello = { type: "message", role: "user", content: "hello" };
const codingAgentInput = [codingAgentSystem, userHello];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildWire(
  provider: Parameters<typeof createResponsesPassthroughAdapter>[0],
  rawBody: Record<string, unknown>,
) {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: false,
    options: {},
    _rawBody: rawBody,
  });
  const parsed: unknown = JSON.parse(request.body);
  if (!isRecord(parsed)) throw new Error("adapter body must be a JSON object");
  if (!Array.isArray(parsed.input)) throw new Error("adapter body.input must be an array");
  if (!parsed.input.every(isRecord)) throw new Error("adapter body.input items must be objects");
  const body: { input: Record<string, unknown>[]; instructions?: unknown } = {
    input: parsed.input,
  };
  if ("instructions" in parsed) body.instructions = parsed.instructions;
  return body;
}

function expectCodingAgentFold(body: { input: Record<string, unknown>[]; instructions?: unknown }) {
  expect(body.instructions, "folded system text into instructions").toBe("You are a coding agent.");
  expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
  expect(body.input, "kept the user item in input").toEqual([userHello]);
}

describe("OpenAI-operated Responses system-message folding", () => {
  describe("canonical ChatGPT forward", () => {
    test("folds a string system message into instructions", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: codingAgentInput,
      });
      expectCodingAgentFold(body);
    });

    test("appends folded system text after existing instructions", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        instructions: "base instructions",
        input: codingAgentInput,
      });
      expect(body.instructions, "appended folded system text after existing instructions")
        .toBe("base instructions\n\nYou are a coding agent.");
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.input, "kept the user item in input").toEqual([userHello]);
    });

    test("folds input_text array system content into instructions", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [
          { type: "message", role: "system", content: [{ type: "input_text", text: "array system" }] },
          userHello,
        ],
      });
      expect(body.instructions, "folded array system text into instructions").toBe("array system");
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.input, "kept the user item in input").toEqual([userHello]);
    });

    test("joins multiple system messages with a blank line", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [
          { type: "message", role: "system", content: "first" },
          { type: "message", role: "system", content: "second" },
          userHello,
        ],
      });
      expect(body.instructions, "joined system texts with a blank line").toBe("first\n\nsecond");
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.input, "kept the user item in input").toEqual([userHello]);
    });

    test("drops empty system items without inventing instructions", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [
          { type: "message", role: "system", content: "" },
          userHello,
        ],
      });
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.instructions, "did not invent empty instructions").toBeUndefined();
      expect(body.input, "kept the user item in input").toEqual([userHello]);
    });

    test("leaves input and instructions unchanged when no system items exist", () => {
      const input = [userHello];
      const body = buildWire(canonicalForward, {
        model: "test-model",
        instructions: "base instructions",
        input,
      });
      expect(body.input, "left input unchanged").toEqual(input);
      expect(body.instructions, "left instructions unchanged").toBe("base instructions");
    });

    test("folds omitted-type system items into instructions", () => {
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [
          { role: "system", content: "You are a coding agent." },
          userHello,
        ],
      });
      expectCodingAgentFold(body);
    });

    test("leaves developer items in input", () => {
      const developer = { type: "message", role: "developer", content: "prefer diffs" };
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [codingAgentSystem, developer, userHello],
      });
      expect(body.instructions, "folded system text into instructions").toBe("You are a coding agent.");
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.input, "left developer items in input").toEqual([developer, userHello]);
    });

    test("keeps system images as developer items", () => {
      const image = { type: "input_image", image_url: "https://example.test/a.png" };
      const body = buildWire(canonicalForward, {
        model: "test-model",
        input: [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "You are a coding agent." }, image],
          },
          userHello,
        ],
      });
      expect(body.instructions, "folded system text into instructions").toBe("You are a coding agent.");
      expect(body.input.filter(item => item.role === "system"), "dropped system items from input").toEqual([]);
      expect(body.input, "kept leftover system images as developer items").toEqual([
        { type: "message", role: "developer", content: [image] },
        userHello,
      ]);
    });
  });

  describe("official OpenAI API key", () => {
    test("folds a string system message into instructions", () => {
      const body = buildWire(officialOpenAi, {
        model: "test-model",
        input: codingAgentInput,
      });
      expectCodingAgentFold(body);
    });
  });

  describe("non-canonical forward", () => {
    test("leaves system items in input", () => {
      const body = buildWire(nonCanonicalForward, {
        model: "test-model",
        input: codingAgentInput,
      });
      expect(body.input, "left system items in input").toEqual(codingAgentInput);
      expect(body.instructions, "did not fold system text into instructions").toBeUndefined();
    });
  });
});
