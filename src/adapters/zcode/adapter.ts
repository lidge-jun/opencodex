import { refreshAccount } from "./account-runtime";
import { createHash } from "node:crypto";
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ZcodeClient } from "./client";
import { loadZcodeSettings, readZcodeModels, record, type JsonObject, type ZcodeSettings } from "./settings";

type Client = Pick<ZcodeClient, "request" | "close" | "onEvent" | "onFailure">;
export interface ZcodeAdapterDeps {
  settings?: () => ZcodeSettings;
  client?: (settings: ZcodeSettings) => Client;
  timeoutMs?: number;
}

// ZCode persists model selection in its settings file: serialize the whole profile, not just a
// session. Each turn owns a child; completing/cancelling it cannot kill another conversation.
const locks = new Map<string, Promise<void>>();
const sessions = new Map<string, string>();
let reservations = 0;
async function lock(key: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error("ZCode request cancelled before dispatch.");
  if (reservations >= 32) throw new Error("ZCode profile queue is full.");
  reservations++;
  const previous = locks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; reservations--; unlock();
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  };
  let onAbort = () => {};
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("ZCode request cancelled before dispatch."));
      signal?.addEventListener("abort", onAbort, { once: true });
    })]);
    if (signal?.aborted) throw new Error("ZCode request cancelled before dispatch.");
  } catch (error) { release(); throw error; }
  finally { signal?.removeEventListener("abort", onAbort); }
  return release;
}

function textInput(parsed: OcxParsedRequest, resumed: boolean): string {
  const messages = parsed.context.messages;
  const current = resumed ? messages.slice(parsed._continuationConversationMessageIndex ?? -1) : messages;
  const lines = current.map(message => {
    if (message.role === "toolResult") throw new Error("ZCode executes its own tools; client tool results are unsupported.");
    const content = typeof message.content === "string" ? message.content : message.content.map(part => {
      if (part.type !== "text") throw new Error("ZCode bridge currently accepts text only.");
      return part.text;
    }).join("\n");
    return `${message.role}: ${content}`;
  });
  const prompt = [...(parsed.context.systemPrompt ?? []), ...lines].join("\n\n");
  if (!prompt.trim() || prompt.length > 200_000) throw new Error("ZCode input is empty or exceeds the bridge limit.");
  return prompt;
}

export function createZcodeAdapter(provider: OcxProviderConfig, deps: ZcodeAdapterDeps = {}): ProviderAdapter {
  return {
    name: "zcode",
    replaySafe: false,
    allowExternalSidecars: false,
    allowVisionSidecar: true,
    buildRequest() { throw new Error("ZCode uses its local app-server transport, not HTTP."); },
    async *parseStream() { yield { type: "error", message: "ZCode requires runTurn.", retryable: false }; },
    async runTurn(parsed, incoming, emit) {
      let client: Client | undefined;
      let release: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let sent = false;
      let sessionId: string | undefined;
      let sessionKey: string | undefined;
      let stop = () => {};
      const cancelled = () => stop();
      try {
        if (provider.zcodeAccountId && !deps.settings) await refreshAccount(provider.zcodeAccountId);
        let settings: ZcodeSettings;
        try { settings = (deps.settings ?? (() => loadZcodeSettings(process.env, provider.zcodeAccountId)))(); }
        catch { throw new Error("ZCode native execution is unavailable. Configure the isolated launcher, home, workspace and explicit opt-in."); }
        if (provider.authMode !== "local") throw new Error("ZCode requires local authentication mode; log in using the isolated ZCode client.");
        const model = readZcodeModels(settings).find(item => item.id === parsed.modelId);
        if (!model) throw new Error("ZCode model is unavailable in the isolated settings.");
        if (parsed.options.toolChoice && parsed.options.toolChoice !== "auto") {
          throw new Error("ZCode owns its tools and does not support client tool_choice constraints.");
        }
        release = await lock(settings.scope, incoming.abortSignal);
        // A queued turn must not resurrect a revoked Desktop connection or old login.
        if (settings.desktopModels && (deps.settings ?? (() => loadZcodeSettings(process.env, provider.zcodeAccountId)))().scope !== settings.scope) {
          throw new Error("ZCode Desktop connection changed while this turn was queued.");
        }
        const scope = createHash("sha256").update(JSON.stringify([
          settings.scope, provider.baseUrl, parsed._reasoningReplayScope?.current?.providerName,
          parsed._cursorIdentityScope, parsed.modelId,
        ])).digest("hex");
        sessionKey = parsed._clientThreadId && !parsed._cursorIsolateConversation
          ? createHash("sha256").update(scope + parsed._clientThreadId).digest("hex") : undefined;
        const previous = record(parsed._providerContinuation?.zcode);
        sessionId = previous.scope === scope && typeof previous.sessionId === "string"
          && /^sess_[a-zA-Z0-9-]{1,80}$/.test(previous.sessionId) ? previous.sessionId
          : sessionKey ? sessions.get(sessionKey) : undefined;
        const content = textInput(parsed, Boolean(sessionId));
        client = (deps.client ?? (s => new ZcodeClient(s)))(settings);
        const active = client;
        // The Desktop bootstrap resolves credentials INSIDE the sandbox. The parent only sends
        // public model identity; it never receives Desktop API keys or synthesizes vendor auth.
        const modelParams = settings.desktopModels
          ? { _zcodeModel: { providerId: model.providerId, modelId: model.modelId } }
          : { runtimeModel: model.runtimeModel };
        const controller = Promise.withResolvers<void>();
        // Attach a handler immediately: failures can happen during session materialization.
        void controller.promise.catch(() => {});
        stop = () => { controller.reject(new Error("ZCode turn cancelled or timed out.")); void active.close(); };
        incoming.abortSignal?.addEventListener("abort", cancelled, { once: true });
        if (incoming.abortSignal?.aborted) throw new Error("ZCode request cancelled before dispatch.");
        timer = setTimeout(stop, deps.timeoutMs ?? 300_000);
        heartbeat = setInterval(() => emit({ type: "heartbeat" }), 5_000);
        active.onFailure = error => controller.reject(error);
        let textSeen = false;
        active.onEvent = message => {
          const params = record(message.params);
          if (message.method !== "session/event") return;
          if (typeof params.sessionId !== "string" || params.sessionId !== sessionId) return;
          const payload = record(params.payload);
          if (params.type === "model.streaming") {
            if ((payload.kind === "text_delta" || payload.kind === "text_start") && typeof payload.delta === "string") {
              textSeen ||= payload.delta.length > 0;
              emit({ type: "text_delta", text: payload.delta, phase: "final_answer" });
            } else if ((payload.kind === "reasoning_delta" || payload.kind === "reasoning_start") && typeof payload.delta === "string") {
              emit({ type: "thinking_delta", thinking: payload.delta });
            }
          } else if (params.type === "tool.updated") {
            // Informational only: no tool_call_* event can cause a client to repeat native work.
            if (payload.kind === "started" || payload.kind === "result") emit({ type: "text_delta",
              text: payload.kind === "started" ? "\n[ZCode: native tool started]\n" : "\n[ZCode: native tool finished]\n",
              phase: "commentary" });
          } else if (params.type === "turn.completed") {
            if (!textSeen && typeof payload.response === "string") emit({ type: "text_delta", text: payload.response, phase: "final_answer" });
            controller.resolve();
          } else if (params.type === "turn.failed") {
            controller.reject(new Error("ZCode agent turn failed. Inspect the isolated client for authentication, quota or model errors."));
          }
        };
        if (sessionId) {
          await active.request("session/resume", { sessionId, ...modelParams });
        } else {
          const result = await active.request("session/create", {
            workspace: { workspacePath: settings.workspace, workspaceKey: settings.workspace },
            mode: "edit", ...modelParams, titleGenerationEnabled: false,
            mcpServers: [], toolDenylist: ["Task", "TaskOutput", "TaskStop"],
          });
          const id = record(result.session).sessionId;
          if (typeof id !== "string" || !/^sess_[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("ZCode returned an invalid session identity.");
          sessionId = id;
        }
        await active.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
        if (incoming.abortSignal?.aborted) throw new Error("ZCode request cancelled before dispatch.");
        // Commit visible output before dispatch, so streaming combo routing cannot replay an
        // accepted task that already changed files. Post-send failure is non-retryable incomplete.
        emit({ type: "text_delta", text: "[ZCode: running in the configured isolated workspace]\n", phase: "commentary" });
        sent = true;
        await active.request("session/send", { sessionId, content, ...modelParams });
        await controller.promise;
        if (sessionKey) {
          if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
          sessions.set(sessionKey, sessionId);
        }
        emit({ type: "done", endTurn: true, providerState: { zcode: { sessionId, scope } } });
      } catch (error) {
        if (sessionKey) sessions.delete(sessionKey);
        const message = error instanceof Error ? error.message : "ZCode bridge failed.";
        if (sent) emit({ type: "incomplete", reason: "zcode_agent_interrupted", message,
          retryable: false, endTurn: true });
        else emit({ type: "error", message, retryable: false, status: 400 });
      } finally {
        incoming.abortSignal?.removeEventListener("abort", cancelled);
        clearTimeout(timer); clearInterval(heartbeat);
        if (client) {
          if (sent && sessionId) await client.request("session/stop", { sessionId }, 500).catch(() => {});
          await client.close();
        }
        release?.();
      }
    },
  };
}
