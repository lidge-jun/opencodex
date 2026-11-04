import { saveCredential } from "../../src/oauth/store";
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
export async function runMessagesOverflowCase(lane: MessagesOverflowLane, fixture: MessagesOverflowFixture) {
  const tail = (fixture.messageStop || fixture.id.startsWith("frame-complete-")) ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : "";
  const prefix = fixture.prefix ? `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: fixture.prefix } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` : "";
  const error = { ...(fixture.type ? { type: fixture.type } : {}), ...(fixture.status !== undefined ? { status: fixture.status } : {}), message: `${fixture.message} ${overflowSentinel}`, ...(fixture.code !== undefined ? { code: fixture.code } : {}) };
  let response: Response;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let release: (() => void) | undefined;
  let translatorBudget: TranslatorBudget | undefined;
  try {
    if (["converter", "direct-stream", "direct-fold", "direct-collector"].includes(lane)) {
      const events = () => (async function* () { yield { ...error, type: "error", errorType: fixture.type } as AdapterEvent; })();
      translatorBudget = createTranslatorBudget();
      if (lane === "direct-fold") response = await foldAnthropicMessage(events(), { model: "fixture", translatorBudget });
      else if (lane === "direct-collector") response = await collectAnthropicMessageResponse(new Response(`${prefix}event: error\ndata: ${fixture.rawBody ?? JSON.stringify({ type: "error", error })}\n\n${tail}`).body!, "fixture", translatorBudget);
      else response = new Response(lane === "converter"
        ? responsesSseToAnthropicSse(new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: fixture.rawBody ? JSON.parse(fixture.rawBody) : { error } })}\n\n`).body!, "fixture", { translatorBudget, pingIntervalMs: 0 })
        : encodeAnthropicMessageSse(events(), { model: "fixture", translatorBudget }));
    } else {
      const passthrough = lane === "passthrough" || lane === "count_tokens";
      const native = lane.startsWith("native");
      release = acquireOwnedSpendHome(); clearKeyCooldowns();
      const builtin = lane === "native-fold-builtin";
      const nativeFold = lane === "native-fold" || builtin;
      const reply = () => {
        if (nativeFold || lane.endsWith("fold")) return new Response(native
          ? `${prefix}event: error\ndata: ${fixture.rawBody ?? JSON.stringify({ type: "error", error })}\n\n${tail}`
          : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: fixture.rawBody ? JSON.parse(fixture.rawBody) : { error } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        if (fixture.rawBody !== undefined) return new Response(fixture.rawBody, { status: fixture.status ?? 200, headers: { "content-type": fixture.mediaType ?? "application/json" } });
        if (lane === "translated-json") return Response.json({ status: "failed", error });
        return Response.json({ type: "error", error }, { status: fixture.status ?? 400 });
      };
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply });
      if (builtin) await saveCredential("anthropic", { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000, source: "oauth", accountId: "synthetic-account" });
      let mockSends = 0;
      const providerName = builtin ? "anthropic" : "fixture";
      const config = (passthrough ? { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } }
        : { defaultProvider: providerName, providers: { [providerName]: { adapter: native ? "anthropic" : "openai-responses", baseUrl: builtin ? "https://api.anthropic.com" : upstream.url.toString(), authMode: builtin ? "oauth" : "key", apiKey: "fixture", ...(builtin ? { fetch: async () => { mockSends++; return reply(); } } : {}), allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: native, managedMessagesNativeOAuth: builtin } } }) as OcxConfig;
      saveConfig(config);
      const request = new Request(`http://localhost/v1/messages${lane === "count_tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: { "content-type": "application/json", ...(passthrough ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}) }, body: JSON.stringify({ model: passthrough ? "claude-sonnet-4-6" : `${providerName}/wire-model`, max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) });
      response = lane === "count_tokens" ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
      if (builtin && mockSends === 0) throw new Error("Builtin fixture did not use its local fetch callback");
    }
    const text = (await response.text()).replace(/msg_(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g, "msg_fixture");
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
      compactionSentence: payload?.error?.message === compactionSentence };

  } finally { translatorBudget?.dispose(); release?.(); await upstream?.stop(true); }
}
