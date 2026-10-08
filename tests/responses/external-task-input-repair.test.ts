/**
 * Issue #6764: Codex external task input (a `function_call_output` envelope with no pairing key
 * but a complete id/name/namespace) must reach the raw-body Responses paths as the same user turn
 * the parser produces, never as "[tool output for unknown call]". The summarizer of a routed
 * compaction read the mislabelled handover as an orphaned tool result and lost the active task.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { repairOrphanedInputItems, repairUnidentifiedToolOutputItems } from "../../src/adapters/openai-responses/tool-output-recovery";
import { externalTaskInputResponsesContent } from "../../src/responses/task-input";
import { compactionRequest, completedPayload, drainCompactionResponseState, installCompactionRoutingAclFixture, jsonResponse, keyProviderConfig } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const DELEGATION = "<codex_delegation>Human-authorized task B</codex_delegation>";
const seed = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "function_call_output",
  id: "fco_synthetic",
  name: "send_message_to_thread",
  namespace: "codex_app",
  output: DELEGATION,
  ...extra,
});
const userTurn = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

describe("external task input in raw-body repairs (#6764)", () => {
  test("unidentified-output repair emits the handover as a plain user turn", () => {
    expect(repairUnidentifiedToolOutputItems({ input: [seed()] })).toEqual({ input: [userTurn(DELEGATION)] });
    expect(repairUnidentifiedToolOutputItems({ input: [seed({ call_id: null })] })).toEqual({ input: [userTurn(DELEGATION)] });
  });

  test("forward orphan repair agrees with the unidentified-output repair", () => {
    const body = { input: [seed(), { type: "function_call_output", call_id: "call_gone", output: "stale" }] };
    expect(repairOrphanedInputItems(body, false, false, true)).toEqual({ input: [
      userTurn(DELEGATION),
      userTurn("[tool output for call_gone]\nstale"),
    ] });
    // A stateful destination keeps real orphans for previous_response_id, but a keyless envelope
    // can never pair with stored state, so it is still task input.
    expect(repairOrphanedInputItems({ input: [seed()] }, false, false, false)).toEqual({ input: [userTurn(DELEGATION)] });
  });

  test("structured output keeps its images and order", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
    const output = [{ type: "output_text", text: "look" }, image, { type: "text", text: "then act" }];
    expect(externalTaskInputResponsesContent(seed({ output }))).toEqual([
      { type: "input_text", text: "look" }, image, { type: "input_text", text: "then act" },
    ]);
  });

  test("ordinary orphaned output keeps the existing marker", () => {
    // Recognition is structural: delegation text without the envelope is not promoted.
    const plain = { type: "function_call_output", id: "fco_plain", output: DELEGATION };
    expect(externalTaskInputResponsesContent(plain)).toBeUndefined();
    expect(repairUnidentifiedToolOutputItems({ input: [plain] })).toEqual({ input: [
      userTurn(`[tool output for unknown call]\n${DELEGATION}`),
    ] });
    expect(externalTaskInputResponsesContent(seed({ call_id: "call_1" }))).toBeUndefined();
  });
});

describe("routed compaction summarizes the handover as task input (#6764)", () => {
  installCompactionRoutingAclFixture();
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  beforeEach(() => { releaseSpendHome ??= acquireOwnedSpendHome(); });
  afterEach(async () => {
    try { await drainCompactionResponseState(); } finally {
      releaseSpendHome?.();
      releaseSpendHome = undefined;
      globalThis.fetch = originalFetch;
    }
  });

  test("completed task A, active external task B, then compaction", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    const res = await handleResponses(compactionRequest({
      model: "gw/some-model",
      stream: false,
      input: [
        userTurn("Task A: inspect example.txt"),
        { type: "function_call", call_id: "call_a", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "example.txt inspected" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Task A is done." }] },
        seed(),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working on task B." }] },
        { type: "compaction_trigger" },
      ],
    }), keyProviderConfig(), { model: "", provider: "" });

    expect(res.status).toBe(200);
    await res.text();
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!) as { input: unknown[] };
    expect(sent.input).toContainEqual(userTurn(DELEGATION));
    expect(bodies[0]).not.toContain("[tool output for unknown call]");
  });
});
