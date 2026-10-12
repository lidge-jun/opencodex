import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as productionAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { XAI_GROK_CLI_BASE_URL } from "../../src/providers/xai-transport";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
const createResponsesPassthroughAdapter = (...args: Parameters<typeof productionAdapter>) =>
  withTestTranslatorBudget(productionAdapter(...args));

describe("xAI empty tool catalog compatibility", () => {
  const xai = { adapter: "openai-responses", baseUrl: XAI_GROK_CLI_BASE_URL, authMode: "key" as const };
  const fn = { type: "function", name: "probe", parameters: { type: "object", properties: {} } };
  const wire = (extra: Record<string, unknown>, destination = xai) => {
    const body = { model: "grok-4.6", input: [{ role: "user", content: "OK" }], ...extra };
    const before = JSON.stringify(body);
    const result = JSON.parse(createResponsesPassthroughAdapter(destination).buildRequest(parseRequest(body)).body);
    expect(JSON.stringify(body)).toBe(before);
    return result;
  };
  for (const choice of ["auto", "none"]) {
    test.each([{}, { tools: [] }])(`omits ${choice} without declared tools %#`, tools => {
      expect(wire({ ...tools, tool_choice: choice })).not.toHaveProperty("tool_choice");
    });
    test(`keeps ${choice} with an available function`, () => {
      expect(wire({ tools: [fn], tool_choice: choice }).tool_choice).toBe(choice);
    });
  }
  test.each(["required", { type: "function", name: "probe" }])("does not relax forced tool selection %#", choice => {
    expect(wire({ tools: [fn], tool_choice: choice }).tool_choice).toEqual(choice);
  });
  test.each([
    { tool_choice: "required", tools: [] },
    { tool_choice: { type: "web_search" }, tools: [{ type: "web_search", external_web_access: false }] },
    { tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] }, tools: [{ type: "web_search", external_web_access: false }] },
  ])("omits selectors normalized to none after the last tool is removed %#", extra => {
    expect(wire(extra)).not.toHaveProperty("tool_choice");
  });
  test("keeps auto for additional_tools declarations", () => {
    const result = wire({ tool_choice: "auto", input: [{ type: "additional_tools", tools: [fn] }, { role: "user", content: "OK" }] });
    expect(result.tool_choice).toBe("auto");
  });
  test("rejects a non-array tools field before the adapter runs", () => {
    expect(() => parseRequest({ model: "grok-4.6", input: [{ role: "user", content: "OK" }], tools: null, tool_choice: "auto" })).toThrow(/expected array/);
  });
  test("does not alter another destination", () => {
    expect(wire({ tools: [], tool_choice: "auto" }, { ...xai, baseUrl: "https://example.test/v1" }).tool_choice).toBe("auto");
  });
  test("also repairs the public xAI Responses destination", () => {
    expect(wire({ tools: [], tool_choice: "auto" }, { ...xai, baseUrl: "https://api.x.ai/v1" })).not.toHaveProperty("tool_choice");
  });
});


describe("xAI custom_tool_call id repair", () => {
  const xai = { adapter: "openai-responses", baseUrl: XAI_GROK_CLI_BASE_URL, authMode: "key" as const };
  const openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
  const wire = (destination: typeof xai, extra: Record<string, unknown>) => {
    const body = { model: "grok-4.6", input: extra.input, ...(extra.store !== undefined ? { store: extra.store } : {}) };
    const before = JSON.stringify(body);
    const result = JSON.parse(createResponsesPassthroughAdapter(destination).buildRequest(parseRequest(body)).body);
    expect(JSON.stringify(body)).toBe(before);
    return result;
  };
  test("repairs a missing custom_tool_call id to a stable ctc_ digest", () => {
    const item = { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "pwd" };
    const result = wire(xai, { input: [item] });
    expect(result.input[0].id).toMatch(/^ctc_[0-9a-f]{40}$/);
    expect(result.input[0]).toMatchObject(item);
    expect(wire(xai, { input: [item] }).input[0].id).toBe(result.input[0].id);
  });
  test("repair distinguishes every field, including embedded NUL delimiters", () => {
    const item = { type: "custom_tool_call", call_id: "a", name: "b", input: "c" };
    const variants = [item, { ...item, call_id: "changed" }, { ...item, name: "changed" }, { ...item, input: "changed" },
      { ...item, call_id: "a\u0000b", name: "c", input: "d" },
      { ...item, call_id: "a", name: "b\u0000c", input: "d" }];
    const ids = variants.map(call => wire(xai, { input: [call] }).input[0].id);
    expect(new Set(ids).size).toBe(variants.length);
  });
  test.each(["", "fc_wrong", null, 42])("repairs an invalid id without changing call pairing %#", id => {
    const item = { type: "custom_tool_call", id, call_id: "pair", name: "exec", input: "" };
    const result = wire(xai, { store: false, input: [item] });
    expect(result.input[0].id).toMatch(/^ctc_[0-9a-f]{40}$/);
    expect(result.input[0].call_id).toBe("pair");
    expect(result.input[0].input).toBe("");
  });
  test("keeps a valid ctc_ custom_tool_call id", () => {
    const item = { type: "custom_tool_call", id: "ctc_keep_me", call_id: "call_2", name: "exec", input: "pwd" };
    expect(wire(xai, { input: [item] }).input[0].id).toBe("ctc_keep_me");
  });
  test.each([
    { call_id: 1, name: "exec", input: "pwd" },
    { call_id: "call_3", name: 2, input: "pwd" },
    { call_id: "call_4", name: "exec", input: { cmd: "pwd" } },
    { name: "exec", input: "pwd" },
    { call_id: "call_5", input: "pwd" },
    { call_id: "call_6", name: "exec" },
  ])("leaves incomplete custom_tool_call fields without inventing an id %#", incomplete => {
    const result = wire(xai, { input: [{ type: "custom_tool_call", ...incomplete }] });
    expect(result.input[0]).not.toHaveProperty("id");
  });
  test("does not invent a custom_tool_call id for a non-xAI destination", () => {
    const item = { type: "custom_tool_call", call_id: "call_7", name: "exec", input: "pwd" };
    expect(wire({ ...xai, baseUrl: "https://example.test/v1" }, { input: [item] }).input[0]).not.toHaveProperty("id");
  });
  test("OpenAI store:false still strips item ids including custom_tool_call", () => {
    const result = wire(openai, {
      store: false,
      input: [
        { type: "custom_tool_call", id: "ctc_old", call_id: "call_8", name: "exec", input: "pwd" },
        { type: "message", id: "msg_abc", role: "assistant", content: "hello" },
      ],
    });
    result.input.forEach((item: Record<string, unknown>) => expect(item).not.toHaveProperty("id"));
    expect(result.input[0].call_id).toBe("call_8");
  });
});
