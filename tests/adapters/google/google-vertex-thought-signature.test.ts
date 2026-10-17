import { beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import {
  __resetAntigravityReplayCache,
  applyAntigravityReplay,
} from "../../../src/adapters/google-antigravity-replay";
import { antigravitySessionId } from "../../../src/adapters/google-antigravity-wire";
import type { AdapterEvent, OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

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
    // #1312 isolation still holds: thread-b gets the CONSTANT sentinel, never thread-a's real
    // signature. A genuine cross-namespace leak would surface the real value here and fail.
    expect(replayedFunctionCall(otherThread.body as string).thoughtSignature).toBe("skip_thought_signature_validator");

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

  test("ambient Vertex environment changes do not move an express API key's replay namespace", async () => {
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    try {
      delete process.env.GOOGLE_CLOUD_PROJECT;
      const firstAdapter = createGoogleAdapter(provider);
      await firstAdapter.buildRequest(firstTurn(false));
      await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));
      process.env.GOOGLE_CLOUD_PROJECT = "unrelated-gcloud-default";
      const followup = await createGoogleAdapter(provider).buildRequest(continuation());
      expect(followup.url).toContain("/v1/publishers/google/models/");
      expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT; else process.env.GOOGLE_CLOUD_PROJECT = saved;
    }
  });

  test("distinct API-key project endpoints keep separate replay namespaces", async () => {
    const firstAdapter = createGoogleAdapter({ ...provider, project: "project-a" });
    await firstAdapter.buildRequest(firstTurn(false));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));

    const otherProject = await createGoogleAdapter({ ...provider, project: "project-b" }).buildRequest(continuation());
    expect(replayedFunctionCall(otherProject.body as string).thoughtSignature).toBe("skip_thought_signature_validator");
    const sameProject = await createGoogleAdapter({ ...provider, project: "project-a" }).buildRequest(continuation());
    expect(replayedFunctionCall(sameProject.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("express mode and a project literally named api-key keep separate replay namespaces", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));

    const projectEndpoint = await createGoogleAdapter({ ...provider, project: "api-key", location: "global" }).buildRequest(continuation());
    expect(projectEndpoint.url).toContain("/v1/projects/api-key/locations/global/");
    expect(replayedFunctionCall(projectEndpoint.body as string).thoughtSignature).toBe("skip_thought_signature_validator");
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

describe("Vertex Argon tool-result images", () => {
  const image = (data = "YQ==", mediaType = "image/png"): OcxContentPart =>
    ({ type: "image", imageUrl: `data:${mediaType};base64,${data}` });
  const inline = (data = "YQ==", mime_type = "image/png") => ({ inline_data: { mime_type, data } });

  async function wire(
    messages = continuation().context.messages,
    googleMode: OcxProviderConfig["googleMode"] = "vertex",
    modelId = "gemini-4-argon",
  ) {
    const built = await createGoogleAdapter({ ...provider, googleMode, project: "test-project" })
      .buildRequest({ ...request(messages, false), modelId });
    const body = JSON.parse(built.body);
    return body.request ?? body;
  }

  function history(content: string | OcxContentPart[]) {
    const messages = continuation().context.messages;
    messages[2] = { role: "toolResult", toolCallId: "call_shell_1", toolName: "shell_command",
      content, isError: false, timestamp: 0 };
    return messages;
  }

  test.each([false, true])("Argon image continuation replays the original signature (stream=%s)", async (stream) => {
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest({ ...firstTurn(stream), modelId: "gemini-4-argon" });
    const json = JSON.stringify(vertexResponseBody());
    const response = new Response(stream ? `data: ${json}\n\n` : json);
    const events: AdapterEvent[] = [];
    if (stream) {
      for await (const event of adapter.parseStream(response)) events.push(event);
    } else events.push(...await adapter.parseResponse!(response));
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);
    const followup = await createGoogleAdapter(provider).buildRequest({
      ...request(history([image()]), false), modelId: "gemini-4-argon",
    });
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
    expect(JSON.parse(followup.body).contents.at(-1).parts[0].functionResponse.parts).toEqual([inline()]);
  });

  test("Argon continuation replays the signature, nests the matched image and separates a duplicate image", async () => {
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest({ ...firstTurn(false), modelId: "gemini-4-argon" });
    await adapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));
    const messages = history([image()]);
    messages.push({ role: "toolResult", toolCallId: "call_shell_1", toolName: "shell_command",
      content: [{ type: "text", text: "again" }, image("Yg==")], isError: false, timestamp: 0 });
    const followup = await createGoogleAdapter(provider).buildRequest({ ...request(messages, false), modelId: "gemini-4-argon" });
    const contents = JSON.parse(followup.body as string).contents;
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
    expect(contents.at(-2)).toEqual({ role: "user", parts: [{ functionResponse: {
      id: "call_shell_1", name: "shell_command", response: { result: "[image]" }, parts: [inline()],
    } }] });
    expect(contents.at(-1)).toEqual({ role: "user", parts: [
      { text: "[tool_result without adjacent tool_use: shell_command (call_shell_1)]\nagain[image]" }, inline("Yg=="),
    ] });
    const textParts = contents.flatMap((c: { parts: Array<{ text?: string }> }) => c.parts).filter((p: { text?: string }) => typeof p.text === "string");
    expect(textParts.some((p: { text: string }) => p.text.includes("YQ==") || p.text.includes("Yg=="))).toBe(false);
  });

  test.each([false, true])("streaming and non-streaming continuations nest Argon images identically (stream=%p)", async (stream) => {
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest({ ...firstTurn(false), modelId: "gemini-4-argon" });
    await adapter.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));
    const followup = await createGoogleAdapter(provider).buildRequest({
      ...request(history([image()]), stream), modelId: "gemini-4-argon",
    });
    expect(followup.url).toContain(stream ? ":streamGenerateContent" : ":generateContent");
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
    expect(JSON.parse(followup.body as string).contents.at(-1)).toEqual({ role: "user", parts: [{ functionResponse: {
      id: "call_shell_1", name: "shell_command", response: { result: "[image]" }, parts: [inline()],
    } }] });
  });

  test("error results keep matched-image ownership and orphan-image placement", async () => {
    const messages = history([{ type: "text", text: "failed" }, image()]);
    (messages[2] as { isError: boolean }).isError = true;
    messages.push({ role: "toolResult", toolCallId: "call_shell_1", toolName: "shell_command",
      content: [{ type: "text", text: "failed again" }, image("Yg==")], isError: true, timestamp: 0 });
    const body = await wire(messages);
    expect(body.contents.at(-2)).toEqual({ role: "user", parts: [{ functionResponse: {
      id: "call_shell_1", name: "shell_command", response: { result: "failed[image]" }, parts: [inline()],
    } }] });
    expect(body.contents.at(-1)).toEqual({ role: "user", parts: [
      { text: "[tool_result without adjacent tool_use: shell_command (call_shell_1)]\nfailed again[image]" }, inline("Yg=="),
    ] });
  });

  const withAmbientVertexEnv = async (run: () => Promise<void>) => {
    const saved = { p: process.env.GOOGLE_CLOUD_PROJECT, g: process.env.GCLOUD_PROJECT, l: process.env.GOOGLE_CLOUD_LOCATION };
    try {
      process.env.GOOGLE_CLOUD_PROJECT = "ambient-project";
      process.env.GCLOUD_PROJECT = "ambient-gcloud-project";
      process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";
      await run();
    } finally {
      if (saved.p === undefined) delete process.env.GOOGLE_CLOUD_PROJECT; else process.env.GOOGLE_CLOUD_PROJECT = saved.p;
      if (saved.g === undefined) delete process.env.GCLOUD_PROJECT; else process.env.GCLOUD_PROJECT = saved.g;
      if (saved.l === undefined) delete process.env.GOOGLE_CLOUD_LOCATION; else process.env.GOOGLE_CLOUD_LOCATION = saved.l;
    }
  };
  const expectApiKeyAuth = (built: { headers?: Record<string, string> }) => {
    const headers = Object.fromEntries(Object.entries(built.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers["x-goog-api-key"]).toBe("vertex-test-key");
    expect(headers.authorization).toBeUndefined();
  };
  const orphanTurn = { role: "user", parts: [
    { text: "[tool_result without adjacent tool_use: shell_command (call_shell_1)]\nagain[image]" }, inline("Yg=="),
  ] };
  const nestedTurn = { role: "user", parts: [{ functionResponse: {
    id: "call_shell_1", name: "shell_command", response: { result: "[image]" }, parts: [inline()],
  } }] };
  function withDuplicate() {
    const messages = history([image()]);
    messages.push({ role: "toolResult", toolCallId: "call_shell_1", toolName: "shell_command",
      content: [{ type: "text", text: "again" }, image("Yg==")], isError: false, timestamp: 0 });
    return messages;
  }

  test("API-key project endpoint (#7266) carries Argon image nesting and signature replay (#7280)", async () => {
    await withAmbientVertexEnv(async () => {
      __resetAntigravityReplayCache();
      const keyed = { ...provider, project: "configured-project" } as OcxProviderConfig;
      const first = createGoogleAdapter(keyed);
      await first.buildRequest({ ...firstTurn(false), modelId: "gemini-4-argon" });
      await first.parseResponse!(new Response(JSON.stringify(vertexResponseBody())));
      const followup = await createGoogleAdapter(keyed).buildRequest({ ...request(withDuplicate(), false), modelId: "gemini-4-argon" });
      expect(followup.url).toBe("https://aiplatform.googleapis.com/v1/projects/configured-project/locations/global/publishers/google/models/gemini-4-argon:generateContent");
      expectApiKeyAuth(followup);
      const contents = JSON.parse(followup.body as string).contents;
      expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
      expect(contents.at(-2)).toEqual(nestedTurn);
      expect(contents.at(-1)).toEqual(orphanTurn);
    });
  });

  test("projectless API key stays on the express endpoint while nesting Argon images", async () => {
    await withAmbientVertexEnv(async () => {
      const built = await createGoogleAdapter(provider).buildRequest({ ...request(withDuplicate(), false), modelId: "gemini-4-argon" });
      expect(built.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:generateContent");
      expectApiKeyAuth(built);
      const contents = JSON.parse(built.body as string).contents;
      expect(contents.at(-2)).toEqual(nestedTurn);
      expect(contents.at(-1)).toEqual(orphanTurn);
    });
  });

  test.each([
    ["single image", [image()], [inline()], "[image]"],
    ["multiple images with text", [{ type: "text", text: "captured" }, image(), image("Yg==", "image/jpeg")],
      [inline(), inline("Yg==", "image/jpeg")], "captured[image][image]"],
  ] as const)("nests %s inside the matching functionResponse", async (_label, images, expected, text) => {
    const body = await wire(history([...images]));
    expect(body.contents.at(-1)).toEqual({ role: "user", parts: [{ functionResponse: {
      id: "call_shell_1", name: "shell_command", response: { result: text }, parts: [...expected],
    } }] });
  });

  test("reversed parallel results retain image ownership and collision-safe call ids", async () => {
    const messages = continuation().context.messages;
    messages[1] = { role: "assistant", timestamp: 0, content: [
      { type: "toolCall", id: "call:a", name: "first", arguments: {} },
      { type: "toolCall", id: "call/a", name: "second", arguments: {} },
    ] };
    messages.splice(2, 1,
      { role: "toolResult", toolCallId: "call/a", toolName: "second", content: [image("Yg==")],
        isError: false, timestamp: 0 },
      { role: "toolResult", toolCallId: "call:a", toolName: "first", isError: false, timestamp: 0,
        content: [{ type: "text", text: "first" }, image(), image("Yw==")] },
    );
    const body = await wire(messages);
    const [first, second] = body.contents[1].parts;
    expect(first.functionCall.id).not.toBe(second.functionCall.id);
    expect(body.contents.at(-1).parts).toEqual([
      { functionResponse: { id: first.functionCall.id, name: "first",
        response: { result: "first[image][image]" }, parts: [inline(), inline("Yw==")] } },
      { functionResponse: { id: second.functionCall.id, name: "second",
        response: { result: "[image]" }, parts: [inline("Yg==")] } },
    ]);
  });

  test.each([
    ["plain text", "plain text"], ["empty string", ""], ["empty parts", []],
  ] as const)("text-only output retains its existing shape (%s)", async (_label, content) => {
    const body = await wire(history(typeof content === "string" ? content : [...content]));
    expect(body.contents.at(-1).parts).toEqual([{ functionResponse: {
      id: "call_shell_1", name: "shell_command",
      response: { result: typeof content === "string" && content ? content : "(empty tool output)" },
    } }]);
  });

  test.each([
    ["vertex", "gemini-3.1-pro"],
    ["vertex", "gemini-4-argon-preview"],
    ["ai-studio", "gemini-4-argon"],
    ["cloud-code-assist", "gemini-4-argon"],
  ] as const)("other routes retain image siblings (%s, %s)", async (mode, model) => {
    const body = await wire(history([image()]), mode, model);
    expect(body.contents.at(-1).parts).toEqual([
      { functionResponse: { id: "call_shell_1", name: "shell_command", response: { result: "[image]" } } },
      inline(),
    ]);
  });

  test("ordinary user and orphan result images retain their existing shape", async () => {
    const body = await wire([
      { role: "user", content: [image()], timestamp: 0 },
      { role: "toolResult", toolCallId: "orphan", toolName: "inspect", content: [image("Yg==")],
        isError: false, timestamp: 0 },
    ]);
    expect(body.contents).toEqual([
      { role: "user", parts: [inline()] },
      { role: "user", parts: [
        { text: "[tool_result without adjacent tool_use: inspect (orphan)]\n[image]" }, inline("Yg=="),
      ] },
    ]);
  });

  test.each(["call_shell_1", "unknown"])("separates orphan images after the complete response batch (%s)", async (id) => {
    const messages = history([image()]);
    messages.push(
      { role: "toolResult", toolCallId: id, toolName: "inspect", content: "before", isError: false, timestamp: 0 },
      { role: "toolResult", toolCallId: id, toolName: "inspect",
        content: [{ type: "text", text: "orphan" }, image("Yg=="), image("Yw==", "image/jpeg")],
        isError: false, timestamp: 0 },
      { role: "toolResult", toolCallId: id, toolName: "inspect", content: "after", isError: false, timestamp: 0 },
    );
    const original = structuredClone(messages);
    const body = await wire(messages);
    expect(body.contents.slice(2)).toEqual([
      { role: "user", parts: [{ functionResponse: {
        id: "call_shell_1", name: "shell_command", response: { result: "[image]" }, parts: [inline()],
      } }] },
      { role: "user", parts: [
        { text: `[tool_result without adjacent tool_use: inspect (${id})]\nbefore` },
        { text: `[tool_result without adjacent tool_use: inspect (${id})]\norphan[image][image]` },
        inline("Yg=="), inline("Yw==", "image/jpeg"),
        { text: `[tool_result without adjacent tool_use: inspect (${id})]\nafter` },
      ] },
    ]);
    expect(messages).toEqual(original);
  });

  test("orphan images follow missing responses without claiming a successful call", async () => {
    const messages = continuation().context.messages;
    messages[2] = { role: "toolResult", toolCallId: "unknown", toolName: "inspect", content: [image()],
      isError: false, timestamp: 0 };
    const body = await wire(messages);
    expect(body.contents[2].parts).toEqual([{ functionResponse: {
      id: "call_shell_1", name: "shell_command",
      response: { result: "[missing tool_result for this tool_use in history]" },
    } }]);
    expect(body.contents[3]).toEqual({ role: "user", parts: [
      { text: "[tool_result without adjacent tool_use: inspect (unknown)]\n[image]" }, inline(),
    ] });
  });

  test.each(["vertex", "ai-studio", "cloud-code-assist"] as const)("text-only orphans retain their existing batch (%s)", async (mode) => {
    const messages = history("done");
    messages.push({ role: "toolResult", toolCallId: "unknown", toolName: "inspect", content: "orphan",
      isError: false, timestamp: 0 });
    const body = await wire(messages, mode);
    expect(body.contents.at(-1).parts).toEqual([
      { functionResponse: { id: "call_shell_1", name: "shell_command", response: { result: "done" } } },
      { text: "[tool_result without adjacent tool_use: inspect (unknown)]\norphan" },
    ]);
  });

  test.each([
    ["vertex", "gemini-3.1-pro"], ["vertex", "gemini-4-argon-preview"],
    ["ai-studio", "gemini-4-argon"], ["cloud-code-assist", "gemini-4-argon"],
  ] as const)("other routes retain orphan image siblings (%s, %s)", async (mode, model) => {
    const messages = history("done");
    messages.push({ role: "toolResult", toolCallId: "unknown", toolName: "inspect", content: [image()],
      isError: false, timestamp: 0 });
    const body = await wire(messages, mode, model);
    expect(body.contents.at(-1).parts).toEqual([
      { functionResponse: { id: "call_shell_1", name: "shell_command", response: { result: "done" } } },
      { text: "[tool_result without adjacent tool_use: inspect (unknown)]\n[image]" }, inline(),
    ]);
  });

  test("opening call, missing result and model-tail repairs stay intact", async () => {
    const messages = continuation().context.messages;
    const body = await wire([messages[1]]);
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
    expect(body.contents.at(-1).parts).toEqual([{ functionResponse: {
      id: "call_shell_1", name: "shell_command",
      response: { result: "[missing tool_result for this tool_use in history]" },
    } }]);
    const tail = await wire([{ role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 0 }]);
    expect(tail.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
  });
});
