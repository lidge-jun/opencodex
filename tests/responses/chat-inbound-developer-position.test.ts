/**
 * A Chat Completions instruction that arrives after the conversation has started keeps the
 * slot it was written in, on every path that carries the same transcript.
 *
 * The translator folded every system and developer message into body.instructions, so
 * U1 -> A1 -> D2 -> U2 reached the router as instructions plus a three-message input. The
 * outbound adapter has preserved that slot since #4161 and cannot restore what the inbound
 * already flattened, and the divergence only appears once a routing feature turns translation
 * on: an ordinary openai-chat route goes straight to the Chat wire, while a combo enters the
 * Responses pipeline (src/server/chat-completions.ts).
 *
 * The cross-path cases below therefore read the final upstream body on all three paths and
 * compare it with the transcript the caller sent. A case that hands an already-translated
 * object to the adapter cannot see this defect at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { responsesRequestSchema } from "../../src/responses/schema";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { chatStream, chatSuccess } from "../helpers/combo-failover-upstream";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;

// One transcript for every case here: an instruction written between two turns.
const U1 = { role: "user", content: "U1" };
const A1 = { role: "assistant", content: "A1" };
const D2 = { role: "developer", content: "D2" };
const U2 = { role: "user", content: "U2" };
const TRANSCRIPT = [U1, A1, D2, U2];

function translate(messages: unknown[], extra: Rec = {}): Rec {
  return chatCompletionsToResponsesBody({ model: "m1", messages, ...extra });
}

function items(body: Rec): Rec[] {
  return body.input as Rec[];
}

function instructionItem(body: Rec): Rec | undefined {
  return items(body).find(item => item.role === "developer");
}

function itemShape(body: Rec): string[] {
  return items(body).map(item => String(item.type) + ":" + String(item.role ?? ""));
}

describe("Chat translation inbound instruction placement", () => {
  test("a leading block is still this request's instructions", () => {
    const body = translate([{ role: "system", content: "S0" }, { role: "developer", content: "D0" }, U1]);

    expect(body.instructions).toBe("S0\n\nD0");
    expect(items(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "U1" }] },
    ]);
  });

  test("a developer message past the first turn keeps its slot instead of moving to instructions", () => {
    const body = translate(TRANSCRIPT);

    expect(body.instructions).toBeUndefined();
    expect(items(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "U1" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A1" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "D2" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "U2" }] },
    ]);
  });

  test("a leading block and a later one land in different places", () => {
    const body = translate([{ role: "system", content: "S0" }, ...TRANSCRIPT]);

    expect(body.instructions).toBe("S0");
    expect(itemShape(body)).toEqual([
      "message:user", "message:assistant", "message:developer", "message:user",
    ]);
  });

  // The representation is the Claude inbound's, not a second invention: that path has carried a
  // mid-conversation instruction as a chronological item since #4148, and a system item would be
  // refused by the native ChatGPT backend and folded back onto instructions by canonical
  // forwarding (src/adapters/openai-responses/canonical-forward.ts). Deriving the expected item
  // from that translator is what keeps the two inbounds in step.
  test("a mid-conversation system message takes the item the Claude inbound already mints", () => {
    const claude = anthropicToResponsesBody({
      model: "m1",
      messages: [U1, A1, { role: "system", content: "D2" }, U2],
    });
    const chat = translate([U1, A1, { role: "system", content: "D2" }, U2]);

    expect(instructionItem(claude)).toBeDefined();
    expect(instructionItem(chat)).toEqual(instructionItem(claude));
    expect(chat.instructions).toBeUndefined();
  });

  test("the translated body is a valid Responses request and parses back as a conversation message", () => {
    const body = translate(TRANSCRIPT);

    expect(responsesRequestSchema.safeParse(body).success).toBe(true);
    const parsed = parseRequest(body);
    expect(parsed.context.messages.map(message => message.role)).toEqual([
      "user", "assistant", "developer", "user",
    ]);
    expect(parsed.context.systemPrompt ?? []).toEqual([]);
    expect(JSON.stringify(parsed.context.messages[2])).toContain("D2");
  });

  test("an instruction inside a tool batch waits for the batch instead of splitting the pair", () => {
    const body = translate([
      U1,
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "developer", content: "D-mid" },
      { role: "tool", tool_call_id: "call_1", content: "R1" },
      U2,
    ]);

    expect(itemShape(body)).toEqual([
      "message:user", "function_call:", "function_call_output:", "message:developer", "message:user",
    ]);
    expect(items(body)[3]).toEqual({
      type: "message", role: "developer", content: [{ type: "input_text", text: "D-mid" }],
    });
    expect(body.instructions).toBeUndefined();
  });

  test("an abandoned tool batch still releases the held instruction before the next turn", () => {
    const body = translate([
      U1,
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "developer", content: "D-mid" },
      U2,
    ]);

    expect(itemShape(body)).toEqual([
      "message:user", "function_call:", "message:developer", "message:user",
    ]);
  });

  test("an empty instruction produces no item and no instructions", () => {
    const body = translate([U1, { role: "developer", content: "   " }, U2]);

    expect(itemShape(body)).toEqual(["message:user", "message:user"]);
    expect(body.instructions).toBeUndefined();
  });
});

describe("Chat, combo and Responses paths agree on instruction placement", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;
  let releaseSpendHome: (() => void) | undefined;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let captured: Rec[] = [];

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-developer-position-codex-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-developer-position-"));
    process.env.OPENCODEX_HOME = testDir;
    // Taken after this suite installs its home so the physical dispatch owns that journal.
    releaseSpendHome = acquireOwnedSpendHome();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearResponseStateForTests();
    captured = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json() as Rec;
        captured.push(body);
        // Answer the wire each path asked for: the native send keeps the caller's stream bit,
        // the translated bridge always streams internally.
        return body.stream === true ? chatStream("ok") : chatSuccess("ok");
      },
    });
  });

  afterEach(async () => {
    // Released before the home is restored so no live unlinked database survives teardown.
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    await upstream?.stop(true);
    upstream = null;
    await flushResponseState();
    clearResponseStateForTests();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    resetProviderRequestPacingForTest();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
  });

  function config(): OcxConfig {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: new URL("/v1", upstream!.url).href,
      allowPrivateNetwork: true,
      authMode: "key",
      apiKey: "fixture-key",
      // Declared accepting, so the wire role is identical on the native and translated paths
      // and the comparison below is about placement alone.
      foldDeveloperRoleToSystem: false,
    };
    return {
      port: 0,
      defaultProvider: "chat",
      providers: { chat: provider },
      combos: { pair: { strategy: "failover", targets: [{ provider: "chat", model: "m1" }] } },
    };
  }

  async function chatWireMessages(model: string): Promise<unknown> {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: TRANSCRIPT }),
    }), config(), { model: "", provider: "" });

    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    return captured[0]!.messages;
  }

  async function responsesWireMessages(): Promise<unknown> {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat/m1",
        stream: false,
        store: false,
        // The canonical Responses spelling of the same transcript.
        input: items(translate(TRANSCRIPT)),
      }),
    }), config(), { model: "", provider: "" });

    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    return captured[0]!.messages;
  }

  test("the native Chat route forwards the transcript unchanged", async () => {
    expect(await chatWireMessages("chat/m1")).toEqual(TRANSCRIPT);
  });

  test("a combo route translates and still sends the transcript unchanged", async () => {
    expect(await chatWireMessages("combo/pair")).toEqual(TRANSCRIPT);
  });

  test("the Responses path sends the same transcript", async () => {
    expect(await responsesWireMessages()).toEqual(TRANSCRIPT);
  });
});
