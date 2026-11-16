import { afterEach, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { COMPACT_PROMPT } from "../../src/responses/compaction";
import { applyCompactionRoutingOverride } from "../../src/server/responses/compaction-routing";
import { handleResponses } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const meta = (trigger = "auto", implementation = "responses", request_kind = "compaction") =>
  JSON.stringify({ request_kind, compaction: { trigger, implementation } });
const settings = () => ({ ...getDefaultConfig(), codexClientCompaction: true,
  defaultProvider: "gateway", providers: { gateway: { adapter: "openai-responses" as const,
    authMode: "key" as const, baseUrl: "https://gateway.example/v1", apiKey: "fixture-key" } },
  compactionRouting: { model: "gateway/cheap", triggers: ["auto", "manual"] as ("auto" | "manual")[] } });
const body = () => ({ model: "gateway/normal", stream: false,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] }] });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each(["header", "body", "both"])("routes a local checkpoint using %s metadata", location => {
  for (const trigger of ["auto", "manual"]) {
    const input: Record<string, unknown> = body();
    const headers = new Headers();
    if (location !== "body") headers.set("x-codex-turn-metadata", meta(trigger));
    if (location !== "header") input.client_metadata = { "x-codex-turn-metadata": meta(trigger) };
    expect(applyCompactionRoutingOverride(input, headers, settings())).toEqual({ sourceModel: "gateway/normal" });
    expect(input.model).toBe("gateway/cheap");
  }
});

test("rejects ordinary, missing, malformed, inconsistent and disabled cases", () => {
  const cases: Array<[unknown, unknown, boolean, ("auto" | "manual")[]]> = [
    [meta("auto", "responses", "turn"), undefined, true, ["auto"]],
    [undefined, undefined, true, ["auto"]], [meta("auto", "compact"), undefined, true, ["auto"]],
    ["{", undefined, true, ["auto"]], [meta(), meta("manual"), true, ["auto", "manual"]],
    [meta(), meta("auto", "compact"), true, ["auto"]], [meta(), undefined, true, ["manual"]],
    [meta(), "{", true, ["auto"]], [meta(), 42, true, ["auto"]],
    [meta(), undefined, false, ["auto"]],
  ];
  for (const [header, client, enabled, triggers] of cases) {
    const input: Record<string, unknown> = body();
    if (client !== undefined) input.client_metadata = { "x-codex-turn-metadata": client };
    const config = settings(); config.codexClientCompaction = enabled; config.compactionRouting.triggers = triggers;
    const headers = new Headers(); if (typeof header === "string") headers.set("x-codex-turn-metadata", header);
    expect(applyCompactionRoutingOverride(input, headers, config)).toBeNull();
    expect(input.model).toBe("gateway/normal");
  }
  const ordinary = body(); ordinary.input[0]!.content[0]!.text = "Ordinary request";
  expect(applyCompactionRoutingOverride(ordinary, new Headers({ "x-codex-turn-metadata": meta() }), settings())).toBeNull();
  const absent = settings(); delete (absent as { codexClientCompaction?: boolean }).codexClientCompaction;
  expect(applyCompactionRoutingOverride(body(), new Headers({ "x-codex-turn-metadata": meta() }), absent)).toBeNull();
  expect(applyCompactionRoutingOverride(body(), new Headers({ "x-codex-turn-metadata": meta() }), settings(), { transport: "websocket" })).toBeNull();
  const frame = { ...body(), client_metadata: { "x-codex-turn-metadata": meta() } };
  expect(applyCompactionRoutingOverride(frame, new Headers(), settings(), { transport: "websocket" })).not.toBeNull();
});

test("remote trigger remains accepted without local implementation metadata", () => {
  const input = { ...body(), input: [{ type: "compaction_trigger" }] };
  expect(applyCompactionRoutingOverride(input, new Headers({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "auto" } }) }), settings())).not.toBeNull();
});

test("handler sends the checkpoint as a normal summary request to the target", async () => {
  const release = acquireOwnedSpendHome();
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "resp_fixture", status: "completed", model: "cheap", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Summary" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  }) as typeof fetch;
  try {
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": meta() }, body: JSON.stringify(body()) });
    const response = await handleResponses(req, settings(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const result = await response.json() as { output: Array<{ type: string; content: Array<{ text: string }> }> };
    expect(calls[0]!.model).toBe("cheap");
    expect(JSON.stringify(calls[0]!.input)).not.toContain("compaction_trigger");
    expect(result.output[0]!.type).toBe("message");
    expect(result.output[0]!.content[0]!.text).toBe("Summary");
  } finally { release(); }
});
