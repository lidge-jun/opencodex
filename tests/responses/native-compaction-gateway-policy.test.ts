import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, compactionRequest, completedPayload, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const metadataKey = "internal_chat_message_metadata_passthrough";
const message = { type: "message", role: "user", content: [{ type: "input_text", text: "Retain the policy fixture task." }] };
const compactItem = { type: "compaction", encrypted_content: "policy-native-blob-fixture" };
const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "Policy summary fixture." }], content: null };
const rows = (["ordinary", "native", "portable"] as const).flatMap(path =>
  (["key", "forward"] as const).flatMap(authMode =>
    [undefined, false, true].map(flag => ({ path, authMode, flag }))));

function rejectsStrictPlaintextReplay(items: Record<string, unknown>[]): boolean {
  return items.some(item => item.type === "reasoning" && (
    "encrypted_content" in item || !Array.isArray(item.content)
    || !item.content.some(part => part.type === "reasoning_text" && typeof part.text === "string" && part.text.length > 0)
  ));
}

describe("native compact gateway serialization policy", () => {
  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-compact-policy-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    release?.();
    globalThis.fetch = originalFetch;
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  async function send(
    row: typeof rows[number], input: unknown[], policy: Partial<OcxProviderConfig>,
    rejects: (items: Record<string, unknown>[]) => boolean,
  ) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (rejects(body.input)) return Response.json({ error: { message: "Strict gateway policy fixture rejected input." } }, { status: 400 });
      return String(url).endsWith("/compact")
        ? Response.json({ object: "response.compaction", output: [compactItem] })
        : Response.json(completedPayload("Retained policy summary fixture."));
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-responses", baseUrl: "https://gateway.example/v1", apiKey: "policy-key-fixture",
      authMode: row.authMode, supportsNativeCompactEndpoint: row.path === "native",
      // A v2 opt-in must not prevent the v1 portable fallback from exercising ordinary serialization.
      supportsNativeCompactionTrigger: true, ...policy,
    };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const raw = baseCompactionBody({ input });
    const rawBefore = JSON.stringify(raw);
    const request = compactionRequest(raw, undefined, { authorization: "Bearer caller-fixture" });
    const response = await (row.path === "ordinary" ? handleResponses : handleResponsesCompact)(request, config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(row.path === "native" ? "/v1/responses/compact" : "/v1/responses");
    expect(JSON.stringify(raw)).toBe(rawBefore);
    return calls[0]!.body.input as Record<string, unknown>[];
  }

  test.each(rows)("message metadata policy: $path $authMode $flag", async row => {
    const metadata = { fixture_turn: "private-policy-fixture" };
    const items = await send(row, [{ ...message, [metadataKey]: metadata }],
      row.flag === undefined ? {} : { preserveResponsesMessageMetadata: row.flag },
      input => row.flag !== true && input.some(item => metadataKey in item));
    expect(items[0]).toEqual(row.flag === true ? { ...message, [metadataKey]: metadata } : message);
  });

  test.each(rows)("reasoning drop policy: $path $authMode $flag", async row => {
    const inputReasoning = { ...reasoning, content: [{ type: "reasoning_text", text: "Plaintext replay fixture." }], encrypted_content: "ocxr1:policy-signature-fixture" };
    const items = await send(row, [message, inputReasoning], {
      preserveResponsesReasoningContent: true, decodesNativeCompactionBlobs: true,
      ...(row.flag === undefined ? {} : { dropResponsesReasoningItems: row.flag }),
    }, input => row.flag === true && input.some(item => item.type === "reasoning"));
    expect(items[0]).toEqual(message);
    expect(items.filter(item => item.type === "reasoning")).toEqual(row.flag === true ? [] : [{
      type: "reasoning", summary: reasoning.summary, content: inputReasoning.content,
    }]);
  });

  test.each(rows)("null channel independent of plaintext preservation: $path $authMode $flag", async row => {
    const items = await send(row, [message, reasoning, { ...reasoning, encrypted_content: "native-reasoning-policy-fixture" }, {
      ...reasoning, encrypted_content: "ocxr1:policy-signature-fixture",
    }], {
      decodesNativeCompactionBlobs: true,
      ...(row.flag === undefined ? {} : { preserveResponsesReasoningContent: row.flag }),
    }, input => input.some(item => item.type === "reasoning" && "content" in item && !Array.isArray(item.content)));
    expect(items.filter(item => item.type === "reasoning")).toEqual([
      { type: "reasoning", summary: reasoning.summary },
      { type: "reasoning", summary: reasoning.summary, encrypted_content: "native-reasoning-policy-fixture" },
      { type: "reasoning", summary: reasoning.summary },
    ]);
  });

  test.each(rows)("strict plaintext replay policy: $path $authMode $flag", async row => {
    const plaintext = [{ type: "reasoning_text", text: "Existing plaintext fixture." }];
    const input = [message,
      { ...reasoning, encrypted_content: "opaque-replay-fixture", status: "completed" },
      { type: "reasoning", summary: [], content: [], encrypted_content: "opaque-empty-fixture" },
      { ...reasoning, content: plaintext, encrypted_content: "opaque-plaintext-fixture" },
    ];
    const strict = row.flag === true;
    const items = await send(row, input, {
      requiresAdjacentResponsesToolResults: true,
      ...(row.flag === undefined ? {} : { preserveResponsesReasoningContent: row.flag }),
    }, items => strict && rejectsStrictPlaintextReplay(items));
    // Explicit wire expectations also pin ordinary and portable serialization to the native path.
    expect(items[0]).toEqual(message);
    expect(items.filter(item => item.type === "reasoning")).toEqual([
      { type: "reasoning", summary: reasoning.summary, ...(strict
        ? { content: [{ type: "reasoning_text", text: "Policy summary fixture." }] }
        : { encrypted_content: "opaque-replay-fixture" }) },
      { type: "reasoning", summary: [], content: strict ? [{ type: "reasoning_text", text: " " }] : [],
        ...(!strict ? { encrypted_content: "opaque-empty-fixture" } : {}) },
      { type: "reasoning", summary: reasoning.summary, content: strict ? plaintext : [],
        ...(!strict ? { encrypted_content: "opaque-plaintext-fixture" } : {}) },
    ]);
  });

  test.each((["key", "forward"] as const).flatMap(authMode =>
    [undefined, false].map(adjacency => ({ authMode, adjacency }))))(
    "plaintext preservation alone does not require plaintext replay: $authMode $adjacency", async row => {
      const input = [{ ...reasoning, encrypted_content: "preservation-only-fixture" }];
      const items = await send({ path: "native", flag: true, authMode: row.authMode }, input, {
        preserveResponsesReasoningContent: true,
        ...(row.adjacency === undefined ? {} : { requiresAdjacentResponsesToolResults: row.adjacency }),
      }, () => false);
      expect(items).toEqual([{ type: "reasoning", summary: reasoning.summary, encrypted_content: "preservation-only-fixture" }]);
    });

  test.each(["metadata", "null", "reasoning", "plaintext"])("strict gateway counterfactual rejects unsanitized %s", async defect => {
    const input = defect === "metadata" ? [{ ...message, [metadataKey]: { fixture_turn: "private" } }]
      : defect === "null" ? [reasoning] : defect === "plaintext"
        ? [{ ...reasoning, content: [{ type: "reasoning_text", text: "Valid text with ciphertext fixture." }],
          encrypted_content: "opaque-replay-fixture" }] : [{ type: "reasoning", summary: [] }];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const rejected = defect === "plaintext" ? rejectsStrictPlaintextReplay(body.input)
        : body.input.some((item: Record<string, unknown>) => defect === "metadata" ? metadataKey in item
          : defect === "null" ? item.content === null : item.type === "reasoning");
      return Response.json({}, { status: rejected ? 400 : 200 });
    }) as typeof fetch;
    const response = await fetch("https://gateway.example/v1/responses/compact", {
      method: "POST", body: JSON.stringify(baseCompactionBody({ input })),
    });
    expect(response.status).toBe(400);
    await response.text();
  });

  test.each([
    { label: "canonical", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
    { label: "official API", baseUrl: "https://api.openai.com/v1", authMode: "key" as const },
  ])("strict custom replay flags do not change OpenAI compact policy: $label", async row => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ object: "response.compaction", output: [compactItem] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-responses", ...row, apiKey: "canonical-key-fixture", supportsNativeCompactEndpoint: true,
      preserveResponsesReasoningContent: true, requiresAdjacentResponsesToolResults: true,
    };
    const input = [{ ...reasoning, content: [{ type: "reasoning_text", text: "OpenAI plaintext fixture." }],
      encrypted_content: "canonical-reasoning-policy-fixture" }];
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ input }), undefined, {
      authorization: "Bearer caller-fixture",
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(sent.input).toEqual([{ type: "reasoning", summary: reasoning.summary, content: [],
      encrypted_content: "canonical-reasoning-policy-fixture" }]);
  });

  test.each([
    { label: "canonical", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
    { label: "official API", baseUrl: "https://api.openai.com/v1", authMode: "key" as const },
  ].flatMap(destination => [undefined, false, true].map(flag => ({ ...destination, flag }))))(
    "OpenAI compact retains existing metadata and null channel policy: $label $flag", async row => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ object: "response.compaction", output: [compactItem] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-responses", baseUrl: row.baseUrl, authMode: row.authMode, apiKey: "canonical-key-fixture",
      supportsNativeCompactEndpoint: true,
      ...(row.flag === undefined ? {} : {
        preserveResponsesMessageMetadata: row.flag, preserveResponsesReasoningContent: row.flag, dropResponsesReasoningItems: row.flag,
      }),
    };
    const input = [{ ...message, [metadataKey]: { fixture_turn: "canonical" } }, {
      ...reasoning, encrypted_content: "canonical-reasoning-policy-fixture",
    }];
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ input }), undefined, {
      authorization: "Bearer caller-fixture",
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(sent.input).toEqual(input);
  });
});
