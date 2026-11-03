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
export async function runMessagesOverflowCase(lane: MessagesOverflowLane, fixture: MessagesOverflowFixture) {
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
      else if (lane === "direct-collector") response = await collectAnthropicMessageResponse(new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`).body!, "fixture", translatorBudget);
      else response = new Response(lane === "converter"
        ? responsesSseToAnthropicSse(new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`).body!, "fixture", { translatorBudget, pingIntervalMs: 0 })
        : encodeAnthropicMessageSse(events(), { model: "fixture", translatorBudget }));
    } else {
      const passthrough = lane === "passthrough" || lane === "count_tokens";
      const native = lane.startsWith("native");
      release = acquireOwnedSpendHome(); clearKeyCooldowns();
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        if (lane.endsWith("fold")) return new Response(native
          ? `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`
          : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        if (lane === "translated-json") return Response.json({ status: "failed", error });
        return Response.json({ type: "error", error }, { status: fixture.status ?? 400 });
      } });
      const config = (passthrough ? { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } }
        : { defaultProvider: "fixture", providers: { fixture: { adapter: native ? "anthropic" : "openai-responses", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: native } } }) as OcxConfig;
      saveConfig(config);
      const request = new Request(`http://localhost/v1/messages${lane === "count_tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: { "content-type": "application/json", ...(passthrough ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}) }, body: JSON.stringify({ model: passthrough ? "claude-sonnet-4-6" : "fixture/wire-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) });
      response = lane === "count_tokens" ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
    }
    const text = await response.text();
    const payload = lane === "converter" || lane === "direct-stream" ? JSON.parse(text.split("data: ").at(-1)!) : JSON.parse(text);
    if (typeof payload.error?.message !== "string") throw new Error(`Missing error message for ${lane}/${fixture.id}`);
    return { status: response.status, type: payload.error.type as string, code: payload.error.code as string | undefined,
      text, message: payload.error.message as string, clientRecognizes: clientRecognizesOverflow(payload.error.message),
      compactionSentence: payload.error.message === compactionSentence };
  } finally { translatorBudget?.dispose(); release?.(); await upstream?.stop(true); }
}
