import { createHash } from "node:crypto";
import { saveCredential } from "../../src/oauth/store";
import { messagesConversationToIr } from "../../src/protocols/codecs/messages-ir";
import { DesktopModelMappingUnavailableError } from "../../src/claude/inbound-records";
import { messageThreadUnsupportedResponse } from "../../src/claude/message-threads";
import { workflowRefusalResponse } from "../../src/server/workflow-refusal";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { AnthropicAccountCooldownError } from "../../src/oauth/anthropic-routing";
import { OAuthAccountPausedError } from "../../src/oauth/oauth-errors";
import { NativeOAuthModelRouteError } from "../../src/server/messages-native-oauth";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { saveConfig } from "../../src/config";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { collectAnthropicMessageResponse, encodeAnthropicMessageSse, foldAnthropicMessage } from "../../src/protocols/encoders/messages";
import { responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { createTranslatorBudget, type TranslatorBudget } from "../../src/lib/translator-budget";
import { acquireOwnedSpendHome } from "./owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { AdapterEvent, OcxConfig } from "../../src/types";
import type { MessagesOverflowFixture, MessagesOverflowLane } from "./messages-overflow-cases";

export const overflowSentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
export const compactionSentence = "prompt is too long: The request exceeds the model's context window.";
export const clientRecognizesOverflow = (message: string) => {
  const text = message.toLowerCase();
  return text.includes("prompt is too long") || text.includes("input is too long for requested model");
};
// APIError.makeMessage selects a top-level message before JSON-stringifying the body.
function sdkMessage(text: string, parsed: any): string {
  return parsed?.message ? typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed.message)
    : parsed ? JSON.stringify(parsed) : text;
}
/** Observe client bytes before diagnostic decoding; only literal generated-id cases normalize. */
export async function observeMessagesOverflowBody(response: Response, lane: MessagesOverflowLane, fixture: MessagesOverflowFixture) {
  const rawBytes = new Uint8Array(await response.arrayBuffer());
  let text = new TextDecoder().decode(rawBytes);
  let parityBytes = rawBytes;
  if (fixture.idNormalization?.[lane] === "message.id") {
    if (lane !== "translated-http" && lane !== "translated-json") throw new Error(`Unexpected generated-id normalization on ${lane}`);
    // These literal cases generate only the top-level Messages id; all other bytes stay exact.
    const generatedId = /^(\{"id":")msg_(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=")/;
    const match = generatedId.exec(text);
    if (!match || rawBytes[0] !== 123) throw new Error(`Missing generated message.id on ${lane}/${fixture.id}`);
    parityBytes = Buffer.concat([rawBytes.subarray(0, match[1]!.length), Buffer.from("msg_fixture"), rawBytes.subarray(match[0].length)]);
    text = new TextDecoder().decode(parityBytes);
  }
  const bodySha256 = createHash("sha256").update(parityBytes).digest("hex");
  const bodyLength = parityBytes.byteLength;
  return { text, bodySha256, bodyLength };
}

/** A slice may lend its real spend owner; single-case callers retain their own lease. */
export async function runMessagesOverflowCase(
  lane: MessagesOverflowLane,
  fixture: MessagesOverflowFixture,
  acquireSpendHome: () => () => void = acquireOwnedSpendHome,
) {
  const tail = (fixture.messageStop || fixture.id.startsWith("frame-complete-")) ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : "";
  const prefix = fixture.prefix ? `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: fixture.prefix } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` : "";
  const error = { ...(fixture.type ? { type: fixture.type } : {}), ...(fixture.status !== undefined ? { status: fixture.status } : {}), message: `${fixture.message} ${overflowSentinel}`, ...(fixture.code !== undefined ? { code: fixture.code } : {}) };
  const makeFault = () => {
    if (fixture.thrown === "array") return [fixture.message, overflowSentinel];
    if (fixture.thrown === "object") return { message: fixture.message, detail: overflowSentinel };
    if (fixture.thrown === "error-subclass") return new class extends Error { constructor() { super(fixture.message); this.name = "FixtureFailure"; } }();
    const fault = fixture.fault;
    const value = fault === "budget" ? new TranslatorBudgetExceededError("live_transient", 1024)
      : fault === "send-budget" ? new SendBudgetExhaustedError()
      : fault === "usage-limit" ? new AnthropicAccountCooldownError(2, undefined, { resetsAt: 0 })
      : fault === "paused" ? new OAuthAccountPausedError()
      : fault === "model-route" ? new NativeOAuthModelRouteError(`Invalid Anthropic model routes: ${fixture.message}`)
      : new Error(fixture.message);
    if (fault === "read-budget") Object.assign(value, { code: "translation_buffer_limit" });
    Object.assign(value, { detail: fixture.other });
    return value;
  };
  const bodyStream = (text: string) => fixture.fault?.startsWith("read")
    ? (() => { let sent = false; return new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(text.slice(0, 1) || ": fixture\n\n")); } else controller.error(makeFault()); } }); })() : new Response(text).body!;
  const responseEvent = fixture.responseStatus === "unfinished" ? "response.completed" : fixture.responseStatus === "incomplete" ? "response.incomplete" : "response.failed";
  const responseRecord = fixture.responseStatus === "unfinished" ? { status: "completed", end_turn: false, message: fixture.message, detail: fixture.other } : fixture.responseStatus === "incomplete" ? { status: "incomplete", incomplete_details: { reason: "other", message: fixture.message, detail: fixture.other } }
    : (lane === "converter" || lane === "translated-fold") && fixture.rawBody ? JSON.parse(fixture.rawBody) : { error: { ...error, ...(fixture.other ? { detail: fixture.other } : {}) } };
  const previousFetch = globalThis.fetch; let changedFetch = false;
  let response: Response;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let release: (() => void) | undefined;
  let translatorBudget: TranslatorBudget | undefined;
  try {
    if (lane === "local-envelope") {
      const hooks = await import("../../src/server/claude-messages") as any;
      const branch = fixture.localBranch;
      const error = fixture.thrown ? makeFault() : Object.assign(new Error(fixture.message), { detail: fixture.other, ...(branch?.startsWith("read-budget-") ? { code: "translation_buffer_limit" } : {}) });
      if (branch === "count-read-catch" || branch?.startsWith("read-") || branch?.startsWith("role-") || branch?.startsWith("policy-")) {
        const body = { model: "fixture/wire-model", max_tokens: 16, messages: [{ role: fixture.roleValue ?? fixture.message, content: "fixture" }], metadata: { detail: fixture.other } };
        if (branch.startsWith("policy-")) { body.model = `policy/${fixture.message}`; body.messages[0]!.role = "user"; }
        if (branch === "role-ir") {
          translatorBudget = createTranslatorBudget();
          try { messagesConversationToIr(body, undefined, translatorBudget, "wire-model"); throw new Error("Role fixture was unexpectedly accepted"); }
          catch (error) { response = hooks.__messagesSweepTranslation(error, { model: "fixture", provider: "fixture" }); }
        } else {
          const req = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: branch.startsWith("read-") ? new ReadableStream({ pull(controller) { controller.error(error); } }) : JSON.stringify(body) });
          const config = { defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKey: "fixture", models: ["wire-model"], fetch: async () => { throw new Error("Local input fixture must not send"); } } }, ...(branch === "policy-empty" ? { routingProfiles: { [fixture.message]: { candidates: [] } } } : {}) } as unknown as OcxConfig;
          if (branch === "count-read-catch") (globalThis as any).__messagesReadFailure = { value: error };
          response = branch === "count-read-catch" || branch.endsWith("count") ? await handleClaudeCountTokens(req, config) : await handleClaudeMessages(req, config, { model: "fixture", provider: "fixture" });
        }
      } else response = branch === "desktop" ? hooks.__messagesSweepDesktop(new DesktopModelMappingUnavailableError())
        : branch === "thread" ? messageThreadUnsupportedResponse()
        : branch === "workflow" ? workflowRefusalResponse("workflow-spend-exhausted")
        : branch === "disabled" ? hooks.__messagesSweepDisabled({ providers: {}, apiSurfaces: { messages: { enabled: false } } })
        : hooks.__messagesSweepTranslation(branch === "translation-budget" ? new TranslatorBudgetExceededError("live_transient", 1024) : error, { model: "fixture", provider: "fixture" });
    } else if (["converter", "direct-stream", "direct-fold", "direct-collector"].includes(lane)) {
      const events = () => (async function* () { if (fixture.fault) throw makeFault(); yield (fixture.responseStatus === "unfinished" ? { type: "done", endTurn: false } : fixture.responseStatus === "incomplete" ? { type: "incomplete", reason: "other", message: fixture.message } : { ...error, type: "error", errorType: fixture.type }) as AdapterEvent; })();
      translatorBudget = createTranslatorBudget();
      if (lane === "direct-fold") response = await foldAnthropicMessage(events(), { model: "fixture", translatorBudget });
      else if (lane === "direct-collector") response = await collectAnthropicMessageResponse(bodyStream(`${prefix}event: error\ndata: ${fixture.rawBody ?? JSON.stringify({ type: "error", error: { ...error, ...(fixture.other ? { detail: fixture.other } : {}) } })}\n\n${tail}`), "fixture", translatorBudget);
      else response = new Response(lane === "converter"
        ? responsesSseToAnthropicSse(bodyStream(`event: ${responseEvent}\ndata: ${JSON.stringify({ type: responseEvent, response: responseRecord })}\n\n`), "fixture", { translatorBudget, pingIntervalMs: 0 })
        : encodeAnthropicMessageSse(events(), { model: "fixture", translatorBudget }));
    } else {
      const passthrough = lane === "passthrough" || lane === "count_tokens";
      const native = lane.startsWith("native");
      release = acquireSpendHome(); clearKeyCooldowns();
      const builtin = lane === "native-fold-builtin";
      const nativeFold = lane === "native-fold" || builtin;
      const reply = () => {
        if (fixture.thrown && lane === "translated-fold") return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","end_turn":true,"output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
        if (fixture.toolGuard) {
          const name = fixture.id.endsWith("phrase") ? fixture.message : "undeclared_fixture";
          return nativeFold ? new Response(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fixture", name, input: {} } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, { headers: { "content-type": "text/event-stream" } })
            : Response.json({ type: "message", content: [{ type: "tool_use", id: "fixture", name, input: {} }], detail: fixture.other });
        }
        if (nativeFold || lane.endsWith("fold")) return new Response(bodyStream(native
          ? `${prefix}event: error\ndata: ${fixture.rawBody ?? JSON.stringify({ type: "error", error: { ...error, ...(fixture.other ? { detail: fixture.other } : {}) } })}\n\n${tail}`
          : `event: ${responseEvent}\ndata: ${JSON.stringify({ type: responseEvent, response: responseRecord })}\n\n`), { headers: { "content-type": "text/event-stream" } });
        if (fixture.rawBytes) return new Response(new Uint8Array(fixture.rawBytes), { status: fixture.status ?? 200, headers: { "content-type": fixture.mediaType ?? "text/plain" } });
        if (fixture.rawBody !== undefined) return new Response(fixture.rawBody, { status: fixture.status ?? 200, headers: { "content-type": fixture.mediaType ?? "application/json" } });
        if (lane === "translated-json") return new Response(bodyStream(JSON.stringify((fixture.responseStatus === "incomplete" || fixture.responseStatus === "unfinished") ? responseRecord : { status: "failed", error: { ...error, ...(fixture.other ? { detail: fixture.other } : {}) } })), { headers: { "content-type": "application/json" } });
        if (fixture.fault?.startsWith("read")) return new Response(bodyStream(""), { headers: { "content-type": "application/json" } });
        return Response.json({ type: "error", error: { ...error, ...(fixture.other ? { detail: fixture.other } : {}) } }, { status: fixture.status ?? 400 });
      };
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply });
      if (builtin) await saveCredential("anthropic", { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000, source: "oauth", accountId: "synthetic-account" });
      let mockSends = 0;
      if (passthrough && fixture.fault === "connect") { changedFetch = true; globalThis.fetch = (async () => { mockSends++; throw makeFault(); }) as typeof fetch; }
      const providerName = builtin ? "anthropic" : "fixture";
      const config = (passthrough ? { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } }
        : { defaultProvider: providerName, providers: { [providerName]: { adapter: native ? "anthropic" : "openai-responses", baseUrl: builtin ? "https://api.anthropic.com" : upstream.url.toString(), authMode: builtin ? "oauth" : "key", apiKey: "fixture", ...((builtin || fixture.fault) ? { fetch: async () => { mockSends++; if (fixture.fault && !fixture.fault.startsWith("read")) throw makeFault(); return reply(); } } : {}), allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: native, managedMessagesNativeOAuth: builtin } } }) as OcxConfig;
      let replayCalls = 0;
      if (fixture.fault?.startsWith("read") && lane.startsWith("translated")) (globalThis as any).__messagesReplayResponse = () => { replayCalls++; return lane === "translated-http" ? new Response(bodyStream(""), { status: 400, headers: { "content-type": "application/json" } }) : reply(); };
      if (fixture.thrown && lane === "translated-fold") (globalThis as any).__messagesCollectorStream = bodyStream("");
      saveConfig(config);
      const request = new Request(`http://localhost/v1/messages${lane === "count_tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: { "content-type": "application/json", ...(passthrough ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}) }, body: JSON.stringify({ model: passthrough ? "claude-sonnet-4-6" : `${providerName}/wire-model`, max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }], ...(fixture.toolGuard ? { tools: [] } : {}) }) });
      response = lane === "count_tokens" ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
      if (fixture.fault?.startsWith("read") && lane.startsWith("translated")) { if (!replayCalls) throw new Error("Replay fixture did not exercise its response boundary"); }
      else if ((builtin || fixture.fault) && mockSends === 0) throw new Error("Builtin fixture did not use its local fetch callback");
    }
    const { text, bodySha256, bodyLength } = await observeMessagesOverflowBody(response, lane, fixture);
    const stream = lane === "converter" || lane === "direct-stream";
    let payload: any;
    try { payload = JSON.parse(stream ? text.split("data: ").at(-1)! : text); } catch { /* non-JSON bodies are observed as text */ }
    const collectedErrorEvent = fixture.eventLanes?.includes(lane) === true;
    const clientError = !response.ok || collectedErrorEvent || (stream && text.includes("event: error\n"));
    const message = clientError ? sdkMessage(text, payload) : "";
    return { status: response.status, clientError, envelopeType: payload?.type, mediaType: response.headers.get("content-type"),
      type: typeof payload?.error?.type === "string" ? payload.error.type : undefined,
      code: payload?.error?.code as string | undefined, text, message,
      clientRecognizes: clientError && clientRecognizesOverflow(message),
      compactionSentence: payload?.error?.message === compactionSentence, bodySha256, bodyLength };

  } finally { if (changedFetch) globalThis.fetch = previousFetch; delete (globalThis as any).__messagesReplayResponse; delete (globalThis as any).__messagesCollectorStream; delete (globalThis as any).__messagesReadFailure; translatorBudget?.dispose(); release?.(); await upstream?.stop(true); }
}
