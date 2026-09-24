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
 * - subagent-owned sessions are rejected on both durable layers the session
 *   header carries (`origin`, `parentSession`) before anything is enqueued —
 *   bridging never hijacks a child session;
 * - ctx.storage persists the binding map; ctx.webServer.register exposes the
 *   control endpoints to the OpenCodex core only (loopback + token).
 */

export interface DshUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
}

export interface DshSessionHeader {
  readonly id: string;
  readonly origin?: "subagent";
  readonly parentSession?: string;
  readonly agentPreset?: string;
}

export interface DshSession {
  readonly header: DshSessionHeader;
}

export interface DshAgent {
  /** Session-backed identity: the same id `ctx.agents.get` takes and `session/event` carries. */
  readonly id: string;
  readonly session: DshSession;
  followup(message: DshUserMessage): void;
}

export interface DshAgentsRegistry {
  get(id: string): DshAgent | undefined;
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
  lastDeliveredAt: string | null;
  lastClaimedTurn: number | null;
  lastAssistantMessageId: string | null;
  lastTurnEnded: number | null;
}

export const TOKEN_HEADER = "x-bridge-token";

/**
 * How long an unclaimed delivery may hold the gate. Same boundary the core store
 * uses to call a pending send outcome-unknown: past it the host assumes the inbox
 * item was dropped, because `agent/inbox/discarded` is not an event this plugin
 * can prove the host ever emits.
 */
const OUTSTANDING_DELIVERY_MAX_MS = 120_000;

export interface DshBridgePluginConfig {
  /** Credential reference resolved by ctx.credentials; never a plaintext secret here. */
  controlTokenRef?: string;
  controlToken?: string;
}

export function createBridgePlugin(ctx: DshPluginContext, config: DshBridgePluginConfig) {
  let controlToken = config.controlToken ?? "";
  const states = new Map<string, BridgeBindingState>();
  // A delivery's read-modify-write spans awaits, so two concurrent control calls
  // for one session would both mint state and both enqueue: at most one runs at
  // a time, and the loser is refused rather than silently dropped.
  const delivering = new Set<string>();

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
  // A delivery that is cancelled before it is claimed never ends a turn, so
  // without this the outstanding-item gate below would wedge the binding.
  ctx.on("agent/inbox/discarded", async ({ agent, message }) => {
    const state = await loadState(String(agent.id));
    if (!state || state.lastDeliveredInboxItemId !== message.id || state.lastClaimedTurn !== null) return;
    state.lastDeliveredInboxItemId = null;
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
   * Both durable rejection layers of a session header, mirroring
   * hasApiSessionSubagentOwner (0.1.2-rc.1): durable origin and durable parent
   * lineage. A child session is rejected even when its parent agent is no
   * longer live — the lineage alone is disqualifying for bridging. Runtime
   * ownership is the third layer there and cannot be consulted here: it needs
   * the exact parent Agent, which a session-id-keyed control call never carries.
   */
  const isSubagentOwned = (header: DshSessionHeader): boolean => {
    if (header.origin === "subagent") return true;
    return header.parentSession !== undefined;
  };

  const requireToken = (request: BridgeControlRequest): boolean => {
    if (!controlToken) return false;
    return request.headers[TOKEN_HEADER] === controlToken;
  };

  const deliverToSession = async (
    sessionId: string,
    request: BridgeControlRequest,
  ): Promise<BridgeControlResponse> => {
    const body = request.body as { message?: string; chatConversationId?: string; inboxItemId?: string } | undefined;
    const message = body?.message ?? "";
    if (!message.trim()) return { status: 400, body: { ok: false, code: "EMPTY_PROMPT" } };
    const agent = ctx.agents.get(sessionId);
    if (!agent) return { status: 404, body: { ok: false, code: "TARGET_NOT_FOUND" } };
    if (isSubagentOwned(agent.session.header)) {
      return { status: 409, body: { ok: false, code: "CONTEXT_INCOMPATIBLE" } };
    }

    const state: BridgeBindingState = (await loadState(sessionId)) ?? {
      sessionId,
      chatConversationId: body?.chatConversationId ?? "",
      boundAt: new Date().toISOString(),
      lastDeliveredInboxItemId: null,
      lastDeliveredAt: null,
      lastClaimedTurn: null,
      lastAssistantMessageId: null,
      lastTurnEnded: null,
    };
    if (body?.chatConversationId && state.chatConversationId && state.chatConversationId !== body.chatConversationId) {
      return { status: 409, body: { ok: false, code: "BINDING_CHANGED" } };
    }

    // One delivery is outstanding until its turn ends: an item that has not
    // been claimed yet may still start one, and overwriting it would leave
    // that turn unattributable. Refuse instead of steering or queueing on top.
    if (state.lastDeliveredInboxItemId !== null && state.lastTurnEnded === null) {
      // A claimed turn ends on its own. An item that was never claimed only
      // clears through `agent/inbox/discarded`, so without this age-out a host
      // that drops the item quietly refuses every later delivery forever.
      const parsed = state.lastDeliveredAt ? Date.parse(state.lastDeliveredAt) : 0;
      // A marker this plugin did not write (an epoch number, a hand-edited row) parses to
      // NaN, and every comparison against NaN is false: treating it as "very old" is the
      // only reading that cannot wedge the session forever.
      const deliveredAt = Number.isFinite(parsed) ? parsed : 0;
      const dropped = state.lastClaimedTurn === null && Date.now() - deliveredAt > OUTSTANDING_DELIVERY_MAX_MS;
      if (!dropped) return { status: 409, body: { ok: false, code: "TARGET_ACTIVE" } };
    }

    const inboxItemId = body?.inboxItemId ?? `bridge-${crypto.randomUUID()}`;
    const userMessage: DshUserMessage = { id: inboxItemId, role: "user", content: message };
    state.lastDeliveredInboxItemId = inboxItemId;
    state.lastDeliveredAt = new Date().toISOString();
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
      if (delivering.has(sessionId)) return { status: 409, body: { ok: false, code: "TARGET_ACTIVE" } };
      delivering.add(sessionId);
      try {
        return await deliverToSession(sessionId, request);
      } finally {
        delivering.delete(sessionId);
      }
    }

    return { status: 404, body: { ok: false, code: "TARGET_NOT_FOUND" } };
  };

  return {
    /** Exposed for the DSH host to wire into its lifecycle; see README. */
    apply() {
      ctx.webServer.register({ kind: "prefix", path: "/chatgpt-bridge", handler });
    },
    handler,
    setControlToken(token: string) {
      controlToken = token;
    },
  };
}
