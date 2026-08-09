import { beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import {
  __resetAntigravityReplayCache,
  applyAntigravityReplay,
} from "../src/adapters/google-antigravity-replay";
import { antigravitySessionId } from "../src/adapters/google-antigravity-wire";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-vertex-thought-signature-0123456789abcdef";
const MODEL = "gemini-3.6-flash";

const provider = {
  adapter: "google",
  googleMode: "vertex",
  baseUrl: "https://aiplatform.googleapis.com",
  apiKey: "vertex-test-key",
} as OcxProviderConfig;

function request(messages: OcxParsedRequest["context"]["messages"], stream: boolean): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream,
    context: {
      messages,
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

const firstTurn = (stream: boolean) => request([{ role: "user", content: "run pwd" }], stream);

const continuation = () => request([
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call_shell_1",
      name: "shell_command",
      arguments: { command: "pwd" },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call_shell_1",
    toolName: "shell_command",
    content: "/workspace",
  },
], false);

function scopedReplayRequest(
  parsed: OcxParsedRequest,
  threadId: string | undefined,
  promptCacheKey: string | undefined,
): OcxParsedRequest {
  if (threadId !== undefined) parsed._clientThreadId = threadId;
  if (promptCacheKey !== undefined) parsed.options.promptCacheKey = promptCacheKey;
  return parsed;
}

function vertexResponseBody(): Record<string, unknown> {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [{
          functionCall: { name: "shell_command", args: { command: "pwd" } },
          thoughtSignature: SIGNATURE,
        }],
      },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function replayedFunctionCall(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  const model = parsed.contents.find(content => content.role === "model");
  const part = model?.parts?.find(candidate => "functionCall" in candidate);
  if (!part) throw new Error("compiled Vertex request omitted the replayed functionCall");
  return part;
}

describe("Vertex thought-signature continuation (#1254)", () => {
  beforeEach(() => __resetAntigravityReplayCache());

  test("streaming functionCall signature is replayed on the next tool-result turn", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(true));
    const response = new Response(`data: ${JSON.stringify(vertexResponseBody())}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const events: AdapterEvent[] = [];
    for await (const event of firstAdapter.parseStream(response)) events.push(event);
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("non-streaming functionCall signature is replayed unchanged", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    const events = await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("#1312: shared prompt cache keys cannot cross client-thread replay namespaces", async () => {
    const first = scopedReplayRequest(firstTurn(false), "thread-a", "shared-cache-cohort");
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(first);
    await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));

    const otherThread = await createGoogleAdapter(provider).buildRequest(
      scopedReplayRequest(continuation(), "thread-b", "shared-cache-cohort"),
    );
    expect(replayedFunctionCall(otherThread.body as string).thoughtSignature).toBeUndefined();

    const originalThread = await createGoogleAdapter(provider).buildRequest(
      scopedReplayRequest(continuation(), "thread-a", "different-cache-cohort"),
    );
    expect(replayedFunctionCall(originalThread.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("#1312: threadless clients keep deterministic replay regardless of prompt cache key", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(scopedReplayRequest(firstTurn(false), undefined, "cohort-a"));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));

    const followup = await createGoogleAdapter(provider).buildRequest(
      scopedReplayRequest(continuation(), undefined, "cohort-b"),
    );
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("Vertex signatures cannot enter the Antigravity replay namespace", async () => {
    const first = firstTurn(false);
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(first);
    await adapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));

    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "shell_command", args: { command: "pwd" } } }],
    }];
    applyAntigravityReplay(MODEL, antigravitySessionId(first), contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });
});
