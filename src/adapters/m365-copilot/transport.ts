import { m365CopilotClaims } from "../../oauth/m365-copilot";
import { getToneForModel, m365CopilotScenario } from "../../providers/m365-copilot-models";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import type { M365ImageAnnotation } from "./images";

const RS = "\x1e";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_LENGTH = 8 * 1024 * 1024;
export class M365CopilotTurnError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** Per-message assembly adapted from cramt/m365-copilot-proxy, MIT; see LICENSE. */
export class M365TextComposer {
  private messages = new Map<string, string>();
  private target: string | null = null;
  cursor(id: string) { this.target = id; }
  snapshot(id: string | undefined, text: string) {
    if (!text) return;
    const key = id ?? this.target ?? "";
    if (!this.messages.has(key) && this.messages.size >= 256) throw new M365CopilotTurnError("Microsoft 365 Copilot returned too many messages", 413);
    this.target ??= key;
    if (text.length > (this.messages.get(key)?.length ?? 0)) this.messages.set(key, text);
  }
  delta(text: string) { const key = this.target ?? ""; this.messages.set(key, (this.messages.get(key) ?? "") + text); }
  get text() { return [...this.messages.values()].filter(Boolean).join("\n\n"); }
}

export interface M365Conversation { sessionId: string; conversationId: string; turns: number }
export function createM365Conversation(): M365Conversation {
  return { sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID(), turns: 0 };
}

export function m365WebSocketUrl(token: string, model: string, conversation: M365Conversation, requestId: string): string {
  const claims = m365CopilotClaims(token);
  const parameters = new URLSearchParams({ chatsessionid: requestId, clientrequestid: requestId, "X-SessionId": conversation.sessionId,
    ConversationId: conversation.conversationId, access_token: token, source: '"officeweb"', product: "Office", agentHost: "Bizchat.FullScreen",
    agent: "web", disableMemory: "1", ...m365CopilotScenario(model) });
  return "wss://substrate.office.com/m365Copilot/Chathub/" + claims.oid + "@" + claims.tid + "?" + parameters;
}

export function m365ChatFrame(text: string, model: string, conversation: M365Conversation, requestId: string, images?: M365ImageAnnotation[]): object {
  return { type: 4, target: "chat", invocationId: "0", arguments: [{
    source: "officeweb", clientCorrelationId: requestId, sessionId: conversation.sessionId, optionsSets: [],
    streamingMode: "ConciseWithPadding", spokenTextMode: "None", options: {}, extraExtensionParameters: {},
    allowedMessageTypes: ["Chat", "Suggestion", "InternalSearchQuery", "Disengaged", "InternalLoaderMessage", "Progress", "RenderCardRequest", "SemanticSerp", "GenerateContentQuery", "SearchQuery", "ConfirmationCard", "DeveloperLogs", "EndOfRequest", "ReferencesListComplete"],
    sliceIds: [], threadLevelGptId: {}, traceId: requestId, isStartOfSession: conversation.turns === 0,
    clientInfo: { clientPlatform: "mcmcopilot-web", clientAppName: "Office", clientEntrypoint: "mcmcopilot-officeweb", clientSessionId: conversation.sessionId,
      clientAppType: "Web", deviceOS: process.platform, deviceType: "Desktop" },
    message: { author: "user", inputMethod: "Keyboard", text, entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"], requestId,
      locationInfo: { timeZoneOffset: -new Date().getTimezoneOffset() / 60, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      locale: "en-us", messageType: "Chat", experienceType: "Default", adaptiveCards: [], clientPreferences: {}, ...(images?.length ? { messageAnnotations: images } : {}) },
    plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }], isSbsSupported: true, tone: getToneForModel(model),
    renderReferencesBehindEOS: true, disconnectBehavior: "continue",
  }] };
}

export interface M365TurnOptions {
  images?: M365ImageAnnotation[];
  token: string; model: string; text: string; conversation: M365Conversation; signal?: AbortSignal;
  onText(text: string): void; onThinking?(text: string): void; beforeSend?(): void; budget?: TranslatorBudget;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

export function runM365CopilotTurn(options: M365TurnOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new M365CopilotTurnError("Microsoft 365 Copilot turn cancelled", 499));
  const requestId = crypto.randomUUID();
  const url = m365WebSocketUrl(options.token, options.model, options.conversation, requestId);
  const headers = { Origin: "https://m365.cloud.microsoft", "User-Agent": "opencodex", "X-RoutingParameter-SessionKey": options.conversation.conversationId };
  return new Promise((resolveTurn, reject) => {
    let socket: WebSocket;
    // lib.dom hides Bun's documented constructor extension when both type libraries are enabled.
    const NativeSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
    try { socket = options.createSocket ? options.createSocket(url, headers) : new NativeSocket(url, { headers }); }
    catch { reject(new M365CopilotTurnError("Microsoft 365 Copilot connection failed")); return; }
    socket.binaryType = "arraybuffer";
    const composer = new M365TextComposer();
    let pending = "";
    let emitted = "";
    let settled = false;
    let handshake = false;
    let completed = false;
    let refusal = false;
    let retainedBytes = 0;
    const timeout = setTimeout(() => finish(new M365CopilotTurnError("Microsoft 365 Copilot turn timed out", 504)), 180_000);
    const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (retainedBytes) { options.budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" }); retainedBytes = 0; }
      try { socket.close(); } catch { error ??= new M365CopilotTurnError("Microsoft 365 Copilot connection cleanup failed"); }
      if (error) reject(error); else resolveTurn(composer.text);
    };
    const cancel = () => {
      try { if (handshake && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ arguments: [{}], invocationId: "1", target: "stop", type: 1 }) + RS); }
      catch { finish(new M365CopilotTurnError("Microsoft 365 Copilot turn cancelled before Stop could be delivered", 499)); return; }
      finish(new M365CopilotTurnError("Microsoft 365 Copilot turn cancelled", 499));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) { cancel(); return; }
    const advance = () => {
      const text = composer.text;
      if (text.length > MAX_ANSWER_LENGTH) throw new M365CopilotTurnError("Microsoft 365 Copilot answer exceeded the buffer limit", 413);
      const bytes = 2 * Buffer.byteLength(text);
      if (bytes > retainedBytes) options.budget?.chargeRetained(bytes - retainedBytes, { kind: "retained_collectors" });
      else if (bytes < retainedBytes) options.budget?.releaseRetained(retainedBytes - bytes, { kind: "retained_collectors" });
      retainedBytes = bytes;
      if (text.startsWith(emitted)) { const delta = text.slice(emitted.length); emitted = text; if (delta) options.onText(delta); }
    };
    const messages = (rows: any[]) => {
      for (const row of rows) {
        if (row?.author !== "bot") continue;
        if (row.messageType === "Disengaged") refusal = true;
        if (typeof row.text !== "string") continue;
        if (row.messageType === "ChainOfThoughtSummary") options.onThinking?.(row.text);
        else if (!row.messageType || row.messageType === "Chat") { composer.snapshot(typeof row.messageId === "string" && row.messageId.length <= 256 ? row.messageId : undefined, row.text); advance(); }
      }
    };
    socket.onopen = () => { if (!settled) socket.send(JSON.stringify({ protocol: "json", version: 1 }) + RS); };
    socket.onmessage = event => {
      if (settled) return;
      try {
        const raw = typeof event.data === "string" ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : "";
        if (!raw || Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new M365CopilotTurnError("Microsoft 365 Copilot returned an invalid frame");
        pending += raw;
        if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) throw new M365CopilotTurnError("Microsoft 365 Copilot frame buffer exceeded its limit", 413);
        let end;
        while ((end = pending.indexOf(RS)) >= 0) {
          const piece = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!piece.trim()) continue;
          const frame = JSON.parse(piece);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new M365CopilotTurnError("Microsoft 365 Copilot returned an invalid frame");
          if (frame.type === 6) { socket.send(JSON.stringify({ type: 6 }) + RS); continue; }
          if (!handshake) {
            if (frame.error || frame.type !== undefined) throw new M365CopilotTurnError("Microsoft 365 Copilot handshake failed");
            handshake = true;
            try { options.beforeSend?.(); } catch (error) { finish(error as Error); return; }
            socket.send(JSON.stringify(m365ChatFrame(options.text, options.model, options.conversation, requestId, options.images)) + RS);
            options.conversation.turns++;
            continue;
          }
          if (frame.type === 1 && frame.target === "update" && Array.isArray(frame.arguments)) {
            for (const arg of frame.arguments) {
              const cursor = typeof arg.cursor?.j === "string" ? arg.cursor.j.match(/^\$\['([^']+)'\]/)?.[1] : undefined;
              if (cursor) { if (cursor.length > 256) throw new M365CopilotTurnError("Microsoft 365 Copilot returned an invalid cursor"); composer.cursor(cursor); }
              if (typeof arg.writeAtCursor === "string") { composer.delta(arg.writeAtCursor); advance(); }
              if (Array.isArray(arg.messages)) messages(arg.messages);
            }
          } else if (frame.type === 2) {
            const item = frame.item;
            if (Array.isArray(item?.messages)) messages(item.messages);
            if (item?.result?.value === "Throttled" || item?.result?.value === "OutOfCredits") throw new M365CopilotTurnError("Microsoft 365 Copilot account quota or rate limit reached", 429);
            if (refusal) throw new M365CopilotTurnError("Microsoft 365 Copilot declined this request", 403);
            if (item?.result?.value && item.result.value !== "Success") throw new M365CopilotTurnError("Microsoft 365 Copilot did not serve this model for the account");
            if (!composer.text) throw new M365CopilotTurnError("Microsoft 365 Copilot returned no text");
            completed = true; finish();
          } else if ((frame.type === 3 || frame.type === 7) && !completed) throw new M365CopilotTurnError("Microsoft 365 Copilot closed before completing the turn");
        }
      } catch (error) { finish(error instanceof M365CopilotTurnError || isTranslatorBudgetExceededError(error) ? error : new M365CopilotTurnError("Microsoft 365 Copilot returned an invalid response")); }
    };
    socket.onerror = () => finish(new M365CopilotTurnError("Microsoft 365 Copilot connection failed"));
    socket.onclose = () => { if (!settled) finish(new M365CopilotTurnError("Microsoft 365 Copilot connection closed before completion")); };
  });
}
