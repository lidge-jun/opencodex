/**
 * Opt-in compactionDropRetainedRequests (#6764 follow-up to #7003). Codex's replacement history
 * keeps recent user requests verbatim in front of a SUMMARY_PREFIX checkpoint; with the option on,
 * those requests are removed from later turns on every route. Construction evidence only: these
 * cases pin what reaches the wire, not how a model behaves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SUMMARY_PREFIX, encodeCompactionSummary } from "../../src/responses/compaction";
import { dropRequestsRetainedBeforeCheckpoint } from "../../src/responses/compaction-retained-requests";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const OLD_A = "Inspect example.txt and tell me whether it is readable.";
const OLD_B = "Now summarize the review notes.";
const CHECKPOINT = `${SUMMARY_PREFIX}\nA is complete. B (continue review 1731) is active.`;
const LATER = "Continue.";
const ENV = "<environment_context>\n  <cwd>/tmp/x</cwd>\n</environment_context>";
const AGENTS = "# AGENTS.md instructions for /tmp/x\n\nUse tabs.";

function texts(input: unknown[]): string[] {
  return input.map(item => {
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(part => (part as { text?: string }).text ?? "").join("\n");
    return `<${String((item as { type?: unknown }).type)}>`;
  });
}

describe("dropRequestsRetainedBeforeCheckpoint", () => {
  test("drops plain-text requests before the latest checkpoint and keeps everything after it", () => {
    const result = dropRequestsRetainedBeforeCheckpoint([user(OLD_A), user(OLD_B), user(CHECKPOINT), user(LATER)]);
    expect(result).not.toBeNull();
    expect(result!.removedIndices).toEqual([0, 1]);
    expect(texts(result!.input)).toEqual([CHECKPOINT, LATER]);
  });

  test("keeps contextual wrappers, non-text content, other roles and earlier checkpoints", () => {
    const image = { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:x" }] };
    const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
    const earlier = user(`${SUMMARY_PREFIX}\nolder checkpoint`);
    const input = [user(ENV), user(AGENTS), earlier, image, assistant, call, { role: "user", content: OLD_A }, user(CHECKPOINT)];
    const result = dropRequestsRetainedBeforeCheckpoint(input);
    expect(result!.removedIndices).toEqual([6]);
    expect(result!.input).toEqual(input.filter((_, index) => index !== 6));
  });

  test("is a no-op without a plaintext checkpoint, on summarizer turns and when nothing qualifies", () => {
    expect(dropRequestsRetainedBeforeCheckpoint([user(OLD_A), user(LATER)])).toBeNull();
    // An opaque native blob carries no readable summary; nothing may be dropped in front of it.
    expect(dropRequestsRetainedBeforeCheckpoint([user(OLD_A), { type: "compaction", encrypted_content: "gAAAA-native" }, user(LATER)])).toBeNull();
    // A decoded ocx1 item is handled by the #7003 continuation note, not by this option.
    expect(dropRequestsRetainedBeforeCheckpoint([user(OLD_A), { type: "compaction", encrypted_content: encodeCompactionSummary("x") }])).toBeNull();
    expect(dropRequestsRetainedBeforeCheckpoint([user(OLD_A), user(CHECKPOINT), { type: "compaction_trigger" }])).toBeNull();
    expect(dropRequestsRetainedBeforeCheckpoint([user(ENV), user(CHECKPOINT), user(LATER)])).toBeNull();
    expect(dropRequestsRetainedBeforeCheckpoint([user(CHECKPOINT), user(LATER)])).toBeNull();
    expect(dropRequestsRetainedBeforeCheckpoint("plain string input")).toBeNull();
  });
});

describe("compactionDropRetainedRequests on the request path", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  function config(adapter: "openai-responses" | "openai-chat", enabled: boolean | undefined): OcxConfig {
    return {
      defaultProvider: "gw",
      providers: { gw: { adapter, baseUrl: "https://gw.example.invalid/v1", authMode: "key", apiKey: "test-key" } },
      ...(enabled === undefined ? {} : { compactionDropRetainedRequests: enabled }),
    } as unknown as OcxConfig;
  }

  async function upstreamBody(cfg: OcxConfig, input: unknown[]): Promise<Record<string, unknown>> {
    const bodies: string[] = [];
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(request instanceof Request ? await request.clone().text() : typeof init?.body === "string" ? init.body : "");
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    releaseSpendHome = acquireOwnedSpendHome();
    const turn = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gw/some-model", input, stream: true }),
    }), cfg, { model: "", provider: "" });
    await turn.text();
    expect(bodies.length).toBeGreaterThan(0);
    return JSON.parse(bodies[0]!) as Record<string, unknown>;
  }

  const history = () => [user(ENV), user(OLD_A), user(OLD_B), user(CHECKPOINT), user(LATER)];
  const wireText = (body: Record<string, unknown>) => JSON.stringify(body.input ?? body.messages);

  for (const adapter of ["openai-responses", "openai-chat"] as const) {
    test(`${adapter}: on removes the retained requests and keeps context, checkpoint and later turns`, async () => {
      const wire = wireText(await upstreamBody(config(adapter, true), history()));
      expect(wire).not.toContain(OLD_A);
      expect(wire).not.toContain(OLD_B);
      expect(wire).toContain("environment_context");
      expect(wire).toContain("B (continue review 1731) is active.");
      expect(wire.indexOf("B (continue review 1731) is active.")).toBeLessThan(wire.lastIndexOf(LATER));
    });

    test(`${adapter}: absent or off leaves the history unchanged`, async () => {
      for (const enabled of [undefined, false]) {
        const wire = wireText(await upstreamBody(config(adapter, enabled), history()));
        expect(wire).toContain(OLD_A);
        expect(wire).toContain(OLD_B);
        releaseSpendHome?.();
        releaseSpendHome = undefined;
      }
    });
  }
});
