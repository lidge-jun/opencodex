/**
 * #1735: a Gemini thought signature must survive a HISTORY-driven turn, where the same-process
 * replay cache is not available — the exact case the cache was masking.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { __resetAntigravityReplayCache, observeAntigravityReplay } from "../src/adapters/google-antigravity-replay";
import { parseRequest } from "../src/responses/parser";
import {
  flushThoughtSignatureReplayForTests,
  lookupReplayThoughtSignature,
  rememberThoughtSignatureForReplay,
  resetThoughtSignatureReplayForTests,
} from "../src/responses/thought-signature-replay";
import { durableReplayDestinationIdentity } from "../src/responses/reasoning-replay-cache";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

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
) {
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
function parseRequestScoped(body: unknown, scope = scopeFor()) {
  return parseRequest(body, { replayCacheScope: scope });
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

describe("#1735 thought signature survives history replay", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    __resetAntigravityReplayCache();
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-thought-sig-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(testDir, { recursive: true, force: true });
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

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });

    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(stream))) {
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
    expect(part?.thoughtSignature).toBeUndefined();
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
    expect(part?.thoughtSignature).toBeUndefined();
  });


  test("the same call_id in a different thread does not borrow the signature (#1823)", () => {
    // A client-visible call_id is not unique. Keyed on it alone, one conversation's
    // signature was handed to another's replay -- and a second thread writing the same
    // id silently overwrote the first.
    rememberThoughtSignatureForReplay("call_shared", SIGNATURE, scopeFor("thread-a"));

    expect(lookupReplayThoughtSignature("call_shared", scopeFor("thread-a"))).toBe(SIGNATURE);
    expect(lookupReplayThoughtSignature("call_shared", scopeFor("thread-b"))).toBeUndefined();
  });

  test("a different account or model is a different scope (#1823)", () => {
    rememberThoughtSignatureForReplay("call_scoped", SIGNATURE, scopeFor("thread-a", MODEL, "google"));

    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", MODEL, "google"))).toBe(SIGNATURE);
    // Same thread and call id, different provider identity: opaque signatures are not
    // portable across providers, so this must miss rather than cross-contaminate.
    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", MODEL, "antigravity"))).toBeUndefined();
    // Same thread and provider, different model.
    expect(lookupReplayThoughtSignature("call_scoped", scopeFor("thread-a", "gemini-3.6-pro", "google"))).toBeUndefined();
  });

  test("a conflicting signature under one key fails closed instead of overwriting (#1823)", () => {
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE, scopeFor()).result).toBe("stored");
    // Re-remembering the same value is a no-op, not a conflict: retries are ordinary.
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE, scopeFor()).result).toBe("already-equal");
    // A DIFFERENT value under the same complete key means two upstream turns claimed one
    // identity. Keeping the first is the fail-closed choice; last-write-wins would let a
    // later turn silently invalidate an earlier replay.
    expect(rememberThoughtSignatureForReplay("call_conflict", SIGNATURE_B, scopeFor()).result).toBe("conflict");
    expect(lookupReplayThoughtSignature("call_conflict", scopeFor())).toBe(SIGNATURE);
  });

  test("an incomplete scope remembers nothing rather than remembering globally (#1823)", () => {
    // A partially identified entry is exactly the cross-thread collision this store exists
    // to prevent, so it must not be stored under a degraded key.
    expect(rememberThoughtSignatureForReplay("call_unscoped", SIGNATURE, undefined).result).toBe("unscoped");
    expect(rememberThoughtSignatureForReplay("call_unscoped", SIGNATURE, { clientThreadId: "t" }).result).toBe("unscoped");
    expect(lookupReplayThoughtSignature("call_unscoped", scopeFor())).toBeUndefined();
  });

  test("a store write reports when it is durable (#1823)", async () => {
    // The caller can await this before exposing the tool-call item, so a client cannot
    // observe a call whose signature was never persisted.
    const { result, durable } = rememberThoughtSignatureForReplay("call_durable", SIGNATURE, scopeFor());
    expect(result).toBe("stored");
    await durable;
    expect(lookupReplayThoughtSignature("call_durable", scopeFor())).toBe(SIGNATURE);
  });
  test("the proxy-side store survives a process restart via its snapshot", async () => {
    rememberThoughtSignatureForReplay("call_disk_1", SIGNATURE, scopeFor());
    await flushThoughtSignatureReplayForTests();
    // Simulate a fresh process: drop in-memory state; lookup must reload from disk.
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_disk_1", scopeFor())).toBe(SIGNATURE);
  });

  test("one provider name serving two endpoints does not share signatures", () => {
    // The gap the durable key closes. providerName, adapterName, modelId and thread can all
    // be identical across two upstreams — a gateway and a direct endpoint under one config
    // name — and an opaque signature minted by one is meaningless to the other.
    const primary = scopeFor("thread-a", MODEL, "google", "https://generativelanguage.googleapis.com");
    const secondary = scopeFor("thread-a", MODEL, "google", "https://gateway.internal.example/v1beta");

    rememberThoughtSignatureForReplay("call_dest", SIGNATURE, primary);

    expect(lookupReplayThoughtSignature("call_dest", primary)).toBe(SIGNATURE);
    expect(lookupReplayThoughtSignature("call_dest", secondary)).toBeUndefined();
  });

  test("the durable destination identity is stable across restarts, unlike the process-local one", async () => {
    // The reason this is a separate digest rather than the sibling cache's HMAC: that one is
    // keyed by randomBytes minted at module load, so reusing it here would change every key
    // on restart and the store would silently stop matching — a worse failure than the
    // over-broad key it replaced, because it looks like it is working.
    const url = "https://generativelanguage.googleapis.com";
    expect(durableReplayDestinationIdentity(url)).toBe(durableReplayDestinationIdentity(url));
    expect(durableReplayDestinationIdentity(url)).not.toBe(durableReplayDestinationIdentity("https://other.example"));
    // Trailing-slash normalization matches the process-local form.
    expect(durableReplayDestinationIdentity(`${url}/`)).toBe(durableReplayDestinationIdentity(url));

    rememberThoughtSignatureForReplay("call_dest_restart", SIGNATURE, scopeFor());
    await flushThoughtSignatureReplayForTests();
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_dest_restart", scopeFor())).toBe(SIGNATURE);
  });

  test("adapter serialization reads the durable store with the post-parse bound scope (#1926 wiring)", async () => {
    // The server parses BEFORE the route/credential scope exists, so the parser's own
    // lookup cannot hit; the google adapter's serialization-time fallback must read the
    // durable store once the scope identity has been bound.
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
    // Identity binds after parse, as bindRouteReasoningReplayScope does server-side.
    scope.current = scopeFor().current;
    parsed._reasoningReplayScope = scope as never;
    const adapter = createGoogleAdapter(provider);
    const req = await adapter.buildRequest(parsed, { headers: new Headers() });
    const parts = modelParts(String(req.body));
    const fnPart = parts.find(p => (p as { functionCall?: unknown }).functionCall) as { thoughtSignature?: string } | undefined;
    expect(fnPart?.thoughtSignature).toBe(SIGNATURE);
  });
});
