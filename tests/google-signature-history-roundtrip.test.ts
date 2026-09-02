/**
 * #1735: a Gemini thought signature must survive a HISTORY-driven turn, where the same-process
 * replay cache is not available — the exact case the cache was masking.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import {
  __resetAntigravityReplayCache,
  applyAntigravityReplay,
  observeAntigravityReplay,
} from "../src/adapters/google-antigravity-replay";
import { parseRequest } from "../src/responses/parser";
import {
  flushThoughtSignatureReplayForTests,
  forgetThoughtSignatureForReplay,
  lookupReplayThoughtSignature,
  rememberThoughtSignatureForReplay,
  resetThoughtSignatureReplayForTests,
} from "../src/responses/thought-signature-replay";
import { durableReplayDestinationIdentity } from "../src/responses/reasoning-replay-cache";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxReasoningReplayScopeRef } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-history-thought-signature-0123456789abcdef";
const SIGNATURE_B = "CiQAx-history-thought-signature-second-call-99";
const MODEL = "gemini-3.6-flash";

const provider = {
  adapter: "google",
  googleMode: "vertex",
  baseUrl: "https://aiplatform.googleapis.com",
  apiKey: "vertex-test-key",
} as OcxProviderConfig;

const aiStudioProvider = {
  adapter: "google",
  googleMode: "ai-studio",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "ai-studio-test-key",
} as OcxProviderConfig;

/**
 * A replay scope is now REQUIRED for the store to remember or return anything: a
 * client-visible call_id is not unique across threads, accounts, providers or models,
 * so keying on it alone let one conversation's signature reach another's turn.
 */
function scopeFor(
  threadId = "thread-a",
  modelId = MODEL,
  providerName = "google",
  destination = "https://generativelanguage.googleapis.com",
): OcxReasoningReplayScopeRef {
  return {
    clientThreadId: threadId,
    current: {
      providerName,
      providerDestinationIdentity: `dest-${providerName}`,
      providerDestinationDurableIdentity: durableReplayDestinationIdentity(destination),
      adapterName: "google",
      modelId,
      credentialIdentity: `cred-${providerName}`,
      // v4 (#1926): the durable store fails closed without a durable credential identity.
      credentialDurableIdentity: `credential:test-${providerName}`,
    },
  };
}

/** parseRequest with the replay scope bound, as the server does after route selection. */
function parseRequestScoped(body: unknown, scope = scopeFor()): OcxParsedRequest {
  const req = parseRequest(body, { replayCacheScope: scope });
  req._reasoningReplayScope = scope;
  return req;
}

function firstTurn(): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream: false,
    context: {
      messages: [{ role: "user", content: "run pwd" }],
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

function googleBody(parts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function modelParts(body: string): Record<string, unknown>[] {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  return parsed.contents.find(content => content.role === "model")?.parts ?? [];
}

/** Build a streaming response whose SSE frames remain distinct transport chunks. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream);
}

const fcPart = (name: string, args: unknown, sig?: string) => {
  const part: Record<string, unknown> = { functionCall: { name, args } };
  if (sig) part.thoughtSignature = sig;
  return part;
};

describe("#1735 thought signature survives history replay", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    __resetAntigravityReplayCache();
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-thought-sig-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(async () => {
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  });

  test("the adapter attaches the signature to the tool call that produced it", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
    ]))));
    const start = events.find((e: AdapterEvent) => e.type === "tool_call_start");
    expect(start && "providerMetadata" in start ? start.providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("a functionCall part with nested extra_content.google.thought_signature is read", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      {
        functionCall: { name: "shell_command", args: { command: "pwd" } },
        extra_content: { google: { thought_signature: SIGNATURE } },
      },
    ]))));
    const start = events.find((e: AdapterEvent) => e.type === "tool_call_start");
    expect(start && "providerMetadata" in start ? start.providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("parallel calls each keep their own signature", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
      { functionCall: { name: "shell_command", args: { command: "ls" } }, thoughtSignature: SIGNATURE_B },
    ]))));
    const signatures = events
      .filter((e: AdapterEvent) => e.type === "tool_call_start")
      .map((e: AdapterEvent) => ("providerMetadata" in e ? e.providerMetadata?.google?.thoughtSignature : undefined));
    // Neither signature may migrate onto the other call.
    expect(signatures).toEqual([SIGNATURE, SIGNATURE_B]);
  });

  test("a standalone thought part's signature attaches to all subsequent functionCalls in non-streaming parse", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { text: "thinking...", thought: true, thoughtSignature: SIGNATURE },
      { functionCall: { name: "shell_command", args: { command: "pwd" } } },
      { functionCall: { name: "shell_command", args: { command: "ls" } } },
    ]))));
    const starts = events.filter((e: AdapterEvent) => e.type === "tool_call_start");
    expect(starts.length).toBe(2);
    expect("providerMetadata" in starts[0] ? starts[0].providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
    expect("providerMetadata" in starts[1] ? starts[1].providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("streaming SSE chunks carry thought signature across chunk boundaries to function calls", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    // Each SSE frame arrives as its own transport chunk so the signature has to
    // survive the chunk boundary between the thought part and the function calls.
    const frames = [
      `data: ${JSON.stringify(googleBody([{ text: "thinking...", thought: true, thought_signature: SIGNATURE }]))}\n\n`,
      `data: ${JSON.stringify(googleBody([{ functionCall: { name: "shell_command", args: { command: "pwd" } } }]))}\n\n`,
      `data: ${JSON.stringify(googleBody([{ functionCall: { name: "shell_command", args: { command: "ls" } } }]))}\n\n`,
      // usageMetadata is the terminal signal; no [DONE] sentinel needed.
      `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })}\n\n`,
    ];

    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(sseResponse(frames))) {
      events.push(event);
    }

    // The turn completes cleanly: no error events, terminal done last.
    expect(events.some((e: AdapterEvent) => e.type === "error")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("done");
    const starts = events.filter((e: AdapterEvent) => e.type === "tool_call_start");
    expect(starts.length).toBe(2);
    expect("providerMetadata" in starts[0] ? starts[0].providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
    expect("providerMetadata" in starts[1] ? starts[1].providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("streaming signatures only attach to function calls that follow them in the same frame", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const frames = [
      `data: ${JSON.stringify(googleBody([
        { functionCall: { name: "shell_command", args: { command: "pwd" } } },
        { text: "thinking...", thought: true, thought_signature: SIGNATURE },
        { functionCall: { name: "shell_command", args: { command: "ls" } } },
      ]))}\n\n`,
    ];

    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(sseResponse(frames))) events.push(event);

    const signatures = events
      .filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> =>
        event.type === "tool_call_start")
      .map(event => event.providerMetadata?.google?.thoughtSignature);
    expect(signatures).toEqual([undefined, SIGNATURE]);
  });

  test("AI Studio keeps source-order thought signature carry across stream frames", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    await adapter.buildRequest(firstTurn());
    const frames = [
      `data: ${JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{ text: "thinking...", thought: true, thought_signature: SIGNATURE }],
          },
        }],
      })}\n\n`,
      `data: ${JSON.stringify(googleBody([
        { functionCall: { name: "shell_command", args: { command: "pwd" } } },
      ]))}\n\n`,
    ];

    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(sseResponse(frames))) events.push(event);

    const start = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> =>
      event.type === "tool_call_start");
    expect(start?.providerMetadata?.google?.thoughtSignature).toBe(SIGNATURE);
  });

  test("a signature replayed through Responses history reaches the rebuilt Google part", async () => {
    // No cache is warmed here: this is a cold process replaying client-supplied history.
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        {
          type: "function_call",
          call_id: "call_shell_1",
          name: "shell_command",
          arguments: JSON.stringify({ command: "pwd" }),
          extra_content: { google: { thought_signature: SIGNATURE } },
        },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("history without a signature stays unsigned rather than borrowing one", async () => {
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_shell_1", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    // The sentinel, not a borrowed signature: nothing was inherited from another call. The
    // property this guards is anti-borrowing, and a constant carries no other call's identity.
    expect(part?.thoughtSignature).toBe("skip_thought_signature_validator");
  });

  test("a signature the proxy remembered re-signs a replay the client sent without extra_content", async () => {
    // The proxy handed out SIGNATURE for call_shell_9 in a previous turn; the client replays
    // the call as a bare function_call item (codex-rs/desktop never echo extra_content).
    rememberThoughtSignatureForReplay("call_shell_9", SIGNATURE, scopeFor());
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_shell_9", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_shell_9", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("a custom_tool_call replay is re-signed from the proxy-side store", async () => {
    rememberThoughtSignatureForReplay("call_custom_1", SIGNATURE_B, scopeFor());
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "custom_tool_call", call_id: "call_custom_1", name: "shell_command", input: JSON.stringify({ command: "pwd" }) },
        { type: "custom_tool_call_output", call_id: "call_custom_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE_B);
  });

  test("a custom_tool_call without call_id store entry falls back to in-memory replay cache by unwrapped args", async () => {
    const adapter = createGoogleAdapter({
      ...provider,
      googleMode: "cloud-code-assist",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      project: "test-proj",
      apiKey: "test-token",
    });
    const parsedDummy = parseRequestScoped({
      model: MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test-session-freeform" }] }],
      tools: [{ type: "function", name: "default_api:exec", description: "run", parameters: { type: "object" } }],
    }, undefined);
    const dummyReq = await adapter.buildRequest(parsedDummy);
    const wireModel = JSON.parse(dummyReq.body as string).model;
    const wireSession = JSON.parse(dummyReq.body as string).request.sessionId;
    const wireToolName = JSON.parse(dummyReq.body as string).request.tools[0].functionDeclarations[0].name;

    // Warm up the Antigravity replay cache with parsed function args:
    observeAntigravityReplay(wireModel, wireSession, [
      { functionCall: { name: wireToolName, args: { cmd: "whoami" } }, thoughtSignature: SIGNATURE },
    ]);
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "test-session-freeform" }] },
        { type: "custom_tool_call", call_id: "call_custom_unscoped", name: "default_api:exec", input: JSON.stringify({ cmd: "whoami" }) },
        { type: "custom_tool_call_output", call_id: "call_custom_unscoped", output: "agent" },
      ],
      tools: [{ type: "function", name: "default_api:exec", description: "run", parameters: { type: "object" } }],
    }, undefined); // unscoped so durable store cannot hit
    const request = await adapter.buildRequest(parsed);
    const reqObj = JSON.parse(request.body as string);
    const contents = reqObj.request.contents;
    const modelTurn = contents.find((c: { role: string }) => c.role === "model");
    expect(modelTurn.parts[0].thoughtSignature).toBe(SIGNATURE);
  });

  test("a tool_search_call replay is re-signed from the proxy-side store", async () => {
    rememberThoughtSignatureForReplay("call_ts_1", SIGNATURE, scopeFor());
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "search tool" }] },
        { type: "tool_search_call", call_id: "call_ts_1", arguments: { query: "grep" } },
        { type: "tool_search_output", call_id: "call_ts_1", tools: [] },
      ],
      tools: [{ type: "function", name: "tool_search", description: "search", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("a local_shell_call replay is re-signed from the proxy-side store", async () => {
    rememberThoughtSignatureForReplay("call_lsh_1", SIGNATURE, scopeFor());
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "shell command" }] },
        { type: "local_shell_call", call_id: "call_lsh_1", action: { type: "exec", command: ["ls"] } },
        { type: "function_call_output", call_id: "call_lsh_1", output: "file.txt" },
      ],
      tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("an unknown call_id stays unsigned", async () => {
    const parsed = parseRequestScoped({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_never_seen", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_never_seen", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    // Unknown call_id borrows nothing; it receives the constant bypass sentinel instead.
    expect(part?.thoughtSignature).toBe("skip_thought_signature_validator");
  });

  test("the same call_id in a different thread does not borrow the signature (#1823)", () => {
    rememberThoughtSignatureForReplay("call_shared", SIGNATURE, scopeFor("thread-a"));
    expect(lookupReplayThoughtSignature("call_shared", scopeFor("thread-a"))).toBe(SIGNATURE);
    expect(lookupReplayThoughtSignature("call_shared", scopeFor("thread-b"))).toBeUndefined();
  });

  test("a different account or model is a different scope (#1823)", () => {
    rememberThoughtSignatureForReplay("call_scoped", SIGNATURE, scopeFor("thread-a", MODEL, "google"));
    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", MODEL, "google"))).toBe(SIGNATURE);
    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", MODEL, "antigravity"))).toBeUndefined();
    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", "gemini-3.6-pro", "google"))).toBeUndefined();
  });

  test("a conflicting signature under one key fails closed instead of overwriting (#1823)", () => {
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE, scopeFor()).result).toBe("stored");
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE, scopeFor()).result).toBe("already-equal");
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE_B, scopeFor()).result).toBe("conflict");
    expect(lookupReplayThoughtSignature("call_conflict", scopeFor())).toBe(SIGNATURE);
  });

  test("an incomplete scope remembers nothing rather than remembering globally (#1823)", () => {
    expect(rememberThoughtSignatureForReplay("call_unscoped", SIGNATURE, undefined).result).toBe("unscoped");
    expect(rememberThoughtSignatureForReplay("call_unscoped", SIGNATURE, { clientThreadId: "t" }).result).toBe("unscoped");
    expect(lookupReplayThoughtSignature("call_unscoped", scopeFor())).toBeUndefined();
  });

  test("a store write reports when it is durable (#1823)", async () => {
    const { result, durable } = rememberThoughtSignatureForReplay("call_durable", SIGNATURE, scopeFor());
    expect(result).toBe("stored");
    await durable;
    expect(lookupReplayThoughtSignature("call_durable", scopeFor())).toBe(SIGNATURE);
  });

  test("the proxy-side store survives a process restart via its snapshot", async () => {
    rememberThoughtSignatureForReplay("call_disk_1", SIGNATURE, scopeFor());
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_disk_1", scopeFor())).toBe(SIGNATURE);
  });

  test("one provider name serving two endpoints does not share signatures", () => {
    const primary = scopeFor("thread-a", MODEL, "google", "https://generativelanguage.googleapis.com");
    const secondary = scopeFor("thread-a", MODEL, "google", "https://gateway.internal.example/v1beta");

    rememberThoughtSignatureForReplay("call_dest", SIGNATURE, primary);

    expect(lookupReplayThoughtSignature("call_dest", primary)).toBe(SIGNATURE);
    expect(lookupReplayThoughtSignature("call_dest", secondary)).toBeUndefined();
  });

  test("the durable destination identity is stable across restarts, unlike the process-local one", async () => {
    const url = "https://generativelanguage.googleapis.com";
    expect(durableReplayDestinationIdentity(url)).toBe(durableReplayDestinationIdentity(url));
    expect(durableReplayDestinationIdentity(url)).not.toBe(durableReplayDestinationIdentity("https://other.example"));
    expect(durableReplayDestinationIdentity(`${url}/`)).toBe(durableReplayDestinationIdentity(url));

    rememberThoughtSignatureForReplay("call_dest_restart", SIGNATURE, scopeFor());
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_dest_restart", scopeFor())).toBe(SIGNATURE);
  });

  test("adapter serialization reads the durable store with the post-parse bound scope (#1926 wiring)", async () => {
    rememberThoughtSignatureForReplay("call_wire_1", SIGNATURE, scopeFor());
    await flushThoughtSignatureReplayForTests();
    const scope: { clientThreadId: string; current?: unknown } = { clientThreadId: "thread-a" };
    const parsed = parseRequestScoped({
      model: MODEL,
      stream: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_wire_1", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_wire_1", output: "ok" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    }, scope as never);
    scope.current = scopeFor().current;
    parsed._reasoningReplayScope = scope as never;
    const adapter = createGoogleAdapter(provider);
    const req = await adapter.buildRequest(parsed, { headers: new Headers() });
    const parts = modelParts(String(req.body));
    const fnPart = parts.find(p => (p as { functionCall?: unknown }).functionCall) as { thoughtSignature?: string } | undefined;
    expect(fnPart?.thoughtSignature).toBe(SIGNATURE);
  });

  test("adapter invalidation: clear-on-invalid evicts the rejected callId from durable store while preserving others", async () => {
    const scope = scopeFor();
    rememberThoughtSignatureForReplay("call_invalid_A", SIGNATURE, scope);
    rememberThoughtSignatureForReplay("call_valid_B", SIGNATURE_B, scope);
    await flushThoughtSignatureReplayForTests();

    // Round 1: Turn containing call_invalid_A
    const parsedA = parseRequestScoped({
      model: MODEL,
      stream: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "run A" }] },
        { type: "function_call", call_id: "call_invalid_A", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_invalid_A", output: "error" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    }, scope);

    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(parsedA);

    // Upstream returns 400 Invalid Argument / thought_signature rejection
    const errorResponse = new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Invalid thought_signature provided for function call",
      },
    }));

    const events = await adapter.parseResponse!(errorResponse);
    expect(events[0].type).toBe("error");

    // Verify call_invalid_A is evicted from durable store
    expect(lookupReplayThoughtSignature("call_invalid_A", scope)).toBeUndefined();
    // Verify call_valid_B remains intact in durable store
    expect(lookupReplayThoughtSignature("call_valid_B", scope)).toBe(SIGNATURE_B);
  });

  test("adapter invalidation: multi-call request rejected by upstream performs conservative batch invalidation", async () => {
    const scope = scopeFor();
    const SIG_C = "CiQAx-history-thought-signature-third-call-77";
    rememberThoughtSignatureForReplay("call_batch_1", SIGNATURE, scope);
    rememberThoughtSignatureForReplay("call_batch_2", SIGNATURE_B, scope);
    rememberThoughtSignatureForReplay("call_unrelated_3", SIG_C, scope);
    await flushThoughtSignatureReplayForTests();

    // Turn containing both call_batch_1 and call_batch_2:
    const parsed = parseRequestScoped({
      model: MODEL,
      stream: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "run batch" }] },
        { type: "function_call", call_id: "call_batch_1", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_batch_1", output: "out1" },
        { type: "function_call", call_id: "call_batch_2", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_batch_2", output: "out2" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    }, scope);

    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(parsed);

    // Upstream 400 rejection (Google error payload does not name which callId failed)
    const errorResponse = new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Function call is missing a thought_signature in functionCall parts",
      },
    }));

    const events = await adapter.parseResponse!(errorResponse);
    expect(events[0].type).toBe("error");

    // Both injected callIds in the rejected request are evicted (conservative batch eviction)
    expect(lookupReplayThoughtSignature("call_batch_1", scope)).toBeUndefined();
    expect(lookupReplayThoughtSignature("call_batch_2", scope)).toBeUndefined();
    // Unrelated call from another turn is preserved
    expect(lookupReplayThoughtSignature("call_unrelated_3", scope)).toBe(SIG_C);
  });
});

describe("Antigravity Multi-Signature History Stability (Mechanism ②)", () => {
  beforeEach(() => {
    __resetAntigravityReplayCache();
  });

  test("preserves chronological signatures across repeated identical tool calls", () => {
    const sessionId = "session-hist-1";
    const model = "gemini-3.7-flash";

    // Round 1: Model calls bash(command: "ls"), returns sig1
    observeAntigravityReplay(model, sessionId, [
      fcPart("bash", { command: "ls" }, "sig-turn-1-abcdef123456"),
    ]);

    // Round 2: Model calls bash(command: "ls") again, returns sig2
    observeAntigravityReplay(model, sessionId, [
      fcPart("bash", { command: "ls" }, "sig-turn-2-ghijkl123456"),
    ]);

    // Round 3: Model calls bash(command: "ls") a third time, returns sig3
    observeAntigravityReplay(model, sessionId, [
      fcPart("bash", { command: "ls" }, "sig-turn-3-mnopqr123456"),
    ]);

    // Client now sends the full history of 3 tool calls without signatures:
    const contents = [
      {
        role: "model",
        parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "bash", response: { output: "file1" } } }],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "bash", response: { output: "file2" } } }],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }],
      },
    ];

    applyAntigravityReplay(model, sessionId, contents);

    // Verify each occurrence gets its corresponding historical signature without prefix mutation:
    const part1 = contents[0].parts[0] as { thoughtSignature?: string };
    const part2 = contents[2].parts[0] as { thoughtSignature?: string };
    const part3 = contents[4].parts[0] as { thoughtSignature?: string };

    expect(part1.thoughtSignature).toBe("sig-turn-1-abcdef123456");
    expect(part2.thoughtSignature).toBe("sig-turn-2-ghijkl123456");
    expect(part3.thoughtSignature).toBe("sig-turn-3-mnopqr123456");
  });

  test("handles interleaved repeated and distinct tool calls correctly", () => {
    const sessionId = "session-hist-interleaved";
    const model = "gemini-3.7-flash";

    // Round 1: Model calls read(file: "a.ts") -> sigA1
    observeAntigravityReplay(model, sessionId, [
      fcPart("read", { file: "a.ts" }, "sig-read-a-1-12345678"),
    ]);

    // Round 2: Model calls read(file: "b.ts") -> sigB1
    observeAntigravityReplay(model, sessionId, [
      fcPart("read", { file: "b.ts" }, "sig-read-b-1-12345678"),
    ]);

    // Round 3: Model calls read(file: "a.ts") again -> sigA2
    observeAntigravityReplay(model, sessionId, [
      fcPart("read", { file: "a.ts" }, "sig-read-a-2-12345678"),
    ]);

    const contents = [
      { role: "model", parts: [{ functionCall: { name: "read", args: { file: "a.ts" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "aaa" } } }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { file: "b.ts" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "bbb" } } }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { file: "a.ts" } } }] },
    ];

    applyAntigravityReplay(model, sessionId, contents);

    expect((contents[0].parts[0] as any).thoughtSignature).toBe("sig-read-a-1-12345678");
    expect((contents[2].parts[0] as any).thoughtSignature).toBe("sig-read-b-1-12345678");
    expect((contents[4].parts[0] as any).thoughtSignature).toBe("sig-read-a-2-12345678");
  });



  test("does not overwrite existing thoughtSignature provided by client", () => {
    const sessionId = "session-hist-3";
    const model = "gemini-3.7-flash";

    observeAntigravityReplay(model, sessionId, [
      fcPart("grep", { pattern: "test" }, "sig-cached-1234567890"),
    ]);

    const contents = [
      {
        role: "model",
        parts: [{ functionCall: { name: "grep", args: { pattern: "test" } }, thoughtSignature: "client-provided-sig" }],
      },
    ];

    applyAntigravityReplay(model, sessionId, contents);

    const part = contents[0].parts[0] as { thoughtSignature?: string };
    expect(part.thoughtSignature).toBe("client-provided-sig");
  });
});

describe("Durable Thought-Signature Replay Store Single-Call Invalidation (Mechanism ①)", () => {
  let previousHome: string | undefined;
  let testDir: string;

  const scope: OcxReasoningReplayScopeRef = {
    clientThreadId: "thread-123",
    current: {
      providerName: "antigravity",
      adapterName: "google",
      modelId: "gemini-3.7-flash",
      credentialDurableIdentity: "cred-xyz-12345",
      providerDestinationDurableIdentity: "dest-abc-67890",
    },
  };

  beforeEach(() => {
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-tsig-inval-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(async () => {
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  });

  test("can remember and selectively forget a specific callId", () => {
    const callId1 = "call-001";
    const callId2 = "call-002";
    const sig1 = "sig-val-001-1234567890abcdef";
    const sig2 = "sig-val-002-1234567890abcdef";

    rememberThoughtSignatureForReplay(callId1, sig1, scope);
    rememberThoughtSignatureForReplay(callId2, sig2, scope);

    expect(lookupReplayThoughtSignature(callId1, scope)).toBe(sig1);
    expect(lookupReplayThoughtSignature(callId2, scope)).toBe(sig2);

    // Evict only callId1
    const forgotten = forgetThoughtSignatureForReplay(callId1, scope);
    expect(forgotten).toBe(true);

    // callId1 is gone
    expect(lookupReplayThoughtSignature(callId1, scope)).toBeUndefined();
    // callId2 remains intact
    expect(lookupReplayThoughtSignature(callId2, scope)).toBe(sig2);

    // Forgetting non-existent callId returns false
    expect(forgetThoughtSignatureForReplay("call-999", scope)).toBe(false);
  });
});

describe("#2513 rejected signatures are evicted on every Google mode", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    __resetAntigravityReplayCache();
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-tsig-mode-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(async () => {
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  });

  /**
   * The durable store is NOT mode-scoped: a signature is remembered and looked up on every
   * Google mode, AI Studio included. Eviction used to be gated on cloud-code-assist/vertex,
   * so an AI Studio turn whose signature the upstream rejected kept replaying that same
   * rejected signature out of the store on every following turn.
   */
  for (const [label, modeProvider] of [
    ["ai-studio", aiStudioProvider],
    ["vertex", provider],
  ] as const) {
    test(`${label}: a rejected signature does not survive in the durable store`, async () => {
      const scope = scopeFor("thread-evict", MODEL, "google");
      const parsed = { ...firstTurn(), _reasoningReplayScope: scope } as unknown as OcxParsedRequest;

      const adapter = createGoogleAdapter(modeProvider);
      // Warm the store the way a real turn does, then replay it so the adapter records the
      // call id as injected for this turn.
      rememberThoughtSignatureForReplay("call_evict_1", SIGNATURE, scope);
      await flushThoughtSignatureReplayForTests();
      expect(lookupReplayThoughtSignature("call_evict_1", scope)).toBe(SIGNATURE);

      const replayParsed = parseRequestScoped({
        model: MODEL,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
          {
            type: "function_call",
            call_id: "call_evict_1",
            name: "shell_command",
            arguments: JSON.stringify({ command: "pwd" }),
          },
          { type: "function_call_output", call_id: "call_evict_1", output: "/workspace" },
        ],
        tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
      }, scope);
      await adapter.buildRequest(replayParsed);
      void parsed;

      // The upstream rejects the replayed signature.
      const events = await adapter.parseResponse!(new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Function call is missing a thought_signature in functionCall parts",
          },
        }),
        { status: 400 },
      ));
      expect(events.some((event: AdapterEvent) => event.type === "error")).toBe(true);

      await flushThoughtSignatureReplayForTests();
      expect(lookupReplayThoughtSignature("call_evict_1", scope)).toBeUndefined();
    });
  }
});

