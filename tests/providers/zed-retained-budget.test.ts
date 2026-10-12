import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createZedAdapter, type ZedProvider } from "../../src/adapters/zed";
import { createTranslatorBudget, releaseTranslatedEvent, TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { clearZedCaches } from "../../src/providers/zed";
import { buildResponseJSON } from "../../src/bridge";
import { parseRequest } from "../../src/responses/parser";

const families: ZedProvider[] = ["anthropic", "google", "open_ai", "x_ai"];
afterEach(clearZedCaches);

async function configuredAdapter(family: ZedProvider) {
  const adapter = createZedAdapter({ adapter: "zed", baseUrl: "https://cloud.zed.dev", apiKey: "fixture-token" });
  const parsed = parseRequest({ model: "fixture-model", input: "hello", stream: false });
  parsed._zedAuthContext = { userId: "fixture-user" };
  const setupBudget = createTranslatorBudget();
  const replies = [
    { default_organization_id: "fixture-org" }, { token: "fixture-llm-token" },
    { models: [{ id: "fixture-model", provider: family }] },
  ];
  try {
    await adapter.buildRequest(parsed, {
      headers: new Headers(), translatorBudget: setupBudget,
      providerFetch: (async () => Response.json(replies.shift())) as typeof fetch,
    });
  } finally { setupBudget.dispose(); }
  return adapter;
}

function textFrame(family: ZedProvider, text: string) {
  if (family === "anthropic") return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  if (family === "google") return { candidates: [{ content: { parts: [{ text }] } }] };
  if (family === "open_ai") return { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: text };
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

function completion(family: ZedProvider, count: number, text = "x".repeat(1024)) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ < count) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ event: textFrame(family, text) }) + "\n"));
      } else {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: "stream_ended" }) + "\n"));
        controller.close();
      }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body), pulled: () => pulled, cancelled: () => cancelled };
}

describe("Zed buffered event ownership", () => {
  for (const family of families) {
    test(`${family}: aggregate overflow cancels upstream and releases retained events`, async () => {
      const adapter = await configuredAdapter(family);
      const budget = createTranslatorBudget({ maxTurnBytes: 16 * 1024 });
      const source = completion(family, 128);
      try {
        try {
          const events = await adapter.parseResponse!(source.response, budget);
          expect(events.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit" });
          for (const event of events) releaseTranslatedEvent(event, budget);
        } catch (error) {
          expect(error).toMatchObject({ code: "translation_buffer_limit" });
        }
        expect(source.cancelled()).toBe(true);
        expect(source.pulled()).toBeLessThan(32);
        expect(budget.snapshot().currentBytes).toBe(0);
        expect(budget.snapshot().overflows).toBeGreaterThan(0);
      } finally { budget.dispose(); }
    });
    test(`${family}: normal text remains intact and transfers each retained lease`, async () => {
      const adapter = await configuredAdapter(family);
      const budget = createTranslatorBudget({ maxTurnBytes: 16 * 1024 });
      try {
        const events = await adapter.parseResponse!(completion(family, 2, "hello 🌍").response, budget);
        expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
          .toBe("hello 🌍hello 🌍");
        expect(events.at(-1)?.type).toBe("done");
        expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(events)));
        for (const event of events) releaseTranslatedEvent(event, budget);
        expect(budget.snapshot().currentBytes).toBe(0);
      } finally { budget.dispose(); }
    });
  }
});


describe("Zed Responses ciphertext failure ownership", () => {
  const completed = JSON.stringify({ event: { type: "response.completed", response: {
    output: [{ type: "compaction", encrypted_content: "fixture-ciphertext" }],
  } } }) + "\n";
  test("successful ciphertext collection transfers both leases through buffered output", async () => {
    const adapter = await configuredAdapter("open_ai");
    const budget = createTranslatorBudget();
    try {
      const events = await adapter.parseResponse!(new Response(completed), budget);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(events)) + Buffer.byteLength("fixture-ciphertext"));
      const result = buildResponseJSON(events, "fixture-model", { compaction: true, translatorBudget: budget });
      const output = result.output as Record<string, unknown>[];
      expect(output).toEqual([expect.objectContaining({ encrypted_content: "fixture-ciphertext" })]);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(output[0])));
    } finally { budget.dispose(); }
  });
  test("read failure after a completed snapshot releases ciphertext with no done owner", async () => {
    const adapter = await configuredAdapter("open_ai");
    const budget = createTranslatorBudget();
    const failure = new Error("fixture read failure");
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(completed)); }
        else controller.error(failure);
      },
    }, { highWaterMark: 0 });
    try {
      await expect(adapter.parseResponse!(new Response(body), budget)).rejects.toThrow("fixture read failure");
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });
  test("a refused done-event lease releases its untransferred ciphertext source", async () => {
    const adapter = await configuredAdapter("open_ai");
    const budget = createTranslatorBudget();
    const originalCharge = budget.chargeRetained.bind(budget);
    const charge = spyOn(budget, "chargeRetained").mockImplementation((bytes, scope) => {
      if (scope.kind === "retained_collectors") throw new TranslatorBudgetExceededError("retained_collectors", 1);
      originalCharge(bytes, scope);
    });
    try {
      await expect(adapter.parseResponse!(new Response(completed), budget)).rejects.toMatchObject({ code: "translation_buffer_limit" });
      expect(charge.mock.calls.filter(([, scope]) => scope.kind === "retained_collectors")).toHaveLength(1);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { charge.mockRestore(); budget.dispose(); }
  });
});
