import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { handleResponsesCompact } from "../../src/server/responses";
import type { OcxProviderConfig } from "../../src/types";
import { drainCompactionResponseState, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let home: string;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-item-extensions-compact-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(async () => {
  try {
    await drainCompactionResponseState();
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    await removeCompactionFixture(home);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

describe("native compact item extensions (#7111)", () => {
  const providers: Array<[string, OcxProviderConfig]> = [
    ["openai", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" }],
    ["openai-apikey", { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "synthetic-test-key" }],
  ];

  for (const [name, provider] of providers) {
    test(`strips Google replay metadata and repairs citations on the direct ${name} compact send`, async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const mockFetch = (async (input, init) => {
        const req = new Request(input, init);
        calls.push({ url: req.url, body: await req.json() as Record<string, unknown> });
        return Response.json({ output: [{ type: "compaction", encrypted_content: "synthetic-compact-result" }] });
      }) as typeof fetch;
      globalThis.fetch = mockFetch;
      const config = {
        ...getDefaultConfig(), defaultProvider: name,
        providers: { [name]: { ...provider, fetch: mockFetch, upstreamWebsocket: false } },
      };
      const call = { type: "function_call", call_id: "call_probe", name: "probe", arguments: '{"value":1}' };
      const output = { type: "function_call_output", call_id: "call_probe", output: '{"extra_content":"tool data"}' };
      const citation = { type: "url_citation", url: "https://source.example/reference", start_index: "3", end_index: -1, extra: "keep" };
      const assistant = { type: "message", role: "assistant", content: [
        { type: "output_text", text: "Fixture answer.", annotations: [citation] },
      ] };
      const body = {
        model: `${name}/gpt-6-sol`,
        input: [
          { role: "user", content: "Compact the completed tool call." },
          { ...call, extra_content: { google: { thought_signature: "synthetic-signature-7111" } } },
          output,
          assistant,
        ],
      };
      const before = structuredClone(body);
      const req = new Request("http://localhost/v1/responses/compact", {
        method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "fixture-account" })}` },
      });
      const response = await handleResponsesCompact(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${provider.baseUrl}/responses/compact`);
      expect(calls[0]!.body.input).toEqual([body.input[0], call, output, {
        ...assistant, content: [{ ...assistant.content[0], annotations: [
          { ...citation, title: citation.url, start_index: 3, end_index: 0 },
        ] }],
      }]);
      expect(body).toEqual(before);
    });
  }
});
