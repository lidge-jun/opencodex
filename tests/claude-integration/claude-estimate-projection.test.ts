/**
 * The Claude Messages request-token estimate, projected onto the route that will carry it.
 *
 * A Claude Code turn replays its own thinking blocks, and on a long session those blocks dominate
 * the body: on a captured 260-message turn they were 78.8% of the messages JSON, 56.7% of that
 * being base64 signatures. A routed OpenAI Chat wire serializes almost none of it — the signature
 * never, the text only for preserve-listed models — so counting the caller's own blocks published
 * a `message_start.usage.input_tokens` 3.28x the prompt the upstream actually received. Paseo's
 * context meter reads that frame, so it showed 221% of a 180k window while compaction was healthy.
 *
 * These cases pin the measure itself and the wiring that feeds it. The estimator's
 * attachment-pricing behavior lives with the endpoint suite.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { estimateClaudeRequestTokens } from "../../src/server/claude-messages";
import { estimateTokens } from "../../src/lib/token-estimate";
import { projectClaudeRequest } from "../../src/lib/claude-request-projection";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

let testDir = "";
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let isolatedHomeActive = false;

/** Only the end-to-end case needs a home; the estimator cases below are pure. */
function setUpIsolatedHome(): void {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-estimate-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  isolatedHomeActive = true;
}

function restoreIsolatedHome(): void {
  // The preload arms OPENCODEX_HOME for the whole process, so an unpaired restore must not
  // touch it: deleting it here left sibling files running in the same process to write the
  // real home, which the preload guard then refused.
  if (!isolatedHomeActive) return;
  isolatedHomeActive = false;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
}

afterEach(restoreIsolatedHome);

/** A Chat-completions upstream that records what the proxy actually sent it. */
function mockChatUpstreamCapturing(): { server: ReturnType<typeof Bun.serve>; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
    },
  } as OcxConfig;
}

test("estimateClaudeRequestTokens drops replayed thinking the settled Chat wire does not send", () => {
  // The defect this pins (#4857 family): a routed openai-chat turn serializes replayed
  // thinking only as `reasoning_content`, and only for preserve-listed models — the
  // signature is never sent at all. Counting the caller's own blocks made the published
  // message_start floor 3.28x the upstream's reported prompt on a live 260-message turn.
  const thinking = {
    type: "thinking",
    thinking: "T".repeat(60_000),
    signature: "S".repeat(90_000),
  };
  const raw = {
    messages: [
      { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ],
  };
  const partsWithoutThinking = [
    JSON.stringify([{ role: "assistant", content: [{ type: "text", text: "answer" }] }, { role: "user", content: "next" }]),
  ];

  // A route whose wire serializes no replayed thinking counts only what it would send.
  const dropped = estimateClaudeRequestTokens(raw, "m", { text: false, signature: false });
  expect(dropped).toBe(Math.max(1, estimateTokens(partsWithoutThinking.join("\n"), "m")));
  // Signature-only projection still prices the model's own replayed text.
  const textOnly = estimateClaudeRequestTokens(raw, "m", { text: true, signature: false });
  expect(textOnly).toBeGreaterThan(dropped);
  // The native wire forwards the block verbatim, which is the default for an unknown route.
  const native = estimateClaudeRequestTokens(raw, "m", { text: true, signature: true });
  expect(native).toBe(Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")));
  expect(native).toBe(estimateClaudeRequestTokens(raw, "m"));
  // The dropped measure must not still be carrying the signature's bytes.
  expect(dropped).toBeLessThan(native / 3);
});

test("projectClaudeRequest is pure, idempotent, and keeps emptied messages", () => {
  const thinking = { type: "thinking", thinking: "replayed", signature: "sig" };
  const raw = { messages: [{ role: "assistant", content: [thinking] }] };

  const projected = projectClaudeRequest(raw, { text: false, signature: false });
  expect(projected).not.toBe(raw);
  expect(projected.messages).toEqual([{ role: "assistant", content: [] }]);
  // The caller's body is shared with the outbound request builder, so it must be untouched.
  expect(raw.messages).toEqual([{ role: "assistant", content: [thinking] }]);
  // Re-running changes nothing: an emptied content array has no thinking left to drop.
  expect(projectClaudeRequest(projected, { text: false, signature: false })).toEqual(projected);
});

test("estimateClaudeRequestTokens counts a body with no thinking identically under every projection", () => {
  // Guards the default path the pre-existing estimator tests rely on: with nothing to
  // project away, the projection cannot change the answer.
  const raw = {
    system: "be brief",
    messages: [{ role: "user", content: [{ type: "text", text: "no thinking here" }] }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const native = estimateClaudeRequestTokens(raw, "m");
  expect(estimateClaudeRequestTokens(raw, "m", { text: false, signature: false })).toBe(native);
  expect(estimateClaudeRequestTokens(raw, "m", { text: true, signature: false })).toBe(native);
});

test("message_start floor describes the prompt the Chat wire actually sent, not the replayed thinking", async () => {
  // End-to-end pin for the route-aware projection: the estimator must read the SETTLED route,
  // not just accept a projection when handed one. A routed openai-chat turn with no
  // preserveReasoningContentModels entry serializes no replayed thinking, so a floor that
  // still counts it overstates the prompt — the live defect that published 3.28x.
  setUpIsolatedHome();
    const upstream = mockChatUpstreamCapturing();
    saveConfig(mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const thinking = {
      type: "thinking",
      thinking: "replayed reasoning ".repeat(400),
      signature: "S".repeat(20_000),
    };
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        stream: true,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
          { role: "user", content: "second" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const startFrame = text.slice(text.indexOf("event: message_start"));
    const published = (JSON.parse(startFrame.slice(startFrame.indexOf("data: ") + 6, startFrame.indexOf("\n\n")))
      .message.usage.input_tokens) as number;

    expect(upstream.captured).toHaveLength(1);
    const sent = upstream.captured[0]!;
    // What the wire actually carried: no signature field, and no reasoning_content because
    // this model is not on a preserve list.
    const serialized = JSON.stringify(sent.messages);
    expect(serialized).not.toContain("S".repeat(64));
    expect(serialized).not.toContain("reasoning_content");

    // The floor must therefore land near the serialized prompt, not near the caller's body.
    const sentEstimate = estimateTokens(JSON.stringify(sent.messages), "mock/test-model");
    expect(published).toBeLessThan(sentEstimate * 1.5);
    expect(published).toBeGreaterThan(sentEstimate * 0.5);
    // And it must be far below what counting the caller's own thinking would produce.
    expect(published).toBeLessThan(estimateClaudeRequestTokens({ messages: JSON.parse(JSON.stringify([thinking])) }, "mock/test-model") / 2);
  } finally {
    await server.stop(true);
    upstream.server.stop(true);
    restoreIsolatedHome();
  }
}, { timeout: SERVER_BUDGET_MS });

