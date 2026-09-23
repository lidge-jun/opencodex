import { describe, expect, test } from "bun:test";
import { createBridgePlugin, TOKEN_HEADER, type DshPluginContext, type DshSessionEvent, type DshUserMessage } from "../../extensions/dsh-chatgpt-bridge/src/host";

interface Listener {
  (payload: unknown): void | Promise<void>;
}

function makeCtx(agents: Map<string, { followups: DshUserMessage[] }>) {
  const listeners = new Map<string, Set<Listener>>();
  const storage = new Map<string, unknown>();
  const routes: Array<{ kind: string; path: string; handler: (r: unknown) => Promise<unknown> }> = [];
  const ctx: DshPluginContext = {
    agents: {
      get: (id: string) => {
        const record = agents.get(id);
        if (!record) return undefined;
        return {
          id,
          followup: (message: DshUserMessage) => {
            record.followups.push(message);
            listeners.get("agent/inbox/inserted")?.forEach(l => l({ agent: { id, followup: () => {} }, message: { id: message.id } }));
          },
          whenIdle: async () => {},
        };
      },
      isOwnedBy: () => false,
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
      l({ agent: { id: agentId, followup: () => {} }, message: { id: inboxItemId }, turn }),
    );
  const emitSessionEvent = (sessionId: string, event: DshSessionEvent) =>
    listeners.get("session/event")?.forEach(l => l({ header: { id: sessionId } }, event));
  return { ctx, listeners, storage, routes, emitClaimed, emitSessionEvent };
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

  test("subagent-owned sessions are rejected on lineage even when the parent is gone", () => {
    const { ctx } = makeCtx(new Map());
    const plugin = createBridgePlugin(ctx, { controlToken: TOKEN });
    expect(plugin.isSubagentOwned({ id: "s1", origin: "subagent" })).toBe(true);
    expect(plugin.isSubagentOwned({ id: "s2", parentSession: "parent-1" })).toBe(true);
    expect(plugin.isSubagentOwned({ id: "s3" })).toBe(false);
  });
});
