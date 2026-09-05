import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { normalizeOpenCodeGoAgentMessages } from "../../src/adapters/opencode-go";
import { parseRequest } from "../../src/responses/parser";
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
    expect(normalizeOpenCodeGoAgentMessages(raw)).toBe(raw);
  }
});

test("image parts stay intact beside the assignment", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
  const raw = { input: [{ type: "agent_message", content: [{ type: "input_text", text: "Inspect image" }, image] }] };
  const result = normalizeOpenCodeGoAgentMessages(raw) as typeof raw;
  expect(result.input[0]!.content[1]).toBe(image);
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

test("other destinations do not get Go normalization or session identity", async () => {
  const budget = createTranslatorBudget();
  const request = await createResponsesPassthroughAdapter({ ...base, baseUrl: "https://example.test/v1" }).buildRequest(parseRequest(body()), { headers: new Headers({ "session-id": "child-id" }), translatorBudget: budget });
  expect(JSON.parse(request.body as string).input[0].type).toBe("agent_message");
  expect(new Headers(request.headers).get("x-opencode-session")).toBeNull();
  budget.dispose();
});
