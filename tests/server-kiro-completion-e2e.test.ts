import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../src/adapters/kiro-constants";
import { saveConfig } from "../src/config";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { startServer } from "../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const enc = new TextEncoder();
const originalFetch = globalThis.fetch;

let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-completion-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-completion-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.KIRO_REGION = "us-east-1";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = previousRegion;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(testDir, { recursive: true, force: true });
});

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": eventType },
    enc.encode(JSON.stringify(payload)),
  );
}

function textFrame(text: string): Uint8Array {
  return eventFrame("assistantResponseEvent", { content: text });
}

function completionFrames(answer: string, id = "completion-1"): Uint8Array[] {
  const input = JSON.stringify({ answer });
  return [
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, input }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, stop: true }),
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

function kiroConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kiro-test",
    providers: {
      "kiro-test": {
        adapter: "kiro",
        baseUrl,
        authMode: "key",
        apiKey: "synthetic-token",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["gpt-5.6-sol"],
      },
    },
  } as OcxConfig;
}

function scriptedKiroUpstream(attempts: Uint8Array[][]) {
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Record<string, any>);
      const frames = attempts.shift();
      if (!frames) return new Response("unexpected extra Kiro attempt", { status: 500 });
      return new Response(streamOf(frames), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    },
  });
  return { server, requests };
}

function kiroToolNames(request: Record<string, any>): string[] {
  return request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map(
    (tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name,
  );
}

function responseEvents(sse: string): Array<{ name: string; data: Record<string, any> }> {
  return sse.split("\n\n").flatMap(frame => {
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!name || !data) return [];
    return [{ name, data: JSON.parse(data) as Record<string, any> }];
  });
}

function anthropicEvents(sse: string): Array<{ name: string; data: Record<string, any> }> {
  return responseEvents(sse);
}

describe("Kiro completion through public server endpoints", () => {
  test("/v1/responses keeps progress nonterminal and lets only the bounded fallback complete", async () => {
    const upstream = scriptedKiroUpstream([
      [textFrame("Checking the workspace.")],
      completionFrames("The workspace is ready."),
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          input: "Inspect the workspace",
          stream: true,
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = responseEvents(wire);
      const text = events.filter(event => event.name === "response.output_text.delta");
      expect(text.map(event => [event.data.delta, event.data.phase])).toEqual([
        ["Checking the workspace.", undefined],
        ["The workspace is ready.", undefined],
      ]);
      const completed = events.filter(event => event.name === "response.completed");
      expect(completed).toHaveLength(1);
      expect(events.at(-1)?.name).toBe("response.completed");
      const messages = completed[0].data.response.output.filter((item: { type: string }) => item.type === "message");
      expect(messages.map((item: { phase?: string }) => item.phase)).toEqual(["commentary", "final_answer"]);
      expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);

      expect(upstream.requests).toHaveLength(2);
      expect(kiroToolNames(upstream.requests[0])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(kiroToolNames(upstream.requests[1])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(upstream.requests[1].conversationState.history.at(-1).assistantResponseMessage.content)
        .toBe("Checking the workspace.");
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  test.each([
    ["validated completion", completionFrames("The Claude task is complete.")],
    ["accepted text fallback", [textFrame("The Claude task is complete.")]],
  ])("/v1/messages hides the private tool and ends after %s", async (_label, fallbackFrames) => {
    const upstream = scriptedKiroUpstream([
      [textFrame("I am checking the Claude task.")],
      fallbackFrames,
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/messages", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          max_tokens: 256,
          stream: true,
          messages: [{ role: "user", content: "Inspect the Claude task" }],
          tools: [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = anthropicEvents(wire);
      const deltas = events
        .filter(event => event.name === "content_block_delta" && event.data.delta?.type === "text_delta")
        .map(event => event.data.delta.text);
      expect(deltas).toEqual(["I am checking the Claude task.", "The Claude task is complete."]);
      expect(events.filter(event => event.name === "message_delta")).toHaveLength(1);
      expect(events.find(event => event.name === "message_delta")?.data.delta.stop_reason).toBe("end_turn");
      expect(events.at(-1)?.name).toBe("message_stop");
      expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);

      expect(upstream.requests).toHaveLength(2);
      expect(kiroToolNames(upstream.requests[0])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(kiroToolNames(upstream.requests[1])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });


  test("answer-like prose plus a completion answer in ONE inference renders exactly one answer", async () => {
    // The user-visible defect: Kiro emits answer-shaped prose and then calls the private completion
    // tool in the SAME inference. Releasing both made bridge.ts close the commentary message and
    // open a second one with near-identical text, so the client rendered the answer twice.
    // Adapter-event coverage cannot prove this is gone — the split happens in the bridge.
    const upstream = scriptedKiroUpstream([
      [textFrame("The workspace is ready."), ...completionFrames("The workspace is ready.")],
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          input: "Inspect the workspace",
          stream: true,
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = responseEvents(wire);

      // One inference only: the completion answer resolves the turn, so no bounded fallback runs.
      expect(upstream.requests).toHaveLength(1);

      // Exactly one visible assistant answer, and the prose is not repeated as its own message.
      const completed = events.filter(event => event.name === "response.completed");
      expect(completed).toHaveLength(1);
      const messages = completed[0].data.response.output.filter((item: { type: string }) => item.type === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0].phase).toBe("final_answer");
      expect(messages[0].content.map((part: { text: string }) => part.text).join("")).toBe("The workspace is ready.");

      // And the duplicate is gone at the delta level too, not merely coalesced into one message.
      const deltas = events
        .filter(event => event.name === "response.output_text.delta")
        .map(event => event.data.delta);
      expect(deltas.join("")).toBe("The workspace is ready.");

      expect(events.at(-1)?.name).toBe("response.completed");
      expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  test("routed compaction with text.format summarizes instead of tripping the capability guard", async () => {
    const upstream = scriptedKiroUpstream([
      [textFrame("Compaction summary of the earlier turns.")],
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
            { type: "compaction_trigger" },
          ],
          // Routed compaction must strip the structured-output request: the Kiro guard
          // refuses structured output, and a surviving json_schema would constrain what has
          // to be a plain prose summary.
          text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json() as { output?: Array<{ type?: string }> };
      expect((json.output ?? []).filter(item => item.type === "compaction")).toHaveLength(1);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  // A turn whose replayed history already ENDS with a delivered final answer has nothing to ask
  // Kiro. Before the local terminal, the adapter appended a trailing user turn — neutral wording,
  // but structurally still a prompt — and performed a real inference, so the model answered the
  // closed task again and a finished turn behaved like a still-open goal.
  //
  // `emptyCompletionRetry` is exercised BOTH ways on purpose. A local terminal produces no content,
  // which is exactly the shape that guard re-invokes: if the short-circuit were routed through the
  // ordinary event path, the enabled case would send the request the fix exists to prevent, and a
  // guard-off-only test would pass while the user's own config still looped.
  for (const emptyCompletionRetry of [false, true]) {
    for (const stream of [true, false]) {
      test(`a delivered final answer sends nothing upstream (emptyCompletionRetry=${emptyCompletionRetry}, stream=${stream})`, async () => {
        const upstream = scriptedKiroUpstream([]);
        saveConfig({ ...kiroConfig(upstream.server.url.toString()), emptyCompletionRetry } as OcxConfig);
        const proxy = startServer(0);
        try {
          const response = await originalFetch(new URL("/v1/responses", proxy.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "kiro-test/gpt-5.6-sol",
              stream,
              input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
                {
                  type: "message",
                  role: "assistant",
                  phase: "final_answer",
                  content: [{ type: "output_text", text: "Code mode runs JavaScript that calls tools." }],
                },
              ],
              tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
            }),
          });

          expect(response.status).toBe(200);
          const body = await response.text();
          // The load-bearing assertion: zero upstream requests. The scripted upstream has no
          // attempts queued, so any send would also answer 500 and fail the status check above.
          expect(upstream.requests).toHaveLength(0);

          if (stream) {
            const events = responseEvents(body);
            expect(events.filter(event => event.name === "response.completed")).toHaveLength(1);
            expect(events.some(event => event.name === "response.output_text.delta")).toBe(false);
            // The empty-completion guard's failure event must not appear: a local terminal is a
            // deliberate no-inference turn, not an upstream empty completion.
            expect(body).not.toContain("empty_completion_retry_failed");
          } else {
            const json = JSON.parse(body) as { status?: string; output?: unknown[] };
            expect(json.status).toBe("completed");
            expect(json.output ?? []).toHaveLength(0);
          }
        } finally {
          await proxy.stop(true);
          upstream.server.stop(true);
        }
      });
    }
  }

  test("a proxy-recorded final answer suppresses replay when the client drops phase", async () => {
    const deliveredAnswer = "Code mode runs JavaScript that calls tools.";
    const upstream = scriptedKiroUpstream([completionFrames(deliveredAnswer)]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const first = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-recorded-final-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: "what is code mode",
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });
      expect(first.status).toBe(200);
      await first.text();
      expect(upstream.requests).toHaveLength(1);

      const replay = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-recorded-final-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: deliveredAnswer }],
            },
          ],
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(replay.status).toBe(200);
      expect((await replay.json() as { output?: unknown[] }).output ?? []).toHaveLength(0);
      // The second turn is byte-for-byte replay history except for the client-dropped phase. A
      // send here means the proxy forgot its own delivered answer and restarted finished work.
      expect(upstream.requests).toHaveLength(1);

      // Suppression must SURVIVE being used. A local terminal emits no output, so it writes no new
      // record; if the read consumed or overwrote the original one, the second identical replay
      // would send upstream and the loop this fix exists to end would return one turn later. The
      // observed live failure was exactly a repeated identical history, not a single stray turn.
      const replayAgain = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-recorded-final-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: deliveredAnswer }],
            },
          ],
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });
      expect(replayAgain.status).toBe(200);
      expect((await replayAgain.json() as { output?: unknown[] }).output ?? []).toHaveLength(0);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  test("a new user request after a proxy-recorded final answer is not suppressed", async () => {
    const deliveredAnswer = "Code mode runs JavaScript that calls tools.";
    const upstream = scriptedKiroUpstream([
      completionFrames(deliveredAnswer),
      completionFrames("Yes — one JavaScript cell can make several tool calls."),
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const first = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-recorded-follow-up-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: "what is code mode",
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });
      expect(first.status).toBe(200);
      await first.text();

      const followUp = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-recorded-follow-up-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: deliveredAnswer }],
            },
            { type: "message", role: "user", content: [{ type: "input_text", text: "so it batches calls?" }] },
          ],
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(followUp.status).toBe(200);
      await followUp.text();
      // A later user message is the new work. The remembered answer may suppress only when that
      // same assistant answer is still the trailing content-bearing message.
      expect(upstream.requests).toHaveLength(2);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  test("a recorded final answer is isolated to its conversation scope", async () => {
    const deliveredAnswer = "Code mode runs JavaScript that calls tools.";
    const upstream = scriptedKiroUpstream([
      completionFrames(deliveredAnswer),
      completionFrames("This is a separate thread, so I answered independently."),
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const first = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-record-owner-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: "what is code mode",
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });
      expect(first.status).toBe(200);
      await first.text();

      const otherThread = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "kiro-record-other-thread" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: deliveredAnswer }],
            },
          ],
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(otherThread.status).toBe(200);
      await otherThread.text();
      expect(upstream.requests).toHaveLength(2);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  // Control for the above: the predicate keys off the trailing turn, so a genuine follow-up
  // question after a delivered answer is an ordinary turn and MUST still reach Kiro. Without this,
  // a short-circuit that swallowed every turn would pass the tests above.
  test("a real user follow-up after a delivered final answer still reaches Kiro", async () => {
    const upstream = scriptedKiroUpstream([completionFrames("Yes — one JavaScript cell, many tool calls.")]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
            {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "Code mode runs JavaScript that calls tools." }],
            },
            { type: "message", role: "user", content: [{ type: "input_text", text: "so it batches calls?" }] },
          ],
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await proxy.stop(true);
      upstream.server.stop(true);
    }
  });
});

// The behavioural tests above prove nothing was SENT. This one proves the request log says so.
// The C-phase verifier caught exactly this gap: the first implementation logged the local terminal
// with `estimated: true`, because Kiro usage is marked estimated provider-wide. Zero counts from a
// turn that made no inference are exact, and a row that claims otherwise is indistinguishable from
// a real turn whose usage frame never arrived.
describe("Kiro local terminal accounting", () => {
  for (const stream of [true, false]) {
    test(`a delivered final answer logs exact zero usage and no send (stream=${stream})`, async () => {
      const upstream = scriptedKiroUpstream([]);
      saveConfig(kiroConfig(upstream.server.url.toString()));
      clearRequestLogsForTests();
      const proxy = startServer(0);
      try {
        const response = await originalFetch(new URL("/v1/responses", proxy.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "kiro-test/gpt-5.6-sol",
            stream,
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "what is code mode" }] },
              {
                type: "message",
                role: "assistant",
                phase: "final_answer",
                content: [{ type: "output_text", text: "Code mode runs JavaScript that calls tools." }],
              },
            ],
            tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
          }),
        });
        expect(response.status).toBe(200);
        // The streaming log is written when the body finishes, so drain it before reading.
        await response.text();
        expect(upstream.requests).toHaveLength(0);

        const entry = getRequestLogEntries().find(row => row.provider === "kiro-test");
        expect(entry).toBeDefined();
        expect(entry!.localTerminalReason).toBe("kiro_final_answer_already_delivered");
        // Exact, not estimated: this is the assertion the first implementation failed.
        expect(entry!.usageStatus).toBe("reported");
        expect(entry!.usage?.estimated).toBeUndefined();
        expect(entry!.usage?.inputTokens).toBe(0);
        expect(entry!.usage?.outputTokens).toBe(0);
        expect(entry!.attempts?.every(attempt => attempt.sendCount === 0) ?? true).toBe(true);
        expect(entry!.attempts?.every(attempt => attempt.inputTokenEstimate === undefined) ?? true).toBe(true);
        // The EMBEDDED attempt must agree with its parent row. The re-verification caught this
        // exact gap: the row read exact while its own attempt still said "estimated", and the
        // attempt is the detailed accounting a maintainer reads for a zero-send turn.
        for (const attempt of entry!.attempts ?? []) {
          expect(attempt.usageStatus).toBe("reported");
          expect(attempt.usage?.estimated).toBeUndefined();
        }
      } finally {
        await proxy.stop(true);
        upstream.server.stop(true);
      }
    });
  }
});
