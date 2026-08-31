import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGuardrailsRegistry } from "../src/guardrails/registry";
import { maskAnthropicRequestFields } from "../src/guardrails/fields/anthropic";
import { maskChatRequestFields } from "../src/guardrails/fields/chat";
import {
  maskResponsesRequestFields,
  RESPONSES_GUARDRAILS_ITEM_POLICY,
} from "../src/guardrails/fields/responses";
import { GuardrailsScanCapacityError } from "../src/guardrails/scanner";

function registry() {
  return createGuardrailsRegistry({
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
  });
}

test("Responses parser item kinds have an explicit Guardrails scan-or-skip policy", () => {
  const parser = readFileSync(resolve(import.meta.dir, "../src/responses/parser.ts"), "utf8");
  const compaction = readFileSync(resolve(import.meta.dir, "../src/responses/compaction.ts"), "utf8");
  const compactionTypes = compaction.match(
    /const COMPACTION_ITEM_TYPES:[\s\S]+?new Set\(\[([\s\S]+?)\]\);/,
  )?.[1];
  expect(compactionTypes).toBeDefined();
  const parserKinds = [
    ...parser.matchAll(/effectiveType === "([a-z_]+)"/g),
    ...(compactionTypes?.matchAll(/"([a-z_]+)"/g) ?? []),
  ]
    .map(match => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  expect(parserKinds).toEqual(Object.keys(RESPONSES_GUARDRAILS_ITEM_POLICY).sort());
  expect(RESPONSES_GUARDRAILS_ITEM_POLICY).toMatchObject({
    message: "scan",
    function_call_output: "scan",
    compaction: "scan_local_envelope",
    reasoning: "skip",
    tool_search_output: "skip",
  });
});

test("Responses walker masks allowlisted text fields and preserves opaque payloads", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const body = {
    instructions: `use ${value}`,
    input: [{
      type: "message",
      content: [
        { type: "input_text", text: value },
        { type: "input_image", image_url: `data:image/png;base64,${value}` },
      ],
    }, {
      type: "function_call",
      arguments: `{"token":"${value}"}`,
    }],
  };

  const result = maskResponsesRequestFields(body, registry());

  expect(result.body.instructions).toContain("<STRIPE_");
  expect((result.body.input[0] as { content: Array<{ text?: string; image_url?: string }> }).content[0]?.text).toContain("<STRIPE_");
  expect((result.body.input[0] as { content: Array<{ text?: string; image_url?: string }> }).content[1]?.image_url).toBe(`data:image/png;base64,${value}`);
  expect((result.body.input[1] as { arguments: string }).arguments).toContain("<STRIPE_");
  expect(result.state.replacements).toHaveLength(1);
});

test("Responses walker protects model-visible filenames without scanning opaque file ids or bytes", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const fileData = `data:application/pdf;base64,${value}`;
  const body = {
    input: [{
      type: "message",
      content: [
        { type: "input_file", file_id: value, filename: "ignored.pdf" },
        { type: "input_file", filename: value, file_data: fileData },
        { type: "input_file", filename: value },
      ],
    }],
  };

  const result = maskResponsesRequestFields(body, registry());
  const content = result.body.input[0]?.content;
  expect(content[0]?.file_id).toBe(value);
  expect(content[0]?.filename).toBe("ignored.pdf");
  expect(content[1]?.filename).toContain("<STRIPE_");
  expect(content[1]?.file_data).toBe(fileData);
  expect(content[2]?.filename).toContain("<STRIPE_");
});

test("Responses walker covers parser-consumed tool search, shell, and array output fields", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const body = {
    input: [
      { type: "tool_search_call", arguments: { query: value } },
      { type: "local_shell_call", action: { command: ["echo", value] } },
      { type: "function_call_output", output: [{ type: "input_text", text: value }] },
      { type: "custom_tool_call_output", output: [value] },
      {
        type: "function_call_output",
        output: [{ result: { credentials: { token: value } } }],
      },
      {
        type: "function_call_output",
        output: [{ type: "input_image", image_url: `data:image/png;base64,${value}` }],
      },
    ],
  };

  const result = maskResponsesRequestFields(body, registry());
  const input = result.body.input;
  expect((input[0] as { arguments: { query: string } }).arguments.query).toContain("<STRIPE_");
  expect((input[1] as { action: { command: string[] } }).action.command[1]).toContain("<STRIPE_");
  expect(((input[2] as { output: Array<{ text: string }> }).output[0]?.text)).toContain("<STRIPE_");
  expect(((input[3] as { output: string[] }).output[0])).toContain("<STRIPE_");
  expect(((input[4] as {
    output: Array<{ result: { credentials: { token: string } } }>;
  }).output[0]?.result.credentials.token)).toContain("<STRIPE_");
  expect(((input[5] as {
    output: Array<{ image_url: string }>;
  }).output[0]?.image_url)).toBe(`data:image/png;base64,${value}`);
});

test("Responses walker scans deep tool_search arguments and fails closed beyond the shared capacity", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  let deep: unknown = value;
  for (let index = 0; index < 17; index += 1) deep = { nested: deep };
  const masked = maskResponsesRequestFields({ input: [{ type: "tool_search_call", arguments: deep }] }, registry());
  let cursor: unknown = (masked.body.input[0] as { arguments: unknown }).arguments;
  for (let index = 0; index < 17; index += 1) cursor = (cursor as { nested: unknown }).nested;
  expect(cursor).toContain("<STRIPE_");

  let overLimit: unknown = value;
  for (let index = 0; index < 66; index += 1) overLimit = { nested: overLimit };
  expect(() => maskResponsesRequestFields({ input: [{ type: "tool_search_call", arguments: overLimit }] }, registry()))
    .toThrow(GuardrailsScanCapacityError);
});

test("Responses walker rejects oversized semantic text before cloning opaque request fields", () => {
  const body = {
    input: "x".repeat(2 * 1024 * 1024 + 1),
    opaque: () => "not structured-cloneable",
  };

  expect(() => maskResponsesRequestFields(body, registry()))
    .toThrow(GuardrailsScanCapacityError);
});

test("Responses walker shares one traversal budget across nested roots", () => {
  const first = Array.from({ length: 50_001 }, () => null);
  const second = Array.from({ length: 50_001 }, () => null);

  expect(() => maskResponsesRequestFields({
    input: [
      { type: "tool_search_call", arguments: first },
      { type: "tool_search_call", arguments: second },
    ],
  }, registry())).toThrow(GuardrailsScanCapacityError);
});

test("Responses walker counts top-level protocol collections before structured cloning", () => {
  const input = Array.from({ length: 100_001 }, () => ({ type: "reasoning" }));

  expect(() => maskResponsesRequestFields({ input }, registry()))
    .toThrow("Guardrails logical request contains too many protocol nodes");
});

test("Chat walker masks legacy arguments before translation and leaves names untouched", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const body = {
    model: value,
    messages: [{ role: "user", content: value, tool_calls: [{ function: { name: value, arguments: `{"key":"${value}"}` } }] }],
  };

  const result = maskChatRequestFields(body, registry());

  expect(result.body.model).toBe(value);
  expect(result.body.messages[0]?.content).toContain("<STRIPE_");
  expect(result.body.messages[0]?.tool_calls?.[0]?.function.name).toBe(value);
  expect(result.body.messages[0]?.tool_calls?.[0]?.function.arguments).toContain("<STRIPE_");
});

test("Anthropic walker masks text and tool input leaves without changing image source payload", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const body = {
    system: value,
    messages: [{ role: "user", content: [
      { type: "text", text: value },
      { type: "tool_use", input: { token: value, nested: [value] } },
      { type: "image", source: { type: "base64", data: value } },
      { type: "document", title: value, source: { type: "text", data: value } },
      { type: "document", source: { type: "content", content: value } },
      { type: "document", source: { type: "content", content: [{ type: "text", text: value }] } },
      { type: "document", source: { type: "base64", data: value } },
      { type: "document", source: { type: "url", url: value } },
    ] }],
  };

  const result = maskAnthropicRequestFields(body, registry());
  const blocks = result.body.messages[0]?.content as Array<Record<string, unknown>>;

  expect(result.body.system).toContain("<STRIPE_");
  expect(blocks[0]?.text).toContain("<STRIPE_");
  expect((blocks[1]?.input as { token: string }).token).toContain("<STRIPE_");
  expect((blocks[2]?.source as { data: string }).data).toBe(value);
  expect(blocks[3]?.title).toContain("<STRIPE_");
  expect((blocks[3]?.source as { data: string }).data).toContain("<STRIPE_");
  expect((blocks[4]?.source as { content: string }).content).toContain("<STRIPE_");
  expect((blocks[5]?.source as { content: Array<{ text: string }> }).content[0]?.text).toContain("<STRIPE_");
  expect((blocks[6]?.source as { data: string }).data).toBe(value);
  expect((blocks[7]?.source as { url: string }).url).toBe(value);
});

test("Anthropic routed policy scans document titles but skips untranslated sources", () => {
  const value = "sk_live_abcdefghijklmnopqrstuvwx";
  const body = {
    messages: [{
      role: "user",
      content: [{
        type: "document",
        title: value,
        source: { type: "content", content: [{ type: "text", text: value }] },
      }],
    }],
  };

  const result = maskAnthropicRequestFields(
    body,
    registry(),
    undefined,
    undefined,
    { scanDocumentSources: false },
  );
  const document = result.body.messages[0]?.content[0];

  expect(document.title).toContain("<STRIPE_");
  expect(document.source.content[0]?.text).toBe(value);
  expect(result.findings).toHaveLength(1);
});

test("Responses structured arguments use property context but replace only the original value", () => {
  const value = "syn-api:alpha+beta/42=";
  const revision = `${"0123456789abcdef".repeat(2)}01234567`;
  const body = {
    input: [{
      type: "function_call",
      arguments: {
        SERVICE_API_KEY: value,
        TOKEN_PERSISTENT_MODE: "enabled",
        PUBLIC_KEY: "public-material",
        SSH_FINGERPRINT: "SHA256:public-fixture",
        SOURCE_REVISION: revision,
      },
    }],
  };

  const result = maskResponsesRequestFields(body, registry());
  const argumentsBody = result.body.input[0]?.arguments;

  expect(argumentsBody.SERVICE_API_KEY).toBe("<OPENCODEX_API_KEY_1>");
  expect(argumentsBody.TOKEN_PERSISTENT_MODE).toBe("enabled");
  expect(argumentsBody.PUBLIC_KEY).toBe("public-material");
  expect(argumentsBody.SSH_FINGERPRINT).toBe("SHA256:public-fixture");
  expect(result.findings.filter(finding => finding.ruleId.startsWith("opencodex."))).toEqual([
    expect.objectContaining({
      ruleId: "opencodex.api-keys.assignment",
      start: 0,
      end: value.length,
      value,
    }),
  ]);
  expect(result.state.replacements).toEqual(expect.arrayContaining([
    expect.objectContaining({
      original: value,
      placeholder: "<OPENCODEX_API_KEY_1>",
    }),
  ]));
});

test("Chat and Anthropic structured secret properties preserve exact value-local mappings", () => {
  const password = "Synthetic Chat Password 42!";
  const privateKey = `${"Ab9+".repeat(10)}Ab9=`;
  const chat = maskChatRequestFields({
    messages: [{
      role: "user",
      tool_calls: [{
        function: {
          name: "synthetic_tool",
          arguments: { dbPassword: password },
        },
      }],
    }],
  }, registry());
  const anthropic = maskAnthropicRequestFields({
    messages: [{
      role: "user",
      content: [{
        type: "tool_use",
        name: "synthetic_tool",
        input: { VpnPrivateKey: privateKey },
      }],
    }],
  }, registry());

  expect(chat.body.messages[0]?.tool_calls[0]?.function.arguments.dbPassword)
    .toBe("<OPENCODEX_PASSWORD_1>");
  expect(chat.findings).toEqual([
    expect.objectContaining({ start: 0, end: password.length, value: password }),
  ]);
  expect(chat.state.replacements[0]?.original).toBe(password);

  const content = anthropic.body.messages[0]?.content as Array<{
    input: { VpnPrivateKey: string };
  }>;
  expect(content[0]?.input.VpnPrivateKey).toBe("<OPENCODEX_PRIVATE_KEY_1>");
  expect(anthropic.findings).toEqual([
    expect.objectContaining({ start: 0, end: privateKey.length, value: privateKey }),
  ]);
  expect(anthropic.state.replacements[0]?.original).toBe(privateKey);
});

test("structured assignment context promotes a fallback prefix match to the complete value", () => {
  const value = `Synthetic\\Prefix with "double" and 'single' quotes`;
  const result = maskResponsesRequestFields({
    input: [{
      type: "function_call",
      arguments: { serviceApiKey: value },
    }],
  }, registry());

  expect(result.body.input[0]?.arguments.serviceApiKey).toBe("<OPENCODEX_API_KEY_1>");
  expect(result.findings).toEqual([
    expect.objectContaining({
      ruleId: "opencodex.api-keys.assignment",
      start: 0,
      end: value.length,
      value,
    }),
  ]);
  expect(result.state.replacements[0]?.original).toBe(value);
});

test("structured property context disambiguates a value that repeats its property name", () => {
  const value = "password";
  const result = maskResponsesRequestFields({
    input: [{
      type: "function_call",
      arguments: { password: value },
    }],
  }, registry());

  expect(result.body.input[0]?.arguments.password).toBe("<OPENCODEX_PASSWORD_1>");
  expect(result.findings).toEqual([
    expect.objectContaining({ start: 0, end: value.length, value }),
  ]);
});

test("structured property context normalizes dotted names and inherits plural array labels", () => {
  const dottedValue = "SyntheticDottedApiKey42";
  const arrayValue = "SyntheticArrayApiKey42";
  const result = maskResponsesRequestFields({
    input: [{
      type: "function_call",
      arguments: {
        "config.serviceApiKey": dottedValue,
        API_KEYS: [arrayValue],
      },
    }],
  }, registry());

  expect(result.body.input[0]?.arguments["config.serviceApiKey"]).toBe("<OPENCODEX_API_KEY_2>");
  expect(result.body.input[0]?.arguments.API_KEYS).toEqual(["<OPENCODEX_API_KEY_1>"]);
  expect(result.state.replacements.map(replacement => replacement.original).sort())
    .toEqual([arrayValue, dottedValue].sort());
});

test("structured property context is bounded and cannot inject a synthetic assignment", () => {
  const value = "syn-api:alpha+beta/42=";
  const longKey = `${"X".repeat(129)}_API_KEY`;
  const body = {
    input: [{
      type: "function_call",
      arguments: {
        [longKey]: value,
        "ignored\nSERVICE_API_KEY": value,
      },
    }],
  };

  const result = maskResponsesRequestFields(body, registry());
  const argumentsBody = result.body.input[0]?.arguments;
  expect(argumentsBody[longKey]).toBe(value);
  expect(argumentsBody["ignored\nSERVICE_API_KEY"]).toBe(value);
  expect(result.findings).toEqual([]);
  expect(result.state.replacements).toEqual([]);
});

test("structured property-aware masking honors supplemental rule toggles", () => {
  const value = "syn-api:alpha+beta/42=";
  const disabled = createGuardrailsRegistry({
    disabledBuiltinRuleIds: ["opencodex.api-keys.assignment"],
  });
  const body = {
    input: [{
      type: "function_call",
      arguments: { SERVICE_API_KEY: value },
    }],
  };

  const result = maskResponsesRequestFields(body, disabled);
  expect(result.body.input[0]?.arguments.SERVICE_API_KEY).toBe(value);
  expect(result.findings).toEqual([]);
});
