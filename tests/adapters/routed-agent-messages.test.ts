import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { normalizeRoutedAgentMessages } from "../../src/adapters/routed-agent-messages";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxProviderConfig } from "../../src/types";

const base: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "synthetic-key" };
const body = () => ({ model: "muse-spark-1.3-contributor", input: [{ type: "agent_message", id: "amsg_test", author: "/root/reader", recipient: "/root/checker", content: [{ type: "input_text", text: "Exact assignment\nwith lines." }] }], stream: true });

test("Responses converts plaintext task and peer messages without mutating replay or losing routing identities", async () => {
  const raw = body(); const original = structuredClone(raw); const budget = createTranslatorBudget();
  const request = await createResponsesPassthroughAdapter(base).buildRequest(parseRequest(raw), { headers: new Headers(), translatorBudget: budget });
  const sent = JSON.parse(request.body as string);
  expect(sent.input[0].type).toBe("message");
  expect(sent.input[0].role).toBe("user");
  expect(sent.input[0].content[0].text).toContain('"author":"/root/reader"');
  expect(sent.input[0].content[0].text).toContain('"recipient":"/root/checker"');
  expect(sent.input[0].content[1]).toEqual(raw.input[0]!.content[0]);
  expect(sent.input[0].id).toBeUndefined();
  expect(raw).toEqual(original);
  budget.dispose();
});

test("ciphertext and unknown content are never reclassified as plaintext", () => {
  for (const part of [{ type: "encrypted_content", encrypted_content: "opaque" }, { type: "future_type", text: "opaque" }]) {
    const raw = { input: [{ type: "agent_message", content: [part] }] };
    expect(normalizeRoutedAgentMessages(raw)).toBe(raw);
  }
});

test("string agent messages require an explicit opt-in and preserve exact text", () => {
  const text = "  Child result\nwith a trailing line.\n ";
  const message = Object.freeze({ type: "agent_message", id: "amsg_string", content: text });
  const raw = Object.freeze({ input: Object.freeze([message]) });
  expect(normalizeRoutedAgentMessages(raw)).toBe(raw);
  expect(normalizeRoutedAgentMessages(raw, { allowStringContent: false })).toBe(raw);
  expect(normalizeRoutedAgentMessages(raw, { allowStringContent: true })).toEqual({ input: [{
    type: "message", role: "user", content: [{ type: "input_text", text }],
  }] });
  expect(raw.input[0]).toBe(message);
  expect(message.content).toBe(text);
});

for (const baseUrl of ["https://api.x.ai/v1", "https://cli-chat-proxy.grok.com/v1"]) {
  test.each(["key", "oauth"] as const)(`${baseUrl} lowers string child results with %s auth`, async authMode => {
    const raw = { model: "grok-4.6", stream: true, input: [{
      type: "agent_message", id: "amsg_string", author: "/root/worker", recipient: "/root",
      content: "  Complete child result\nSecond line.\n ",
    }] };
    const original = structuredClone(raw);
    const parsed = parseRequest(raw);
    const budget = createTranslatorBudget();
    try {
      const request = await createResponsesPassthroughAdapter({ ...base, baseUrl, authMode }).buildRequest(parsed, {
        headers: new Headers(), translatorBudget: budget,
      });
      const sent = JSON.parse(request.body as string);
      expect(sent.input).toEqual([{
        type: "message", role: "user", content: [
          { type: "input_text", text: 'Agent message {"author":"/root/worker","recipient":"/root"}' },
          { type: "input_text", text: original.input[0]!.content },
        ],
      }]);
      expect(parsed._rawBody).toBe(raw);
      expect(raw).toEqual(original);
    } finally {
      budget.dispose();
    }
  });
}

test.each([
  { baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
  { baseUrl: "https://api.x.ai/v1", authMode: "forward" as const },
  { baseUrl: "https://cli-chat-proxy.grok.com/v1", authMode: "forward" as const },
  { baseUrl: "https://custom.test/v1", authMode: "forward" as const },
  { baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key" as const },
  { baseUrl: "https://example.test/v1", authMode: "key" as const },
  { baseUrl: "https://api.x.ai.evil.test/v1", authMode: "key" as const },
  { baseUrl: "https://cli-chat-proxy.grok.com.evil.test/v1", authMode: "key" as const },
  { baseUrl: "http://api.x.ai/v1", authMode: "key" as const },
  { baseUrl: "https://api.x.ai:444/v1", authMode: "key" as const },
])("preserves string messages for $authMode at $baseUrl", async destination => {
  const raw = { model: "grok-4.6", input: [{ type: "agent_message", content: "Child result" }] };
  const original = structuredClone(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter({ ...base, ...destination }).buildRequest(parseRequest(raw), {
      headers: new Headers(), translatorBudget: budget,
    });
    expect(JSON.parse(request.body as string).input).toEqual(original.input);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

test.each([
  "", " \n\t", null, 42, { text: "not a content string" }, [],
  [{ type: "encrypted_content", encrypted_content: "opaque" }],
  [{ type: "input_text", text: "Routing header" }, { type: "encrypted_content", encrypted_content: "opaque" }],
  [{ type: "input_text", text: "Known prefix" }, { type: "future_type", text: "Unknown suffix" }],
].map(content => ({ content })))("xAI string opt-in leaves incomplete or unreadable content unchanged: %j", async ({ content }) => {
  const raw = { model: "grok-4.6", input: [{ type: "agent_message", content }] };
  const original = structuredClone(raw);
  expect(normalizeRoutedAgentMessages(raw, { allowStringContent: true })).toBe(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter({ ...base, baseUrl: "https://api.x.ai/v1" }).buildRequest(parseRequest(raw), {
      headers: new Headers(), translatorBudget: budget,
    });
    expect(JSON.parse(request.body as string).input).toEqual(original.input);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

test("image parts stay intact beside the assignment", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
  const raw = { input: [{ type: "agent_message", content: [{ type: "input_text", text: "Inspect image" }, image] }] };
  const result = normalizeRoutedAgentMessages(raw) as typeof raw;
  expect(result.input[0]!.content[1]).toBe(image);
});

test("a body with no agent messages keeps its exact reference", () => {
  const raw = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
  expect(normalizeRoutedAgentMessages(raw)).toBe(raw);
  for (const shape of [null, "a string", [1, 2], { input: "not an array" }]) {
    expect(normalizeRoutedAgentMessages(shape)).toBe(shape);
  }
});

test("native forward keeps agent_message and auth/session headers unchanged", async () => {
  const budget = createTranslatorBudget();
  const provider = { ...base, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
  const request = await createResponsesPassthroughAdapter(provider).buildRequest(parseRequest(body()), { headers: new Headers({ "session-id": "native-id", authorization: "Bearer native-test" }), translatorBudget: budget });
  expect(JSON.parse(request.body as string).input[0].type).toBe("agent_message");
  expect(new Headers(request.headers).get("x-opencode-session")).toBeNull();
  expect(new Headers(request.headers).get("session-id")).toBe("native-id");
  expect(new Headers(request.headers).get("authorization")).toBe("Bearer native-test");
  budget.dispose();
});

test("an arbitrary routed destination converts too, and gains no session identity", async () => {
  // The 422 this guards against is not destination-specific: `agent_message` is private to
  // the ChatGPT Codex backend, so any routed Responses target rejects the whole body.
  const budget = createTranslatorBudget();
  const raw = body();
  const original = structuredClone(raw);
  const parsed = parseRequest(raw);
  const request = await createResponsesPassthroughAdapter({ ...base, baseUrl: "https://example.test/v1" }).buildRequest(parsed, { headers: new Headers({ "session-id": "child-id" }), translatorBudget: budget });
  const sent = JSON.parse(request.body as string);
  expect(sent.input[0]).toMatchObject({ type: "message", role: "user" });
  expect(sent.input[0].content.slice(1)).toEqual(original.input[0]!.content);
  expect(new Headers(request.headers).get("x-opencode-session")).toBeNull();
  expect(parsed._rawBody).toBe(raw);
  expect(raw).toEqual(original);
  budget.dispose();
});

test("an OAuth destination converts as well, since the gate reads authMode rather than the URL", async () => {
  // The reported xAI/Grok failure (#3907) is an OAuth pool destination, not a key-auth
  // one, and the gate is `authMode !== "forward"`. Pin a mode other than key/forward so
  // a future narrowing of the gate back toward key-only cannot pass unnoticed.
  const budget = createTranslatorBudget();
  const raw = body();
  const original = structuredClone(raw);
  try {
    const request = await createResponsesPassthroughAdapter({
      ...base, baseUrl: "https://api.x.ai/v1", authMode: "oauth" as const,
    }).buildRequest(parseRequest(raw), { headers: new Headers(), translatorBudget: budget });
    const sent = JSON.parse(request.body as string);
    expect(sent.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(sent.input[0].content.slice(1)).toEqual(original.input[0]!.content);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

test("canonical Go forward auth preserves private agent messages and the raw replay body", async () => {
  const raw = body();
  const original = structuredClone(raw);
  const parsed = parseRequest(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter({ ...base, authMode: "forward" }).buildRequest(parsed, {
      headers: new Headers(), translatorBudget: budget,
    });
    expect(request.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(JSON.parse(request.body as string).input[0]).toMatchObject({
      type: "agent_message", author: "/root/reader", recipient: "/root/checker",
      content: original.input[0]!.content,
    });
    expect(parsed._rawBody).toBe(raw);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

test.each(["https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/"])(
  "a renamed provider at %s still converts plaintext agent messages",
  async baseUrl => {
    const raw = body();
    const original = structuredClone(raw);
    const route = routeModel({
      port: 0, defaultProvider: "my-go", providers: { "my-go": { ...base, baseUrl, models: [raw.model] } },
    }, `my-go/${raw.model}`);
    const parsed = parseRequest(raw);
    const budget = createTranslatorBudget();
    try {
      const request = await createResponsesPassthroughAdapter(route.provider).buildRequest(parsed, {
        headers: new Headers(), translatorBudget: budget,
      });
      const sent = JSON.parse(request.body as string);
      expect(request.url).toBe("https://opencode.ai/zen/go/v1/responses");
      expect(sent.input[0]).toMatchObject({ type: "message", role: "user" });
      expect(sent.input[0].content.slice(1)).toEqual(original.input[0]!.content);
      expect(parsed._rawBody).toBe(raw);
      expect(raw).toEqual(original);
    } finally {
      budget.dispose();
    }
  },
);

test.each([
  "https://opencode.ai.evil.test/zen/go/v1",
  "http://opencode.ai/zen/go/v1",
  "https://opencode.ai/zen/v1",
  "https://opencode.ai/zen/go/v10",
])("Go-like destination %s converts without inheriting any Go-specific handling", async baseUrl => {
  // A spoofed or malformed Go URL is just another routed destination now. It gets the same
  // conversion every routed target gets, and still no Go session identity.
  const raw = body();
  const original = structuredClone(raw);
  const parsed = parseRequest(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter({ ...base, baseUrl }).buildRequest(parsed, {
      headers: new Headers({ "session-id": "child-id" }), translatorBudget: budget,
    });
    const sent = JSON.parse(request.body as string);
    expect(sent.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(sent.input[0].content.slice(1)).toEqual(original.input[0]!.content);
    expect(new Headers(request.headers).get("x-opencode-session")).toBeNull();
    expect(parsed._rawBody).toBe(raw);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

test("conversion preserves file payloads beside text without mutating raw replay", async () => {
  const file = { type: "input_file", filename: "assignment.txt", file_data: "data:text/plain;base64,SGVsbG8=" };
  const message = body().input[0]!;
  const raw = { ...body(), input: [{ ...message, content: [...message.content, file] }] };
  const original = structuredClone(raw);
  const parsed = parseRequest(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter(base).buildRequest(parsed, {
      headers: new Headers(), translatorBudget: budget,
    });
    const sent = JSON.parse(request.body as string);
    expect(sent.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(sent.input[0].content.slice(1)).toEqual(original.input[0]!.content);
    expect(parsed._rawBody).toBe(raw);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});

for (const { name, content } of [
  { name: "empty content", content: [] },
  { name: "text mixed with an unknown part", content: [
    { type: "input_text", text: "Known prefix" }, { type: "future_type", text: "Do not lose this" },
  ] },
  { name: "text mixed with ciphertext", content: [
    { type: "input_text", text: "Routing header" }, { type: "encrypted_content", encrypted_content: "opaque" },
  ] },
]) test(`routed destinations preserve ${name} without partially converting it`, async () => {
  const raw = { ...body(), input: [{ ...body().input[0]!, content }] };
  const original = structuredClone(raw);
  expect(normalizeRoutedAgentMessages(raw)).toBe(raw);
  const parsed = parseRequest(raw);
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter(base).buildRequest(parsed, {
      headers: new Headers(), translatorBudget: budget,
    });
    expect(JSON.parse(request.body as string).input[0]).toMatchObject({ type: "agent_message", content });
    expect(parsed._rawBody).toBe(raw);
    expect(raw).toEqual(original);
  } finally {
    budget.dispose();
  }
});
