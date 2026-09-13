import { refreshAccount } from "./account-runtime";
import { createHash } from "node:crypto";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ZcodeClient } from "./client";
import { loadZcodeSettings, readZcodeModels, record, type JsonObject, type ZcodeSettings } from "./settings";
import { zcodeThoughtLevel } from "./reasoning";

type Client = Pick<ZcodeClient, "request" | "close" | "onEvent" | "onFailure">;
const MAX_ZCODE_INPUT_CHARS = 200_000;
const MAX_ZCODE_PROTOCOL_LINE_CHARS = 1024 * 1024;
const MAX_ZCODE_SESSION_ID = `sess_${"x".repeat(80)}`;
const HISTORY_TRUNCATED = "[Earlier OpenCodex conversation history truncated to fit the ZCode bridge.]";
const CANCELLED_BEFORE_DISPATCH = "ZCode request cancelled before dispatch.";
const HOST_EXECUTION_POLICY = "[OpenCodex bridge capability: the operator approved host execution for this managed Desktop connection, and native Bash is configured through ZCode's official hook to use the OpenCodex service user's operating-system permissions. ZCode file tools remain workspace-scoped, so use Bash for paths outside the configured workspace and do not report a host path missing until Bash has checked it.]";
const HOST_EXECUTION_REMINDER = "[OpenCodex bridge reminder: use Bash for paths outside the configured workspace; its managed host-execution setting is applied automatically.]";
const SAFE_ACCOUNT_REFRESH_ERRORS = new Set(["account_login_required", "account_identity_mismatch", "native_oauth_failed"]);
export interface ZcodeAdapterDeps {
  settings?: () => ZcodeSettings;
  client?: (settings: ZcodeSettings) => Client;
  // True is the explicit fence that permits a persisted refresh to advance settings.scope.
  refreshAccount?: (id: string) => Promise<boolean>;
  timeoutMs?: number;
}

// ZCode persists model selection in its settings file: serialize the whole profile, not just a
// session. Each turn owns a child; completing/cancelling it cannot kill another conversation.
const locks = new Map<string, Promise<void>>();
const sessions = new Map<string, string>();
const reservationsByScope = new Map<string, number>();
let reservations = 0;
const MAX_RESERVATIONS = 32;
const MAX_RESERVATIONS_PER_SCOPE = 24;
/** Stop only this caller's wait; the official refresh may be shared by another request. */
function waitForSharedRefresh<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new Error(CANCELLED_BEFORE_DISPATCH)); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(CANCELLED_BEFORE_DISPATCH));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
async function lock(key: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
  const scopeReservations = reservationsByScope.get(key) ?? 0;
  if (reservations >= MAX_RESERVATIONS || scopeReservations >= MAX_RESERVATIONS_PER_SCOPE) {
    throw new Error("ZCode profile queue is full.");
  }
  reservations++;
  reservationsByScope.set(key, scopeReservations + 1);
  const previous = locks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; reservations--;
    const remaining = (reservationsByScope.get(key) ?? 1) - 1;
    if (remaining > 0) reservationsByScope.set(key, remaining);
    else reservationsByScope.delete(key);
    unlock();
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  };
  let onAbort = () => {};
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(CANCELLED_BEFORE_DISPATCH));
      signal?.addEventListener("abort", onAbort, { once: true });
    })]);
    if (signal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
  } catch (error) { release(); throw error; }
  finally { signal?.removeEventListener("abort", onAbort); }
  return release;
}

function textualContent(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "image") {
      throw new Error("ZCode image input was not converted to text before native dispatch.");
    }
    throw new Error("ZCode video input is unsupported by the native Desktop bridge.");
  }).join("\n");
}

function safeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 128) || "unknown";
}

/**
 * Project Responses history onto the app-server's text-only `session/send` wire.
 *
 * Starting a ZCode session after another provider means the replay can legitimately contain
 * assistant reasoning, tool calls and their results. Those are history, not new client tool
 * instructions: omit hidden reasoning, render calls as inert labels, and keep textual results.
 * Images must already have been described/stripped by the shared vision pipeline.
 */
function transcriptLine(message: OcxMessage): string | undefined {
  if (message.role === "assistant") {
    const content = message.content.flatMap(part => {
      if (part.type === "text") return part.text ? [part.text] : [];
      if (part.type === "toolCall") return [`[historical tool call: ${safeLabel(part.name)}]`];
      // Never disclose or replay another provider's hidden chain of thought.
      return [];
    }).join("\n");
    return content.trim() ? `assistant: ${content}` : undefined;
  }
  if (message.role === "toolResult") {
    const content = textualContent(message.content);
    const status = message.isError ? " error" : " result";
    return `tool ${safeLabel(message.toolName)}${status}: ${content}`;
  }
  return `${message.role}: ${textualContent(message.content)}`;
}

function transcriptLines(messages: OcxMessage[]): string[] {
  return messages.map(transcriptLine).filter((line): line is string => line !== undefined && line.trim().length > 0);
}

function joinPrompt(lines: string[]): string {
  return lines.join("\n\n");
}

/** Retain the current turn and newest complete history entries within the native bridge cap. */
function boundedPrompt(system: string[], history: string[], current: string[]): string {
  const full = joinPrompt([...system, ...history, ...current]);
  if (full.length <= MAX_ZCODE_INPUT_CHARS) return full;

  const fixed = [...system, HISTORY_TRUNCATED, ...current];
  const fixedPrompt = joinPrompt(fixed);
  if (fixedPrompt.length > MAX_ZCODE_INPUT_CHARS) {
    throw new Error("ZCode current input and system instructions exceed the native bridge limit.");
  }

  const retained: string[] = [];
  let length = fixedPrompt.length;
  for (let index = history.length - 1; index >= 0; index--) {
    const line = history[index]!;
    // Inserting one complete history line adds its content and one prompt separator.
    const added = line.length + 2;
    if (length + added > MAX_ZCODE_INPUT_CHARS) break;
    retained.unshift(line);
    length += added;
  }
  return joinPrompt([...system, HISTORY_TRUNCATED, ...retained, ...current]);
}

function textInput(parsed: OcxParsedRequest, resumed: boolean, hostExecution = false): string {
  const messages = parsed.context.messages;
  const continuation = parsed._continuationConversationMessageIndex;
  const boundary = continuation ?? Math.max(0, messages.length - 1);
  const history = resumed ? [] : transcriptLines(messages.slice(0, boundary));
  const requestSystem = (parsed.context.systemPrompt ?? []).filter(line => line.trim().length > 0);
  const requestCurrent = transcriptLines(messages.slice(resumed ? continuation ?? -1 : boundary));
  if (!joinPrompt([...requestSystem, ...history, ...requestCurrent]).trim()) throw new Error("ZCode input is empty.");
  const current = [...requestCurrent,
    ...(hostExecution ? [HOST_EXECUTION_REMINDER] : [])];
  const system = [...(hostExecution ? [HOST_EXECUTION_POLICY] : []),
    ...requestSystem];
  const prompt = boundedPrompt(system, history, current);
  return prompt;
}

/** The managed bootstrap rejects oversized NDJSON before parsing; fail before any native dispatch. */
function assertSessionSendFits(content: string, modelParams: JsonObject): void {
  let length = Infinity;
  try {
    length = JSON.stringify({
      id: Number.MAX_SAFE_INTEGER,
      method: "session/send",
      params: { sessionId: MAX_ZCODE_SESSION_ID, content, ...modelParams },
    }).length;
  } catch { /* normalized below without exposing model/profile material */ }
  if (length > MAX_ZCODE_PROTOCOL_LINE_CHARS) {
    throw new Error("ZCode input exceeds the native bridge serialization limit.");
  }
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
        if (incoming.abortSignal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
        const refreshSavedAccount = async (): Promise<boolean> => {
          if (!provider.zcodeAccountId || (deps.settings && !deps.refreshAccount)) return false;
          try {
            const refresh = (deps.refreshAccount ?? refreshAccount)(provider.zcodeAccountId);
            return (await waitForSharedRefresh(refresh, incoming.abortSignal)) === true;
          }
          catch (error) {
            if (incoming.abortSignal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
            const code = error instanceof Error && SAFE_ACCOUNT_REFRESH_ERRORS.has(error.message)
              ? error.message : "account_refresh_failed";
            throw new Error(code);
          }
        };
        await refreshSavedAccount();
        let settings: ZcodeSettings;
        try { settings = (deps.settings ?? (() => loadZcodeSettings(process.env, provider.zcodeAccountId)))(); }
        catch { throw new Error("ZCode native execution is unavailable. Configure the isolated launcher, home, workspace and explicit opt-in."); }
        if (provider.authMode !== "local") throw new Error("ZCode requires local authentication mode; log in using the isolated ZCode client.");
        if (!readZcodeModels(settings).some(item => item.id === parsed.modelId)) {
          throw new Error("ZCode model is unavailable in the isolated settings.");
        }
        if (parsed.options.toolChoice && parsed.options.toolChoice !== "auto") {
          throw new Error("ZCode owns its tools and does not support client tool_choice constraints.");
        }
        release = await lock(settings.lockKey, incoming.abortSignal);
        // Reject a reconnect/revocation that happened while waiting. Only the refresh owned below
        // may advance the generation once this turn holds the physical-profile lock.
        const queued = (deps.settings ?? (() => loadZcodeSettings(process.env, provider.zcodeAccountId)))();
        if (queued.lockKey !== settings.lockKey || queued.scope !== settings.scope) {
          throw new Error("ZCode connection or profile changed while this turn was queued.");
        }
        // The refresh cache can expire while this turn waits behind a long native child. Refresh
        // again under the stable profile lock, then reload the connection before dispatch.
        const refreshedAfterQueue = await refreshSavedAccount();
        const current = (deps.settings ?? (() => loadZcodeSettings(process.env, provider.zcodeAccountId)))();
        if (current.lockKey !== settings.lockKey
          || (!refreshedAfterQueue && current.scope !== queued.scope)) {
          throw new Error("ZCode connection or profile changed while this turn was queued.");
        }
        settings = current;
        const model = readZcodeModels(settings).find(item => item.id === parsed.modelId);
        if (!model) throw new Error("ZCode model is unavailable in the isolated settings.");
        const scope = createHash("sha256").update(JSON.stringify([
          settings.scope, provider.baseUrl, parsed._reasoningReplayScope?.current?.providerName,
          parsed._cursorIdentityScope, parsed.modelId,
        ])).digest("hex");
        const compaction = parsed._compactionRequest === true;
        sessionKey = !compaction && parsed._clientThreadId && !parsed._cursorIsolateConversation
          ? createHash("sha256").update(scope + parsed._clientThreadId).digest("hex") : undefined;
        const previous = compaction ? {} : record(parsed._providerContinuation?.zcode);
        sessionId = previous.scope === scope && typeof previous.sessionId === "string"
          && /^sess_[a-zA-Z0-9-]{1,80}$/.test(previous.sessionId) ? previous.sessionId
          : sessionKey ? sessions.get(sessionKey) : undefined;
        const content = textInput(parsed, Boolean(sessionId), settings.hostExecution === true);
        // The Desktop bootstrap resolves credentials inside the official runtime (and the optional
        // sandbox when enabled). The parent only sends
        // public model identity; it never receives Desktop API keys or synthesizes vendor auth.
        const modelParams: JsonObject = settings.desktopModels
          ? { _zcodeModel: { providerId: model.providerId, modelId: model.modelId } }
          : { runtimeModel: model.runtimeModel };
        assertSessionSendFits(content, modelParams);
        client = (deps.client ?? (s => new ZcodeClient(s)))(settings);
        const active = client;
        const thoughtLevel = zcodeThoughtLevel(model.modelId, parsed.options.reasoning);
        const thoughtParams = thoughtLevel ? { thoughtLevel } : {};
        const toolParams: JsonObject = compaction
          ? { mcpServers: [], toolAllowlist: [] }
          : { mcpServers: [], toolDenylist: ["Task", "TaskOutput", "TaskStop"] };
        const controller = Promise.withResolvers<void>();
        // Attach a handler immediately: failures can happen during session materialization.
        void controller.promise.catch(() => {});
        stop = () => { controller.reject(new Error("ZCode turn cancelled or timed out.")); void active.close(); };
        incoming.abortSignal?.addEventListener("abort", cancelled, { once: true });
        if (incoming.abortSignal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
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
            if (compaction) {
              controller.reject(new Error("ZCode compaction attempted native tool execution."));
              void active.close();
              return;
            }
            // Informational only: no tool_call_* event can cause a client to repeat native work.
            if (payload.kind === "started" || payload.kind === "result") emit({ type: "text_delta",
              text: payload.kind === "started" ? "\n[ZCode: native tool started]\n" : "\n[ZCode: native tool finished]\n",
              phase: "commentary" });
          } else if (params.type === "turn.completed") {
            if (!textSeen && typeof payload.response === "string" && payload.response.length > 0) {
              textSeen = true;
              emit({ type: "text_delta", text: payload.response, phase: "final_answer" });
            }
            if (textSeen) controller.resolve();
            else controller.reject(new Error("ZCode completed without a model answer."));
          } else if (params.type === "turn.failed") {
            controller.reject(new Error("ZCode agent turn failed. Inspect the interactive ZCode client for authentication, quota or model errors."));
          }
        };
        if (sessionId) {
          await active.request("session/resume", { sessionId, ...modelParams, ...thoughtParams, ...toolParams });
        } else {
          const result = await active.request("session/create", {
            workspace: { workspacePath: settings.workspace, workspaceKey: settings.workspace },
            mode: settings.nativePermissionMode ?? "edit", ...modelParams, ...thoughtParams, titleGenerationEnabled: false,
            ...toolParams,
          });
          const id = record(result.session).sessionId;
          if (typeof id !== "string" || !/^sess_[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("ZCode returned an invalid session identity.");
          sessionId = id;
        }
        await active.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
        if (incoming.abortSignal?.aborted) throw new Error(CANCELLED_BEFORE_DISPATCH);
        // Commit visible output before dispatch, so streaming combo routing cannot replay an
        // accepted task that already changed files. Post-send failure is non-retryable incomplete.
        emit({ type: "text_delta", text: compaction
          ? "[ZCode: summarizing without native tools]\n"
          : settings.hostExecution
            ? "[ZCode: running native tools with host-user access]\n"
            : "[ZCode: running native tools in the configured launcher]\n", phase: "commentary" });
        sent = true;
        await active.request("session/send", { sessionId, content, ...modelParams });
        await controller.promise;
        if (sessionKey) {
          if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
          sessions.set(sessionKey, sessionId);
        }
        emit({ type: "done", endTurn: true,
          ...(compaction ? {} : { providerState: { zcode: { sessionId, scope } } }) });
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
