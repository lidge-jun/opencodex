import { describe, expect, setSystemTime, test } from "bun:test";
import {
  createBridgePlugin,
  TOKEN_HEADER,
  type DshAgent,
  type DshPluginContext,
  type DshSessionEvent,
  type DshSessionHeader,
  type DshUserMessage,
} from "../../extensions/dsh-chatgpt-bridge/src/host";

interface Listener {
  (payload: unknown): void | Promise<void>;
}

interface FakeAgent {
  followups: DshUserMessage[];
  header?: DshSessionHeader;
}

function makeCtx(agents: Map<string, FakeAgent>) {
  const listeners = new Map<string, Set<Listener>>();
  const storage = new Map<string, unknown>();
  const routes: Array<{ kind: string; path: string; handler: (r: unknown) => Promise<unknown> }> = [];
  const fakeAgent = (id: string, header: DshSessionHeader): DshAgent => ({
    id,
    session: { header },
    followup: () => {},
  });
  const ctx: DshPluginContext = {
    agents: {
      get: (id: string) => {
        const record = agents.get(id);
        if (!record) return undefined;
        return {
          ...fakeAgent(id, record.header ?? { id }),
          followup: (message: DshUserMessage) => {
            record.followups.push(message);
            listeners.get("agent/inbox/inserted")?.forEach(l => l({ agent: fakeAgent(id, record.header ?? { id }), message: { id: message.id } }));
          },
        };
      },
    },
    on: ((event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }) as DshPluginContext["on"],
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      set: async <T>(key: string, value: T) => {
        storage.set(key, value);
      },
    },
    webServer: {
      register: (route: { kind: "prefix"; path: string; handler: (r: never) => Promise<unknown> }) => {
        routes.push(route as { kind: string; path: string; handler: (r: unknown) => Promise<unknown> });
      },
    },
  };
  const emitClaimed = (agentId: string, inboxItemId: string, turn: number) =>
    listeners.get("agent/inbox/claimed")?.forEach(l =>
      l({ agent: fakeAgent(agentId, { id: agentId }), message: { id: inboxItemId }, turn }),
    );
  const emitDiscarded = (agentId: string, inboxItemId: string) =>
    listeners.get("agent/inbox/discarded")?.forEach(l =>
      l({ agent: fakeAgent(agentId, { id: agentId }), message: { id: inboxItemId } }),
    );
  const emitSessionEvent = (sessionId: string, event: DshSessionEvent) =>
    listeners.get("session/event")?.forEach(l => l({ header: { id: sessionId } }, event));
  return { ctx, listeners, storage, routes, emitClaimed, emitDiscarded, emitSessionEvent };
}

const TOKEN = "probe-token";
const authHeaders = { [TOKEN_HEADER]: TOKEN };

describe("dsh chatgpt-bridge host plugin", () => {
  test("registers the control route on apply", () => {
    const { ctx, routes } = makeCtx(new Map());
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    plugin.apply();
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe("/chatgpt-bridge");
  });

  test("deliver enqueues followup and reports SUBMITTED_UNVERIFIED (enqueue ≠ completion)", async () => {
    const followups: DshUserMessage[] = [];
    const { ctx } = makeCtx(new Map([["session-1", { followups }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const response = await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "please inspect this", chatConversationId: "12345678-90ab-4cde-8f01-234567890abc", inboxItemId: "item-1" },
    });
    expect(response.status).toBe(202);
    expect((response.body as { state: string }).state).toBe("SUBMITTED_UNVERIFIED");
    expect(followups).toHaveLength(1);
    expect(followups[0]!.content).toBe("please inspect this");
  });

  test("missing/unknown session is TARGET_NOT_FOUND, never fabricated", async () => {
    const { ctx } = makeCtx(new Map());
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const response = await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-x/deliver",
      headers: authHeaders,
      body: { message: "hi" },
    });
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe("TARGET_NOT_FOUND");
  });

  test("bad or missing control token is AUTH_REQUIRED", async () => {
    const { ctx } = makeCtx(new Map([["session-1", { followups: [] }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const response = await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: { "x-bridge-token": "wrong" },
      body: { message: "hi" },
    });
    expect(response.status).toBe(401);
  });

  test("claimed turn + assistant message + turn end correlate into the binding state", async () => {
    const { ctx, emitClaimed, emitSessionEvent } = makeCtx(new Map([["session-1", { followups: [] }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "go", inboxItemId: "item-9", chatConversationId: "12345678-90ab-4cde-8f01-234567890abc" },
    });
    emitClaimed("session-1", "item-9", 7);
    emitSessionEvent("session-1", { type: "assistant/message", turn: 7, step: 1, message: { id: "assistant-7" } });
    emitSessionEvent("session-1", { type: "turn/end", turn: 7, reason: "end_turn" });

    const view = await plugin.handler({
      method: "GET",
      path: "/chatgpt-bridge/session-1/binding",
      headers: authHeaders,
    });
    expect(view.status).toBe(200);
    const binding = (view.body as { binding: Record<string, unknown> }).binding;
    expect(binding.lastClaimedTurn).toBe(7);
    expect(binding.lastAssistantMessageId).toBe("assistant-7");
    expect(binding.lastTurnEnded).toBe(7);
  });

  test("an in-flight turn (claimed, not ended) makes the target active", async () => {
    const { ctx, emitClaimed } = makeCtx(new Map([["session-1", { followups: [] }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "first", inboxItemId: "item-1" },
    });
    emitClaimed("session-1", "item-1", 3);
    const second = await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "second" },
    });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe("TARGET_ACTIVE");
  });

  test("binding to a different chat is rejected with BINDING_CHANGED", async () => {
    const { ctx } = makeCtx(new Map([["session-1", { followups: [] }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "first", chatConversationId: "12345678-90ab-4cde-8f01-234567890abc" },
    });
    const swapped = await plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: "second", chatConversationId: "99999999-90ab-4cde-8f01-234567890abc" },
    });
    expect(swapped.status).toBe(409);
    expect((swapped.body as { code: string }).code).toBe("BINDING_CHANGED");
  });

  test("subagent-owned sessions are rejected on the deliver path, origin or lineage", async () => {
    const { ctx } = makeCtx(new Map([
      ["child-by-origin", { followups: [], header: { id: "child-by-origin", origin: "subagent" as const } }],
      ["child-by-lineage", { followups: [], header: { id: "child-by-lineage", parentSession: "parent-1" } }],
    ]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    for (const sessionId of ["child-by-origin", "child-by-lineage"]) {
      const response = await plugin.handler({
        method: "POST",
        path: `/chatgpt-bridge/${sessionId}/deliver`,
        headers: authHeaders,
        body: { message: "go", inboxItemId: "item-1" },
      });
      expect(response.status, sessionId).toBe(409);
      expect((response.body as { code: string }).code, sessionId).toBe("CONTEXT_INCOMPATIBLE");
    }
  });

  test("two concurrent deliveries cannot both be accepted: the second loses nothing it delivered", async () => {
    const followups: DshUserMessage[] = [];
    const { ctx } = makeCtx(new Map([["session-1", { followups }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const deliver = (inboxItemId: string) => plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: `prompt ${inboxItemId}`, inboxItemId },
    });
    const [first, second] = await Promise.all([deliver("item-A"), deliver("item-B")]);
    const accepted = [first, second].filter(response => response.status === 202);
    expect(accepted).toHaveLength(1);
    expect(followups).toHaveLength(1);
    const refused = [first, second].find(response => response.status !== 202)!;
    expect((refused.body as { code: string }).code).toBe("TARGET_ACTIVE");
    const view = await plugin.handler({ method: "GET", path: "/chatgpt-bridge/session-1/binding", headers: authHeaders });
    expect((view.body as { binding: { lastDeliveredInboxItemId: string } }).binding.lastDeliveredInboxItemId)
      .toBe((accepted[0]!.body as { inboxItemId: string }).inboxItemId);
  });

  test("a discarded delivery that was never claimed frees the binding for the next send", async () => {
    const { ctx, emitDiscarded } = makeCtx(new Map([["session-1", { followups: [] }]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const deliver = (inboxItemId: string) => plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: `prompt ${inboxItemId}`, inboxItemId },
    });
    await deliver("item-1");
    const blocked = await deliver("item-2");
    expect((blocked.body as { code: string }).code).toBe("TARGET_ACTIVE");
    emitDiscarded("session-1", "item-1");
    const retry = await deliver("item-2");
    expect(retry.status).toBe(202);
  });

  test("an unclaimed delivery stops holding the gate once it is older than the stale window", async () => {
    // The host may never emit `agent/inbox/discarded`; that must not wedge the
    // session for the rest of its life.
    const session1 = { followups: [] as DshUserMessage[] };
    const { ctx } = makeCtx(new Map([["session-1", session1]]));
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    const deliver = (inboxItemId: string) => plugin.handler({
      method: "POST",
      path: "/chatgpt-bridge/session-1/deliver",
      headers: authHeaders,
      body: { message: `prompt ${inboxItemId}`, inboxItemId },
    });
    const at = (seconds: number) => setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)));
    try {
      at(0);
      await deliver("item-1");
      expect((await deliver("item-2")).status).toBe(409);
      // Pin the ceiling from below as well: anything <= 119 s would already let item-2
      // through here, and the stale window the core uses is 120 s.
      at(119);
      expect((await deliver("item-2")).status).toBe(409);
      at(121);
      expect((await deliver("item-2")).status).toBe(202);
      // A 202 must mean work was actually enqueued, not just a status code.
      expect(session1.followups.map(message => message.id)).toEqual(["item-1", "item-2"]);

      // A delivery whose turn the host did claim still refuses: that turn may be
      // running, and overwriting it would leave the answer unattributable.
      const { ctx: claimedCtx, emitClaimed } = makeCtx(new Map([["session-2", { followups: [] }]]));
      const claimed = createBridgePlugin(claimedCtx, { controlToken: TOKEN });
      const toClaimed = (inboxItemId: string) => claimed.handler({
        method: "POST", path: "/chatgpt-bridge/session-2/deliver",
        headers: authHeaders, body: { message: `prompt ${inboxItemId}`, inboxItemId },
      });
      at(0);
      expect((await toClaimed("item-3")).status).toBe(202);
      emitClaimed("session-2", "item-3", 11);
      await Bun.sleep(0);
      const view = await claimed.handler({
        method: "GET", path: "/chatgpt-bridge/session-2/binding", headers: authHeaders,
      });
      // Without this the assertion below could be the unclaimed branch answering.
      expect((view.body as { binding: { lastClaimedTurn: number | null } }).binding.lastClaimedTurn).toBe(11);
      at(121);
      expect((await toClaimed("item-4")).status).toBe(409);
      expect((await claimed.handler({
        method: "GET", path: "/chatgpt-bridge/session-2/binding", headers: authHeaders,
      })).body).toMatchObject({ binding: { lastDeliveredInboxItemId: "item-3" } });
    } finally {
      setSystemTime(null);
    }
  });
});
