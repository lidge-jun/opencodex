/**
 * Regression contract for GitHub Copilot's Responses SSE dialect.
 *
 * Copilot rotates opaque response/item ids between events, exposes encrypted
 * reasoning, and pads streamed tool deltas. Those fields are valid for the
 * vscode-chat client, but not for a stock Responses client such as codex-rs.
 * The proxy must expose one internally consistent, plaintext Responses stream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

interface SseEvent {
  event?: string;
  data: string;
  payload?: Record<string, unknown>;
}

function copilotProvider(): OcxProviderConfig {
  return {
    ...providerConfigSeed(getProviderRegistryEntry("github-copilot")!),
    authMode: "key",
    apiKey: "sk-test",
  };
}

function sse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim();
      if (data === undefined) return null;
      if (data === "[DONE]") return { event, data };
      try {
        return { event, data, payload: JSON.parse(data) as Record<string, unknown> };
      } catch {
        return { event, data };
      }
    })
    .filter((event): event is SseEvent => event !== null);
}

const COPILOT_OBFUSCATED_STREAM = [
  sse("response.created", {
    type: "response.created",
    sequence_number: 20,
    response: { id: "resp-created", status: "in_progress", output: [] },
  }),
  sse("response.in_progress", {
    type: "response.in_progress",
    sequence_number: 21,
    response: { id: "resp-in-progress", status: "in_progress", output: [] },
  }),
  sse("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: 22,
    output_index: 0,
    item: {
      type: "reasoning",
      id: "rs-added",
      summary: [],
      content: [],
      encrypted_content: "cipher-reasoning-added",
    },
  }),
  sse("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    sequence_number: 23,
    output_index: 0,
    item_id: "rs-delta",
    summary_index: 0,
    delta: "résumé lisible",
    obfuscation: "copilot-vscode-chat",
  }),
  sse("response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: 24,
    output_index: 0,
    item: {
      type: "reasoning",
      id: "rs-done",
      summary: [],
      content: [],
      encrypted_content: "cipher-reasoning-done",
    },
  }),
  sse("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: 25,
    output_index: 1,
    item: {
      type: "custom_tool_call",
      id: "ctc-added",
      call_id: "call-patch",
      name: "apply_patch",
      input: "",
      status: "in_progress",
    },
  }),
  sse("response.custom_tool_call_input.delta", {
    type: "response.custom_tool_call_input.delta",
    sequence_number: 26,
    output_index: 1,
    item_id: "ctc-delta",
    delta: "cipher-tool-delta",
    obfuscation: "copilot-vscode-chat",
  }),
  sse("response.custom_tool_call_input.done", {
    type: "response.custom_tool_call_input.done",
    sequence_number: 27,
    output_index: 1,
    item_id: "ctc-input-done",
    input: "*** Begin Patch\n*** End Patch",
  }),
  sse("response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: 28,
    output_index: 1,
    item: {
      type: "custom_tool_call",
      id: "ctc-done",
      call_id: "call-patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
      status: "completed",
    },
  }),
  sse("response.completed", {
    type: "response.completed",
    sequence_number: 29,
    response: {
      id: "resp-completed",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs-completed",
          summary: [],
          content: [],
          encrypted_content: "cipher-reasoning-completed",
        },
        {
          type: "custom_tool_call",
          id: "ctc-completed",
          call_id: "call-patch",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
          status: "completed",
        },
      ],
    },
  }),
  "data: [DONE]\n\n",
].join("");

describe("GitHub Copilot Responses client stream contract", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("normalizes obfuscated Copilot SSE before it reaches Codex", async () => {
    globalThis.fetch = (async () => new Response(COPILOT_OBFUSCATED_STREAM, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const config = {
      providers: { "github-copilot": copilotProvider() },
    } as unknown as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "github-copilot/gpt-5.6-luna",
          input: "Use apply_patch",
          stream: true,
        }),
      }),
      config,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    const events = parseSse(body);
    const payloads = events.flatMap(event => event.payload ? [event.payload] : []);

    // Copilot-only ciphertext/metadata must never leak onto the stock Responses wire.
    expect(body).not.toContain("obfuscation");
    expect(body).not.toContain("encrypted_content");
    expect(body).not.toContain("cipher-");
    expect(body).toContain("résumé lisible");

    // The first-seen response id is the public id for the whole streamed response.
    const created = payloads.find(event => event.type === "response.created")!;
    const inProgress = payloads.find(event => event.type === "response.in_progress")!;
    const completed = payloads.find(event => event.type === "response.completed")!;
    expect((inProgress.response as { id: string }).id)
      .toBe((created.response as { id: string }).id);
    expect((completed.response as { id: string }).id)
      .toBe((created.response as { id: string }).id);

    // All events for an output item must agree on the id Codex first observed.
    const reasoningIds = payloads.flatMap((event) => {
      if (event.output_index !== 0) return [];
      if (typeof event.item_id === "string") return [event.item_id];
      const item = event.item as { id?: unknown } | undefined;
      return typeof item?.id === "string" ? [item.id] : [];
    });
    expect(new Set(reasoningIds)).toEqual(new Set(["rs-added"]));

    const customIds = payloads.flatMap((event) => {
      if (event.output_index !== 1) return [];
      if (typeof event.item_id === "string") return [event.item_id];
      const item = event.item as { id?: unknown } | undefined;
      return typeof item?.id === "string" ? [item.id] : [];
    });
    expect(new Set(customIds)).toEqual(new Set(["ctc-added"]));

    // Obfuscated deltas are replaced by one plaintext delta before the authoritative done.
    const customEvents = payloads.filter(event =>
      event.type === "response.custom_tool_call_input.delta"
      || event.type === "response.custom_tool_call_input.done");
    expect(customEvents.map(event => event.type)).toEqual([
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
    ]);
    expect(customEvents.map(event => event.delta ?? event.input)).toEqual([
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** End Patch",
    ]);

    // The client sees a coherent ordered stream and a real terminal marker.
    expect(payloads.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.at(-1)?.data).toBe("[DONE]");
  });
});
