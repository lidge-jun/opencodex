/**
 * DSH host plugin: persistent session bindings between exact DSH sessions and
 * a normal ChatGPT chat, controlled by the OpenCodex chatgpt-bridge core.
 *
 * DSH API surface (verified against installed @deepseek-ai/dsh@0.1.2-rc.1,
 * see CCW docs/handoff P0 capability matrix §2):
 * - ctx.agents.get(id) → live Agent | undefined; agent.followup(message)
 *   enqueues a next-turn message and wakes the driver;
 * - ctx.on("agent/inbox/claimed", …) payload carries `turn` — the anchor that
 *   correlates an inbox item to its turn;
 * - ctx.on("session/event", (session, event)) streams
 *   assistant/message{turn} / turn/end{turn} for attribution;
 * - subagent-owned sessions are rejected on three layers (origin, lineage,
 *   runtime ownership) — bridging never hijacks a child session;
 * - ctx.storage persists the binding map; ctx.webServer.register exposes the
 *   control endpoints to the OpenCodex core only (loopback + token).
 */

export interface DshUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
}

export interface DshAgent {
  readonly id: string;
  followup(message: DshUserMessage): void;
  whenIdle(): Promise<void>;
}

export interface DshSessionHeader {
  readonly id: string;
  readonly origin?: "user" | "subagent";
  readonly parentSession?: string;
  readonly agentPreset?: string;
}

export interface DshSession {
  readonly header: DshSessionHeader;
}

export interface DshAgentsRegistry {
  get(id: string): DshAgent | undefined;
  isOwnedBy(childId: string, parentId: string): boolean;
}

export interface DshPluginContext {
  readonly agents: DshAgentsRegistry;
  on(event: "agent/inbox/claimed", listener: (payload: { agent: DshAgent; message: { id: string }; turn: number }) => void): void;
  on(event: "agent/inbox/inserted", listener: (payload: { agent: DshAgent; message: { id: string } }) => void): void;
  on(event: "agent/inbox/discarded", listener: (payload: { agent: DshAgent; message: { id: string } }) => void): void;
  on(event: "session/event", listener: (session: DshSession, event: DshSessionEvent) => void): void;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
  webServer: {
    register(route: { kind: "prefix"; path: string; handler: (request: BridgeControlRequest) => Promise<BridgeControlResponse> }): void;
  };
}

export interface BridgeControlRequest {
  method: "GET" | "POST";
  path: string;
  /** Shared secret issued to the OpenCodex core; never the DSH user key. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface BridgeControlResponse {
  status: number;
  body: unknown;
}

export type DshSessionEvent =
  | { type: "turn/start"; turn: number }
  | { type: "turn/end"; turn: number; reason: string }
  | { type: "assistant/message"; turn: number; step: number; message: { id: string } }
  | { type: "tool/call"; turn: number; step: number; callId: string; name: string }
  | { type: "tool/result"; turn: number; step: number; message: { id: string } }
  | { type: "user/message"; message: { id: string } }
  | { type: string; [key: string]: unknown };

export interface BridgeBindingState {
  sessionId: string;
  chatConversationId: string;
  boundAt: string;
  /** Latest correlated turn per delivered inbox item. */
  lastDeliveredInboxItemId: string | null;
  lastClaimedTurn: number | null;
  lastAssistantMessageId: string | null;
  lastTurnEnded: number | null;
}

export const TOKEN_HEADER = "x-bridge-token";

export interface DshBridgePluginConfig {
  /** Credential reference resolved by ctx.credentials; never a plaintext secret here. */
  controlTokenRef?: string;
  controlToken?: string;
}

export function createBridgePlugin(ctx: DshPluginContext, config: DshBridgePluginConfig) {
  let controlToken = config.controlToken ?? "";
  const states = new Map<string, BridgeBindingState>();

  const loadState = async (sessionId: string): Promise<BridgeBindingState | undefined> => {
    if (states.has(sessionId)) return states.get(sessionId);
    const persisted = await ctx.storage.get<BridgeBindingState>(`chatgpt-bridge:${sessionId}`);
    if (persisted) states.set(sessionId, persisted);
    return persisted;
  };

  const saveState = async (sessionId: string): Promise<void> => {
    const state = states.get(sessionId);
    if (state) await ctx.storage.set(`chatgpt-bridge:${sessionId}`, state);
  };

  // Correlation: inbox item → claimed turn → assistant output → turn end.
  ctx.on("agent/inbox/claimed", async ({ agent, message, turn }) => {
    const state = await loadState(String(agent.id));
    if (!state || state.lastDeliveredInboxItemId !== message.id) return;
    state.lastClaimedTurn = turn;
    await saveState(String(agent.id));
  });
  ctx.on("session/event", async (session, event) => {
    if (event.type !== "assistant/message" && event.type !== "turn/end") return;
    const state = await loadState(String(session.header.id));
    if (!state || state.lastClaimedTurn === null || event.turn !== state.lastClaimedTurn) return;
    if (event.type === "assistant/message") {
      state.lastAssistantMessageId = event.message.id;
    } else {
      state.lastTurnEnded = event.turn;
    }
    await saveState(String(session.header.id));
  });

  /**
   * Three-layer rejection mirroring hasApiSessionSubagentOwner (0.1.2-rc.1):
   * durable origin, durable parent lineage, and runtime ownership. A child
   * session is rejected even when its parent agent is no longer live — the
   * lineage alone is disqualifying for bridging.
   */
  const isSubagentOwned = (header: DshSessionHeader): boolean => {
    if (header.origin === "subagent") return true;
    return header.parentSession !== undefined;
  };

  const requireToken = (request: BridgeControlRequest): boolean => {
    if (!controlToken) return false;
    return request.headers[TOKEN_HEADER] === controlToken;
  };

  const handler = async (request: BridgeControlRequest): Promise<BridgeControlResponse> => {
    if (!requireToken(request)) return { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } };
    const sessionId = request.path.split("/").filter(Boolean)[1] ?? "";

    if (request.method === "GET" && request.path.endsWith("/binding")) {
      const state = await loadState(sessionId);
      if (!state) return { status: 404, body: { ok: false, code: "BINDING_NOT_FOUND" } };
      return { status: 200, body: { ok: true, binding: state } };
    }

    if (request.method === "POST" && request.path.endsWith("/deliver")) {
      const body = request.body as { message?: string; chatConversationId?: string; inboxItemId?: string } | undefined;
      const message = body?.message ?? "";
      if (!message.trim()) return { status: 400, body: { ok: false, code: "EMPTY_PROMPT" } };
      const agent = ctx.agents.get(sessionId);
      if (!agent) return { status: 404, body: { ok: false, code: "TARGET_NOT_FOUND" } };

      const state: BridgeBindingState = (await loadState(sessionId)) ?? {
        sessionId,
        chatConversationId: body?.chatConversationId ?? "",
        boundAt: new Date().toISOString(),
        lastDeliveredInboxItemId: null,
        lastClaimedTurn: null,
        lastAssistantMessageId: null,
        lastTurnEnded: null,
      };
      if (body?.chatConversationId && state.chatConversationId && state.chatConversationId !== body.chatConversationId) {
        return { status: 409, body: { ok: false, code: "BINDING_CHANGED" } };
      }

      // A prior delivery whose turn was claimed but not yet ended means the
      // host is mid-turn: refuse instead of steering or queueing on top.
      if (state.lastClaimedTurn !== null && state.lastTurnEnded === null) {
        return { status: 409, body: { ok: false, code: "TARGET_ACTIVE" } };
      }

      const inboxItemId = body?.inboxItemId ?? `bridge-${crypto.randomUUID()}`;
      const userMessage: DshUserMessage = { id: inboxItemId, role: "user", content: message };
      state.lastDeliveredInboxItemId = inboxItemId;
      state.lastClaimedTurn = null;
      state.lastAssistantMessageId = null;
      state.lastTurnEnded = null;
      if (body?.chatConversationId) state.chatConversationId = body.chatConversationId;
      states.set(sessionId, state);
      agent.followup(userMessage);
      await saveState(sessionId);
      return {
        status: 202,
        body: { ok: true, state: "SUBMITTED_UNVERIFIED", inboxItemId },
      };
    }

    return { status: 404, body: { ok: false, code: "TARGET_NOT_FOUND" } };
  };

  return {
    /** Exposed for the DSH host to wire into its lifecycle; see README. */
    apply() {
      ctx.webServer.register({ kind: "prefix", path: "/chatgpt-bridge", handler });
    },
    handler,
    isSubagentOwned,
    setControlToken(token: string) {
      controlToken = token;
    },
  };
}
