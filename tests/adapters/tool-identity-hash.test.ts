import { describe, expect, test } from "bun:test";
import { compileGoogleWireBody } from "../../src/adapters/google-wire-compiler";
import { createKiroToolNameRegistry, kiroToolName } from "../../src/adapters/kiro-wire";
import { anthropicToolCallId, createToolCallIdAllocator } from "../../src/adapters/tool-call-id";
import { buildMuseToolNameAliasPlan, museWireToolName } from "../../src/responses/muse-tool-name-alias";

// Known SHA-256 prefixes computed independently with Python hashlib over UTF-8 bytes.
// Lone UTF-16 surrogates encode as U+FFFD, matching the existing Node crypto wire contract.
const vectors = [
  { label: "ASCII punctuation", raw: "call:a", wire: "call_a_be20a31b" },
  { label: "a distinct raw name with the same cleaned prefix", raw: "call/a", wire: "call_a_027f8418" },
  { label: "Korean and an astral character", raw: "도구/검색:🙂", wire: "_________f9ff201c" },
  { label: "Latin-1", raw: "café.tool", wire: "caf__tool_462bebdb" },
  { label: "an embedded NUL", raw: "a\u0000b", wire: "a_b_59b271ae" },
  { label: "a lone high surrogate", raw: "\ud800", wire: "__83d544cc" },
  { label: "a lone low surrogate", raw: "\udfff", wire: "__83d544cc" },
  { label: "consecutive lone surrogates", raw: "\ud800\ud800", wire: "___52793f8d" },
  { label: "a name exceeding the wire limit", raw: "x".repeat(65), wire: "x".repeat(55) + "_9537c5fd" },
];

describe("tool identity hash compatibility", () => {
  for (const { label, raw, wire } of vectors) {
    test(`preserves exact wire bytes for ${label}`, () => {
      expect(anthropicToolCallId(raw)).toBe(wire);
      expect(kiroToolName(raw)).toBe(wire);
      expect(museWireToolName(raw)).toBe(wire);

      const compiled = compileGoogleWireBody({
        tools: [{ functionDeclarations: [{ name: raw }] }],
        contents: [
          { role: "model", parts: [{ functionCall: { name: raw, args: {} } }] },
          { role: "user", parts: [{ functionResponse: { name: raw, response: {} } }] },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [raw] } },
      });
      expect(compiled.body.tools).toEqual([{ functionDeclarations: [{
        name: wire,
        parameters: { type: "object", properties: {} },
      }] }]);
      expect(compiled.body.contents).toEqual([
        { role: "model", parts: [{ functionCall: { name: wire, args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: wire, response: {} } }] },
      ]);
      expect(compiled.body.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [wire] },
      });
      expect(compiled.restoreToolName(wire)).toBe(raw);
    });
  }

  test("preserves Google's leading-character rule around the same digest", () => {
    const raw = "9 bad.tool";
    expect(anthropicToolCallId(raw)).toBe("9_bad_tool_66643991");
    expect(kiroToolName(raw)).toBe("9_bad_tool_66643991");
    expect(museWireToolName(raw)).toBe("9_bad_tool_66643991");
    const compiled = compileGoogleWireBody({ tools: [{ functionDeclarations: [{ name: raw }] }] });
    expect(compiled.body.tools).toEqual([{ functionDeclarations: [{
      name: "_9_bad_tool_66643991",
      parameters: { type: "object", properties: {} },
    }] }]);
    expect(compiled.restoreToolName("_9_bad_tool_66643991")).toBe(raw);
  });

  test("keeps Anthropic numeric collision suffixes and call/result lookup stable", () => {
    const allocator = createToolCallIdAllocator();
    allocator.reserve("call_a_be20a31b");
    expect(allocator.allocate("call:a")).toBe("call_a_be20a31b_2");
    expect(allocator.allocate("call_a_be20a31b")).toBe("call_a_be20a31b");
    expect(allocator.lookup("call:a")).toBe("call_a_be20a31b_2");
  });

  test("keeps Kiro salted aliases and restoration stable", () => {
    const registry = createKiroToolNameRegistry();
    expect(registry.alias("call_a_be20a31b")).toBe("call_a_be20a31b");
    expect(registry.alias("call_a_32b5a4fa")).toBe("call_a_32b5a4fa");
    expect(registry.alias("call:a")).toBe("call_a_f24c9592");
    expect(registry.alias("call:a")).toBe("call_a_f24c9592");
    expect(registry.restore("call_a_f24c9592")).toBe("call:a");
  });

  test("keeps Muse's two-phase reservation and salted aliases stable", () => {
    const plan = buildMuseToolNameAliasPlan(["call:a", "call_a_be20a31b", "call_a_32b5a4fa"]);
    expect(plan.wireByOriginal.get("call_a_be20a31b")).toBe("call_a_be20a31b");
    expect(plan.wireByOriginal.get("call_a_32b5a4fa")).toBe("call_a_32b5a4fa");
    expect(plan.wireByOriginal.get("call:a")).toBe("call_a_f24c9592");
    expect(plan.aliases.get("call_a_f24c9592")).toBe("call:a");
  });

  test("keeps Google salted aliases and restoration stable", () => {
    const names = ["call_a_be20a31b", "call_a_32b5a4fa", "call:a"];
    const compiled = compileGoogleWireBody({
      tools: [{ functionDeclarations: names.map(name => ({ name })) }],
    });
    expect(compiled.body.tools).toEqual([{ functionDeclarations: [
      { name: "call_a_be20a31b", parameters: { type: "object", properties: {} } },
      { name: "call_a_32b5a4fa", parameters: { type: "object", properties: {} } },
      { name: "call_a_f24c9592", parameters: { type: "object", properties: {} } },
    ] }]);
    expect(compiled.restoreToolName("call_a_f24c9592")).toBe("call:a");
  });

  test("keeps distinct UTF-16 names separate when their UTF-8 digests are identical", () => {
    const names = ["call:\ud800", "call:\udc00", "call:\ufffd"];
    const anthropicNames = ["call___3ef21366", "call___3ef21366_2", "call___3ef21366_3"];
    const saltedNames = ["call___3ef21366", "call___627a426b", "call___75abc529"];
    const allocator = createToolCallIdAllocator();
    const kiro = createKiroToolNameRegistry();
    const muse = buildMuseToolNameAliasPlan(names);
    const google = compileGoogleWireBody({
      tools: [{ functionDeclarations: names.map(name => ({ name })) }],
    });
    expect(google.body.tools).toEqual([{ functionDeclarations: saltedNames.map(name => ({
      name,
      parameters: { type: "object", properties: {} },
    })) }]);
    for (const [index, name] of names.entries()) {
      expect(allocator.allocate(name)).toBe(anthropicNames[index]);
      expect(allocator.lookup(name)).toBe(anthropicNames[index]);
      expect(kiro.alias(name)).toBe(saltedNames[index]);
      expect(kiro.restore(saltedNames[index])).toBe(name);
      expect(muse.wireByOriginal.get(name)).toBe(saltedNames[index]);
      expect(muse.aliases.get(saltedNames[index])).toBe(name);
      expect(google.restoreToolName(saltedNames[index])).toBe(name);
    }
  });
});
