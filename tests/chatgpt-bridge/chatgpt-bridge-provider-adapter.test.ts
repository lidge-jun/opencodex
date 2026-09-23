import { describe, expect, test } from "bun:test";
import { createRegisteredAdapter, getAdapterDefinition } from "../../src/adapters/registry";
import { createChatGptWebAdapter } from "../../src/chatgpt-bridge/provider/adapter";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import type { IncomingMeta } from "../../src/adapters/base";

function provider(): OcxProviderConfig {
  return { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com" } as OcxProviderConfig;
}

function incoming(): IncomingMeta {
  return { headers: new Headers(), translatorBudget: {} as IncomingMeta["translatorBudget"] };
}

describe("chatgpt-web adapter", () => {
  test("registry resolves the chatgpt-web wire", () => {
    expect(getAdapterDefinition("chatgpt-web")).toBeDefined();
    const adapter = createRegisteredAdapter(provider(), {} as never);
    expect(adapter.name).toBe("chatgpt-web");
  });

  test("without a transport every turn fails with CHATGPT_WEB_TRANSPORT_UNAVAILABLE and no fabricated output", async () => {
    const adapter = createChatGptWebAdapter(provider());
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      { modelId: "chatgpt-web/luna", context: {}, stream: true, options: {} } as never,
      incoming(),
      event => events.push(event),
    );
    expect(events).toHaveLength(1);
    const error = events[0] as Extract<AdapterEvent, { type: "error" }>;
    expect(error.code).toBe("CHATGPT_WEB_TRANSPORT_UNAVAILABLE");
    expect(error.retryable).toBe(false);
  });

  test("with a transport events flow through and transport failures stay terminal", async () => {
    const emitted: AdapterEvent[] = [
      { type: "text_delta", text: "real model output" },
      { type: "done", endTurn: true },
    ];
    let turnContext: unknown;
    const adapter = createChatGptWebAdapter(provider(), {
      transport: {
        runTurn: async (context, _incoming, emit) => {
          turnContext = context;
          for (const event of emitted) emit(event);
        },
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      { modelId: "chatgpt-web/high", context: { preview: true }, stream: true, options: {} } as never,
      incoming(),
      event => events.push(event),
    );
    expect(events).toEqual(emitted);
    expect((turnContext as { modelId: string }).modelId).toBe("chatgpt-web/high");

    const failing = createChatGptWebAdapter(provider(), {
      transport: {
        runTurn: async () => {
          throw new Error("DELIVERY_UNKNOWN-style transport crash");
        },
      },
    });
    const failures: AdapterEvent[] = [];
    await failing.runTurn!(
      { modelId: "chatgpt-web/luna", context: {}, stream: true, options: {} } as never,
      incoming(),
      event => failures.push(event),
    );
    const error = failures[0] as Extract<AdapterEvent, { type: "error" }>;
    expect(error.code).toBe("CHATGPT_WEB_TRANSPORT_FAILURE");
    expect(error.retryable).toBe(false);
  });

  test("parseStream path is explicitly disabled", async () => {
    const adapter = createChatGptWebAdapter(provider());
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream!()) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });
});
