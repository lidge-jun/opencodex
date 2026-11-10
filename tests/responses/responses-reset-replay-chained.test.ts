import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #8453: a Codex turn chained with previous_response_id is expanded locally, and the native
// adapter strips the id before the wire. The ambiguous-reset judgment has to look at that body,
// not at the inbound one that still names the id, or an operator's retryOnReset opt-in never
// applies to a chained turn.
const { handleResponses } = await import("../../src/server/responses");

const releaseSpendHome = acquireOwnedSpendHome();
afterAll(() => releaseSpendHome());

let warnings: string[] = [];
let warnSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  warnings = [];
  warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
});
afterEach(() => warnSpy?.mockRestore());

const completed = (id: string) => ({
  id, object: "response", status: "completed",
  output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 2 },
});
const sse = (id: string) => new Response(
  [{ type: "response.created", response: { id, status: "in_progress" } }, { type: "response.completed", response: completed(id) }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const reset = () => Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
const userTurn = (text: string) => [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
const request = (body: Record<string, unknown>) => new Request("http://localhost/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "fixture/model", stream: true, store: false, ...body }),
});

function fixture(prefix: string, extra: Partial<OcxProviderConfig>) {
  const sends: Record<string, unknown>[] = [];
  const plan: ("reset" | "answer")[] = [];
  const provider: OcxProviderConfig & { fetch?: typeof globalThis.fetch } = {
    adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1", apiKey: "fixture-key", models: ["model"], ...extra,
    fetch: async (_input, init) => {
      sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (plan.shift() === "reset") throw reset();
      return sse(`${prefix}_${sends.length}`);
    },
  };
  const cfg = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } } satisfies OcxConfig;
  return { cfg, sends, plan };
}

describe("ambiguous reset on a chained native Responses turn", () => {
  test("a locally expanded previous_response_id does not block an opted-in replacement", async () => {
    const f = fixture("resp_chain_a", { retryOnReset: { enabled: true, replacements: 2 } });
    const first = await handleResponses(request({ input: userTurn("one") }), f.cfg, { model: "", provider: "" });
    expect(first.status).toBe(200);
    await first.text();

    f.plan.push("reset", "answer");
    const chained = await handleResponses(
      request({ previous_response_id: "resp_chain_a_1", input: userTurn("two") }), f.cfg, { model: "", provider: "" });
    expect(chained.status).toBe(200);
    expect(await chained.text()).toContain('"type":"response.completed"');
    // Turn one, the send that reset, and the one replacement.
    expect(f.sends).toHaveLength(3);
    for (const sent of f.sends.slice(1)) {
      expect(Object.hasOwn(sent, "previous_response_id")).toBe(false);
      expect((sent.input as unknown[]).length).toBe(3);
    }
  });

  test("an unexpanded previous_response_id still reaches the wire and stays refused", async () => {
    const f = fixture("resp_chain_b", { retryOnReset: { enabled: true, replacements: 2 } });
    f.plan.push("reset", "answer");
    const chained = await handleResponses(
      request({ previous_response_id: "resp_never_recorded", input: userTurn("two") }), f.cfg, { model: "", provider: "" });
    expect(chained.status).toBe(429);
    expect(await chained.text()).toContain("upstream_reset_replay_refused");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.previous_response_id).toBe("resp_never_recorded");
    expect(warnings.some(line => line.includes("ambiguous-request-not-replayable"))).toBe(true);
  });

  test("the refusal names a missing opt-in without echoing the request", async () => {
    const f = fixture("resp_chain_c", {});
    f.plan.push("reset", "answer");
    const response = await handleResponses(request({ input: userTurn("private words") }), f.cfg, { model: "", provider: "" });
    expect(response.status).toBe(429);
    await response.text();
    expect(f.sends).toHaveLength(1);
    const refusal = warnings.find(line => line.includes("ambiguous-no-policy"));
    expect(refusal).toContain("gateway.example.test");
    expect(refusal).not.toContain("private words");
    expect(refusal).not.toContain("fixture-key");
  });
});

