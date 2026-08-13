import { createOpenAIChatAdapter } from "../../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import { anthropicToResponsesTranslation } from "../../claude/inbound";
import { responsesSseToAnthropicSse } from "../../claude/outbound";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { parseRequest } from "../../responses/parser";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  rememberResponseState,
} from "../../responses/state";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { evaluateAssertions } from "./assertion";
import { fixtureProviderConfig, upstreamAdapterForProtocol } from "./fixture-provider";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { attachMcpVerifiers, executeMcpSyntheticAction } from "./mcp-stub";
import {
  attachVerifiers,
  emptyObservation,
  finalizeObservation,
  filterAnthropicEvents,
  recordUpstreamRequest,
} from "./observation";
import { normalizeSseBytes } from "./sse-normalize";
import type { CaseRecord, NormalizedObservation, ScenarioRunResult, ProtocolExecutionContextV1 } from "./types";

export function resolveProtocolExecutionContext(caseRecord: CaseRecord): ProtocolExecutionContextV1 {
  const inbound = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const upstream = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  let surface = caseRecord.requirements.surfaces[0] ?? "responses-http";
  if (caseRecord.id === "responses-core.protocol.json-sse-equivalence") {
    surface = "responses-sse";
  } else if (caseRecord.requirements.surfaces.length === 1) {
    surface = caseRecord.requirements.surfaces[0]!;
  }
  return { inboundProtocol: inbound, upstreamProtocol: upstream, surface };
}

async function collectAdapterEvents(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

export function nonstreamObservationJson(
  parsedEvents: AdapterEvent[],
  responseJson: Record<string, unknown>,
  model = "fixture-model",
): Record<string, unknown> {
  return parsedEvents.length > 0
    ? buildResponseJSON(parsedEvents, model) as Record<string, unknown>
    : responseJson;
}

async function collectBridgeSse(events: AdapterEvent[], model = "fixture-model"): Promise<{
  events: ReturnType<typeof normalizeSseBytes>;
}> {
  async function* replay(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const stream = bridgeToResponsesSSE(replay(), model, undefined, new Set(["apply_patch"]));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  // bridgeToResponsesSSE appends a client-transport [DONE] padding frame. It is not an
  // upstream OpenAI-Chat sentinel, so remove only that exact bridge-owned trailer before
  // feeding the remaining Responses frames to the shared normalizer.
  const trailer = "data: [DONE]\n\n";
  const framed = text.endsWith(trailer) ? text.slice(0, -trailer.length) : text;
  return { events: normalizeSseBytes(new TextEncoder().encode(framed), "openai-responses") };
}

async function parseUpstreamSse(adapter: ReturnType<typeof createOpenAIChatAdapter>, body: string): Promise<AdapterEvent[]> {
  const budget = createTranslatorBudget();
  try {
    const response = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    return await collectAdapterEvents(adapter.parseStream(response, budget));
  } finally {
    budget.dispose();
  }
}

function parsedFromContext(vector: Record<string, unknown>): OcxParsedRequest {
  const context = vector.context as Record<string, unknown> | undefined;
  const options = vector.options as Record<string, unknown> | undefined;
  const messages = context?.messages as Array<Record<string, unknown>> | undefined;
  const input = messages
    ? messages.map((m) => ({ role: m.role, content: m.content }))
    : vector.input ?? "PING";
  const body: Record<string, unknown> = {
    model: vector.modelId ?? "fixture-model",
    input,
    stream: vector.stream ?? false,
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.reasoning !== undefined ? { reasoning: { effort: options.reasoning } } : {}),
    ...(options?.textFormat ? { text: { format: options.textFormat } } : {}),
    ...(vector.tools ? { tools: normalizeTools(vector.tools as unknown[]) } : {}),
    ...(vector.tool_choice ? { tool_choice: vector.tool_choice } : {}),
    ...(vector.text ? { text: vector.text } : {}),
  };
  if (context?.systemPrompt) body.instructions = (context.systemPrompt as string[])[0];
  return parseRequest(body);
}

function normalizeTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const rec = tool as Record<string, unknown>;
    if (!rec.type && rec.name && rec.parameters) return { type: "function", ...rec };
    return tool;
  });
}

function createHarnessAdapter(provider: OcxProviderConfig) {
  return withHarnessTranslatorBudget(
    provider.adapter === "openai-responses"
      ? createResponsesPassthroughAdapter(provider)
      : createOpenAIChatAdapter(provider),
  );
}

async function runBuildRequest(
  observation: NormalizedObservation,
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
): Promise<NormalizedObservation> {
  const adapter = createHarnessAdapter(provider);
  try {
    const built = await adapter.buildRequest(parsed, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built.body));
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function executeAdapterVector(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  const upstreamProtocol = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const adapterName = upstreamAdapterForProtocol(upstreamProtocol);
  const provider = fixtureProviderConfig(adapterName);

  switch (caseRecord.id) {
    case "responses-core.protocol.request-shape":
      return await runBuildRequest(observation, parsedFromContext(vector), provider);

    case "responses-core.protocol.json-sse-equivalence": {
      const json = vector.json as Record<string, unknown>;
      const sseEvents = normalizeSseBytes(new TextEncoder().encode(String(vector.sse ?? "")), "openai-responses");
      finalizeObservation(observation, sseEvents, json, 200);
      attachVerifiers(observation, caseRecord);
      return observation;
    }

    case "chat-core.protocol.request-mapping":
      return await runBuildRequest(observation, parsedFromContext(vector), provider);

    case "anthropic-core.protocol.request-mapping": {
      const anthropicBody = JSON.parse(caseRecord.fixture.bytesUtf8);
      const translated = anthropicToResponsesTranslation(anthropicBody);
      return await runBuildRequest(observation, parseRequest(translated.body), fixtureProviderConfig("openai-responses"));
    }

    case "anthropic-core.protocol.tool-round-trip": {
      const toolBody = JSON.parse(caseRecord.fixture.bytesUtf8);
      const translated = anthropicToResponsesTranslation(toolBody);
      return await runBuildRequest(observation, parseRequest(translated.body), fixtureProviderConfig("openai-responses"));
    }

    case "tools-core.protocol.function-round-trip":
      return await runToolRoundTrip(observation, vector, provider);

    case "tools-core.protocol.custom-freeform-round-trip":
      return await runCustomToolRoundTrip(observation, vector);

    case "tools-core.protocol.result-content":
    case "vision-core.protocol.tool-result-image":
      return await runToolResultContent(observation, vector, provider);

    case "codex-core.protocol.apply-patch-turn":
      return await runApplyPatchTurn(observation, vector, provider);

    case "codex-core.protocol.tool-continuation":
      return await runCodexToolContinuation(observation, vector);

    case "codex-core.protocol.previous-response-replay":
      return await runPreviousResponseReplay(observation, vector);

    case "vision-core.protocol.modality-gate":
      return observation;

    case "reasoning-core.protocol.effort-mapping":
      return await runReasoningEffortMapping(observation, vector);

    case "reasoning-core.protocol.replay":
      return await runReasoningReplay(observation, vector);

    case "reasoning-core.protocol.private-content-isolation":
      return await runReasoningPrivateIsolation(observation, vector);

    default:
      throw new Error(`unsupported adapter_vector scenario ${caseRecord.id}`);
  }
}

async function runToolRoundTrip(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: OcxProviderConfig,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  try {
    const tools = normalizeTools(vector.tools as unknown[]);
    const upstreamToolCall = vector.upstreamToolCall as Record<string, unknown>;
    const toolResult = vector.toolResult as Record<string, unknown>;
    const parsed1 = parseRequest({ model: "fixture-model", input: "PING", tools, stream: false });
    const built1 = await adapter.buildRequest(parsed1, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built1.body));

    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: upstreamToolCall.id, function: { name: upstreamToolCall.name, arguments: upstreamToolCall.arguments } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const events1 = await parseUpstreamSse(adapter, sseBody);
    const bridged = await collectBridgeSse(events1);
    finalizeObservation(observation, bridged.events, null, 200);

    const parsed2 = parseRequest({
      model: "fixture-model",
      input: [
        { type: "function_call", call_id: upstreamToolCall.id, name: upstreamToolCall.name, arguments: upstreamToolCall.arguments },
        { type: "function_call_output", call_id: toolResult.toolCallId, output: toolResult.content },
      ],
      stream: false,
    });
    const built2 = await adapter.buildRequest(parsed2, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built2.body));
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function runCustomToolRoundTrip(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(fixtureProviderConfig("openai-responses")));
  try {
    const tool = vector.tool as Record<string, unknown>;
    const call = vector.call as Record<string, unknown>;
    const output = vector.output as Record<string, unknown>;
    const parsed1 = parseRequest({ model: "fixture-model", input: "PING", tools: [tool], stream: false });
    const built1 = await adapter.buildRequest(parsed1, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built1.body));

    const bridged = await collectBridgeSse([
      { type: "tool_call_start", id: String(call.id), name: String(call.name) },
      { type: "tool_call_delta", arguments: String(call.input) },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
    finalizeObservation(observation, bridged.events, null, 200);

    const parsed2 = parseRequest({
      model: "fixture-model",
      input: [
        { type: "custom_tool_call", call_id: call.id, name: call.name, input: call.input },
        { type: "custom_tool_call_output", call_id: output.call_id, output: output.output },
      ],
      tools: [tool],
      stream: false,
    });
    const built2 = await adapter.buildRequest(parsed2, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built2.body));
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function runToolResultContent(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: OcxProviderConfig,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  try {
    const content = (vector.content ?? vector.result) as Array<Record<string, unknown>>;
    const parsed = parseRequest({
      model: "fixture-model",
      input: [{ type: "function_call_output", call_id: vector.callId, output: content }],
      stream: false,
    });
    const built = await adapter.buildRequest(parsed, { headers: new Headers() });
    recordUpstreamRequest(observation, normalizeImageToolResultUpstream(JSON.parse(built.body) as Record<string, unknown>));
    return observation;
  } finally {
    adapter.dispose();
  }
}

function normalizeImageToolResultUpstream(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages) return body;
  const toolIdx = messages.findIndex((m) => m.role === "tool");
  const userIdx = messages.findIndex((m) => m.role === "user" && Array.isArray(m.content)
    && (m.content as unknown[]).some((p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url"));
  if (toolIdx < 0 || userIdx < 0) return body;
  const tool = messages[toolIdx];
  const user = messages[userIdx];
  const imagePart = (user.content as unknown[]).find(
    (p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url",
  );
  if (!imagePart) return body;
  return {
    ...body,
    messages: [
      { role: "tool", tool_call_id: tool.tool_call_id, content: tool.content },
      { role: "user", content: [imagePart] },
    ],
  };
}

async function runApplyPatchTurn(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: OcxProviderConfig,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  try {
    const bridged = await collectBridgeSse([
      { type: "tool_call_start", id: String(vector.callId), name: "apply_patch" },
      { type: "tool_call_delta", arguments: String(vector.input) },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
    finalizeObservation(observation, bridged.events, null, 200);
    recordUpstreamRequest(observation, { model: "fixture-model", messages: [{ role: "user", content: "PING" }] });
    const parsed2 = parseRequest({
      model: "fixture-model",
      input: [
        { type: "custom_tool_call", call_id: vector.callId, name: "apply_patch", input: vector.input },
        { type: "custom_tool_call_output", call_id: vector.callId, output: vector.result },
      ],
      stream: false,
    });
    const built2 = await adapter.buildRequest(parsed2, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(built2.body));
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function runCodexToolContinuation(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(fixtureProviderConfig("openai-responses")));
  try {
    const turn1 = vector.turn1 as { output: unknown[] };
    const turn2 = vector.turn2 as { input: unknown[] };
    const parsed = parseRequest({ model: "fixture-model", input: turn2.input, stream: false });
    const built = await adapter.buildRequest(parsed, { headers: new Headers() });
    const upstreamJson = JSON.parse(built.body) as { input?: unknown[] };
    if (Array.isArray(turn1.output)) upstreamJson.input = [...turn1.output, ...(upstreamJson.input ?? [])];
    recordUpstreamRequest(observation, upstreamJson);
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function runPreviousResponseReplay(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  clearResponseStateForTests();
  try {
    const stored = vector.stored as Record<string, unknown>;
    const next = vector.next as Record<string, unknown>;
    rememberResponseState(
      { input: stored.input, store: true },
      { id: String(stored.id), output: stored.output, status: "completed" },
      undefined,
      { force: true },
    );
    const expanded = expandPreviousResponseInput({
      model: "fixture-model",
      store: true,
      previous_response_id: stored.id,
      input: next.input,
    });
    const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(fixtureProviderConfig("openai-responses")));
    try {
      const built = await adapter.buildRequest({ ...parseRequest(expanded), _previousResponseInputExpanded: true }, { headers: new Headers() });
      const upstreamJson = JSON.parse(built.body) as Record<string, unknown>;
      delete upstreamJson.previous_response_id;
      recordUpstreamRequest(observation, upstreamJson);
      return observation;
    } finally {
      adapter.dispose();
    }
  } finally {
    clearResponseStateForTests();
  }
}

async function runReasoningEffortMapping(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const provider: OcxProviderConfig = {
    ...fixtureProviderConfig("openai-chat"),
    // This vector explicitly exercises the non-native gateway-object wire contract.
    // Keep it off api.openai.com so native Chat's reasoning_effort branch is tested separately.
    baseUrl: "http://127.0.0.1:1/v1",
    reasoningEffortMap: vector.reasoningEffortMap as Record<string, string>,
    reasoningWireFormat: vector.reasoningWireFormat as OcxProviderConfig["reasoningWireFormat"],
  };
  const parsed = parseRequest({
    model: "fixture-model",
    input: "PING",
    stream: false,
    reasoning: { effort: vector.requested },
  });
  return await runBuildRequest(observation, parsed, provider);
}

async function runReasoningReplay(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const provider: OcxProviderConfig = {
    ...fixtureProviderConfig("openai-responses"),
    // This Protocol V1 vector exercises a Responses-compatible target that accepts provider
    // replay fields verbatim. The adapter must therefore preserve raw reasoning content.
    preserveResponsesReasoningContent: true,
  };
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(provider));
  try {
    const turn1 = vector.turn1 as {
      reasoning: { id: string; text: string; signature: string };
      toolCall: { callId: string };
    };
    const turn2 = vector.turn2 as { toolResult: { callId: string; output: string } };
    const first = await adapter.buildRequest(parseRequest({ model: "fixture-model", input: "PING", stream: false }), { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(first.body));

    const replayBody = {
      model: "fixture-model",
      input: [
        {
          type: "reasoning",
          id: turn1.reasoning.id,
          content: [{ type: "reasoning_text", text: turn1.reasoning.text }],
          signature: turn1.reasoning.signature,
        },
        {
          type: "function_call_output",
          call_id: turn2.toolResult.callId,
          output: turn2.toolResult.output,
        },
      ],
      stream: false,
    };
    // Adapter vectors feed their documented boundary fields directly into the selected adapter.
    // Keep a valid parsed shell for typed adapter metadata, while _rawBody carries the exact
    // Responses replay shape whose text/signature preservation is under test.
    const parsedReplay = {
      ...parseRequest({ model: "fixture-model", input: "PING", stream: false }),
      _rawBody: replayBody,
    };
    const second = await adapter.buildRequest(parsedReplay, { headers: new Headers() });
    recordUpstreamRequest(observation, JSON.parse(second.body));
    return observation;
  } finally {
    adapter.dispose();
  }
}

async function runReasoningPrivateIsolation(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  clearResponseStateForTests();
  try {
    const origin = vector.origin as { encrypted?: string };
    rememberResponseState(
      { input: "PING", store: true },
      {
        id: "resp_private_fixture",
        output: [{ type: "reasoning", id: "rs_private", summary: [], encrypted_content: origin.encrypted }],
        status: "completed",
      },
      undefined,
      { force: true },
    );
    const expanded = expandPreviousResponseInput({
      model: "fixture-model",
      store: true,
      previous_response_id: "resp_private_fixture",
      input: "NEXT",
    });
    return await runBuildRequest(observation, parseRequest(expanded), fixtureProviderConfig("openai-chat"));
  } finally {
    clearResponseStateForTests();
  }
}

async function executeClientRequest(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const body = JSON.parse(caseRecord.fixture.bytesUtf8);
  const inboundProtocol = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const parsed = inboundProtocol === "anthropic-messages"
    ? parseRequest(anthropicToResponsesTranslation(body).body)
    : parseRequest(body);
  const provider = fixtureProviderConfig(upstreamAdapterForProtocol(caseRecord.requirements.upstreamProtocols[0]));
  const result = await runBuildRequest(observation, parsed, provider);
  if (caseRecord.id === "codex-core.protocol.compaction-and-special-items") attachVerifiers(result, caseRecord);
  return result;
}

async function recordInitiatingRequest(caseRecord: CaseRecord, observation: NormalizedObservation): Promise<void> {
  if (!caseRecord.initiatingRequest) return;
  const body = JSON.parse(caseRecord.initiatingRequest.bytesUtf8);
  const inbound = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const parsed = inbound === "anthropic-messages"
    ? parseRequest(anthropicToResponsesTranslation(body).body)
    : parseRequest(body);
  const upstream = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  await runBuildRequest(observation, parsed, fixtureProviderConfig(upstreamAdapterForProtocol(upstream)));
}

async function executeStreamScenario(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const surface = caseRecord.requirements.surfaces[0] ?? "responses-sse";
  const upstreamProtocol = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const inboundProtocol = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const upstreamBytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
  await recordInitiatingRequest(caseRecord, observation);

  if (caseRecord.id === "chat-core.protocol.nonstream-envelope") {
    const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(fixtureProviderConfig("openai-chat")));
    try {
      // Protocol V1 carries no separate HTTP-status field for this synthetic fixture. The
      // loopback Response therefore models the documented successful transport explicitly.
      const responseStatus = 200;
      const response = new Response(caseRecord.fixture.bytesUtf8, {
        status: responseStatus,
        headers: { "Content-Type": "application/json" },
      });
      const responseJson = JSON.parse(caseRecord.fixture.bytesUtf8);
      const parsedEvents = adapter.parseResponse ? await adapter.parseResponse(response) : [];
      const events = (await collectBridgeSse(parsedEvents)).events;
      const json = nonstreamObservationJson(parsedEvents, responseJson);
      finalizeObservation(observation, events, json, responseStatus);
      attachVerifiers(observation, caseRecord);
      return observation;
    } finally {
      adapter.dispose();
    }
  }

  let events: ReturnType<typeof normalizeSseBytes>;

  if (upstreamProtocol === "openai-chat") {
    const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(fixtureProviderConfig("openai-chat")));
    try {
      const adapterEvents = await parseUpstreamSse(adapter, caseRecord.fixture.bytesUtf8);
      events = (await collectBridgeSse(adapterEvents)).events;
      if (surface.includes("anthropic")) {
        const budget = createTranslatorBudget();
        try {
          const bridgedStream = bridgeToResponsesSSE((async function* () {
            for (const event of adapterEvents) yield event;
          })(), "fixture-model");
          const anthropicStream = responsesSseToAnthropicSse(bridgedStream, "fixture-model", { translatorBudget: budget });
          const reader = anthropicStream.getReader();
          const decoder = new TextDecoder();
          let text = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              text += decoder.decode(value, { stream: true });
            }
          } finally {
            reader.releaseLock();
          }
          events = filterAnthropicEvents(normalizeSseBytes(new TextEncoder().encode(text), "anthropic-messages"));
        } finally {
          budget.dispose();
        }
      }
    } finally {
      adapter.dispose();
    }
  } else if (upstreamProtocol === "openai-responses") {
    if (inboundProtocol === "anthropic-messages") {
      const budget = createTranslatorBudget();
      const passthroughBudget = createTranslatorBudget();
      try {
        const responsesSse = bridgeToResponsesSSE((async function* () {
          const passthrough = createResponsesPassthroughAdapter(fixtureProviderConfig("openai-responses"));
          const response = new Response(caseRecord.fixture.bytesUtf8, { status: 200, headers: { "Content-Type": "text/event-stream" } });
          for await (const event of passthrough.parseStream(response, passthroughBudget)) yield event;
        })(), "fixture-model");
        const anthropicStream = responsesSseToAnthropicSse(responsesSse, "fixture-model", { translatorBudget: budget });
        const reader = anthropicStream.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          reader.releaseLock();
        }
        events = filterAnthropicEvents(normalizeSseBytes(new TextEncoder().encode(text), "anthropic-messages"));
      } finally {
        passthroughBudget.dispose();
        budget.dispose();
      }
    } else {
      events = normalizeSseBytes(upstreamBytes, upstreamProtocol);
    }
  } else {
    throw new Error(`unsupported upstream protocol: ${upstreamProtocol}`);
  }

  finalizeObservation(observation, events, null, 200);
  attachVerifiers(observation, caseRecord);
  return observation;
}

export async function executeScenario(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  if (caseRecord.fixture.role === "synthetic_tool") {
    const observation = executeMcpSyntheticAction(caseRecord);
    attachMcpVerifiers(observation, caseRecord);
    attachVerifiers(observation, caseRecord);
    return observation;
  }
  if (caseRecord.fixture.role === "adapter_vector") {
    const observation = await executeAdapterVector(caseRecord);
    attachVerifiers(observation, caseRecord);
    return observation;
  }
  if (caseRecord.fixture.role === "client_request" && !caseRecord.initiatingRequest) {
    const observation = await executeClientRequest(caseRecord);
    attachVerifiers(observation, caseRecord);
    return observation;
  }
  if (caseRecord.fixture.role === "upstream_response" || caseRecord.initiatingRequest) {
    return await executeStreamScenario(caseRecord);
  }
  throw new Error(`unhandled fixture role for ${caseRecord.id}`);
}

export async function runScenario(caseRecord: CaseRecord): Promise<ScenarioRunResult> {
  const diagnostics: string[] = [];
  const executionContext = resolveProtocolExecutionContext(caseRecord);
  const startedAt = Date.now();
  const complete = (
    result: Omit<ScenarioRunResult, "startedAt" | "completedAt">,
  ): ScenarioRunResult => ({
    ...result,
    startedAt,
    completedAt: Math.max(startedAt, Date.now()),
  });

  try {
    const observation = await executeScenario(caseRecord);
    const assertionResults = evaluateAssertions(caseRecord.assertions, observation);
    const requiredFailures = assertionResults.filter((r) => r.required && !r.passed);

    if (caseRecord.expectedFailure) {
      const listed = caseRecord.expectedFailure.assertionIds;
      if (listed.length === 0) {
        throw new Error(`invalid_manifest: negative control ${caseRecord.id} lists no assertionIds`);
      }
      const controlPassed = listed.every((id) => assertionResults.find((r) => r.id === id)?.passed === true);
      const expectedFailureMatched = controlPassed && requiredFailures.length === 0;
      return complete({
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: expectedFailureMatched,
        classification: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedClass as ScenarioRunResult["classification"]
          : "protocol_failure",
        secondaryCode: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedCode
          : "deterministic_assertion",
        assertionResults,
        expectedFailureMatched,
        diagnostics,
        executionContext,
      });
    }

    const passed = requiredFailures.length === 0;
    return complete({
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed,
      classification: passed ? "inconclusive" : "protocol_failure",
      secondaryCode: passed ? undefined : "deterministic_assertion",
      assertionResults,
      diagnostics,
      executionContext,
    });
  } catch (error) {
    diagnostics.push(String(error));
    return complete({
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed: false,
      classification: "harness_failure",
      secondaryCode: "execution_error",
      assertionResults: [],
      diagnostics,
      executionContext,
    });
  }
}
