import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCompactionSummary } from "../../src/responses/compaction";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installCompactionHttpMock, installCompactionRoutingAclFixture, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const model = "gemini-3-pro";
const summary = "  Deployment paused. Verify the migration before continuing.";
const tool = { functionCall: { name: "read", args: { path: "fixture.txt" } } };
const thought = { text: "private reasoning is not a handoff", thought: true };
const whitespace = { text: "  \t\n" };
const cases = [
  { name: "empty STOP", parts: [], finishReason: "STOP", status: "failed" },
  { name: "whitespace-only STOP", parts: [whitespace], finishReason: "STOP", status: "failed" },
  { name: "thought-only STOP", parts: [thought], finishReason: "STOP", status: "failed" },
  { name: "tool-only STOP", parts: [tool], finishReason: "STOP", status: "failed" },
  { name: "mixed text, thought, and tool", parts: [thought, tool, { text: "  " }, { text: summary.slice(2) }], finishReason: "STOP", status: "completed" },
  { name: "MAX_TOKENS", parts: [{ text: summary }], finishReason: "MAX_TOKENS", status: "incomplete", reason: "max_output_tokens" },
  { name: "SAFETY", parts: [], finishReason: "SAFETY", status: "incomplete", reason: "content_filter" },
];

describe("Vertex routed compaction summary delivery", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let home: string;
  let releaseSpendHome: () => void;
  installCompactionRoutingAclFixture();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-vertex-compaction-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    try {
      releaseSpendHome();
      await removeCompactionFixture(home);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
    }
  });

  async function send(
    { parts, finishReason }: Pick<(typeof cases)[number], "parts" | "finishReason">,
    format: "sse" | "json" | "compact",
    { mode = "vertex", compact = true, emptyCatalog = false, emergency = false }:
      { mode?: "vertex" | "ai-studio"; compact?: boolean; emptyCatalog?: boolean; emergency?: boolean } = {},
  ) {
    const vertex = mode === "vertex";
    const upstreamOrigin = vertex ? "https://aiplatform.googleapis.com" : "https://generativelanguage.googleapis.com";
    const config = {
      defaultProvider: "fixture",
      // #6881's regular-turn option must not replay a routed compaction.
      emptyCompletionRetry: true,
      ...(emergency ? { compactionRecovery: { enabled: true, model: "emergency/fixture-fallback" } } : {}),
      providers: {
        fixture: {
          adapter: "google", googleMode: mode, baseUrl: upstreamOrigin, authMode: "key",
          apiKey: "synthetic-test-key", models: [model], showThinkingSummary: true,
          reasoningEfforts: ["low", "high"],
          ...(vertex ? { project: "fixture-project", location: "global" } : {}),
        },
        ...(emergency ? {
          emergency: { adapter: "openai-chat", baseUrl: "https://emergency.example.invalid/v1", authMode: "key",
            apiKey: "synthetic-emergency-key", models: ["fixture-fallback"] },
        } : {}),
      },
    } as OcxConfig;
    const stream = format === "sse";
    const v1 = format === "compact";
    const sends: Array<{ url: URL; body: Record<string, unknown> }> = [];
    installCompactionHttpMock(config, (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      sends.push({ url, body: JSON.parse(String(init?.body)) });
      expect(url.origin).toBe(upstreamOrigin);
      const frame = {
        candidates: [{ content: { role: "model", parts }, finishReason }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      };
      return stream
        ? new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(frame);
    }) as typeof fetch);
    const request = new Request(`http://localhost/v1/responses${v1 ? "/compact" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `fixture/${model}`, stream, store: false, reasoning: { effort: "high" },
        tools: emptyCatalog ? [] : [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }],
        input: [{ type: "message", role: "user", content: "fixture context" },
          ...(compact && !v1 ? [{ type: "compaction_trigger" }] : [])],
      }),
    });
    const handler = v1 ? handleResponsesCompact : handleResponses;
    const response = await handler(request, config, { model: "", provider: "" });
    const body = await response.text();
    expect(sends).toHaveLength(1);
    const [sent] = sends;
    expect(sent?.url.pathname).toEndWith(`/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`);
    if (vertex) expect(sent?.url.pathname).toContain("/projects/fixture-project/locations/global/");
    expect(sent?.body.tools === undefined).toBe(compact);
    if (vertex) expect(sent?.body.generationConfig).toHaveProperty("thinkingConfig");
    if (!response.ok || !stream) return { http: response.status, body, json: JSON.parse(body) };
    const frames = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const terminals = frames.filter(event => /^response\.(completed|failed|incomplete)$/.test(event.type));
    expect(terminals).toHaveLength(1);
    return { http: response.status, body, json: terminals[0].response };
  }

  for (const format of ["sse", "json"] as const) {
    for (const row of cases) {
      test(`V2 ${format}: ${row.name}`, async () => {
        const { http, body, json } = await send(row, format);
        expect(http).toBe(200);
        expect(json.status).toBe(row.status);
        expect(json.usage).toMatchObject({ input_tokens: 4, output_tokens: 2, total_tokens: 6 });
        expect(body).not.toContain('"type":"function_call"');
        expect(body).not.toContain(thought.text);
        if (row.status === "completed") {
          expect(json.output).toHaveLength(1);
          expect(json.output[0].type).toBe("compaction");
          expect(decodeCompactionSummary(json.output[0].encrypted_content)).toBe(summary);
        } else {
          expect(body).not.toContain('"type":"compaction"');
          expect(json.output).toEqual([]);
          if (row.status === "failed") expect(json.error).toMatchObject({ code: "compaction_invalid_summary" });
          else expect(json.incomplete_details).toEqual({ reason: row.reason });
        }
      });
    }

    test(`V2 ${format}: mixed output with an explicitly empty client catalog keeps only the summary`, async () => {
      const { json } = await send({ parts: [tool, { text: summary }], finishReason: "STOP" }, format, { emptyCatalog: true });
      expect(json.status).toBe("completed");
      expect(json.output).toHaveLength(1);
      expect(decodeCompactionSummary(json.output[0].encrypted_content)).toBe(summary);
    });

    test(`V2 ${format}: #6881 malformed-call failure keeps its error without a replay`, async () => {
      const { json } = await send({ parts: [], finishReason: "MALFORMED_FUNCTION_CALL" }, format);
      expect(json.status).toBe("failed");
      expect(json.error.message).toContain("MALFORMED_FUNCTION_CALL");
      expect(json.output).toEqual([]);
    });

    test(`V2 ${format}: an empty STOP does not dispatch the configured emergency model`, async () => {
      const { body } = await send({ parts: [], finishReason: "STOP" }, format, { emergency: true });
      expect(body).toContain("compaction_invalid_summary");
      expect(body).not.toContain('"type":"compaction"');
    });

    for (const mode of ["vertex", "ai-studio"] as const) {
      test(`ordinary ${mode} ${format} still delivers client tool calls`, async () => {
        const { http, json } = await send({ parts: [tool], finishReason: "STOP" }, format, { mode, compact: false });
        expect(http).toBe(200);
        expect(json.status).toBe("completed");
        expect(json.output).toContainEqual(expect.objectContaining({ type: "function_call", name: "read" }));
      });
    }
  }

  test("V1 compact rejects an empty summary with HTTP 502", async () => {
    const { http, json } = await send({ parts: [], finishReason: "STOP" }, "compact");
    expect(http).toBe(502);
    expect(json.error).toBeDefined();
    expect(json.output).toBeUndefined();
  });

  test("V1 compact returns plaintext history when visible text accompanies a tool call", async () => {
    const { http, json } = await send({ parts: [tool, { text: summary }], finishReason: "STOP" }, "compact");
    expect(http).toBe(200);
    expect(json.output.map((item: { type: string }) => item.type)).toEqual(["message", "message"]);
    expect(json.output[1].content[0].text).toContain(summary);
  });
});
