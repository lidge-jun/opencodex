/**
 * The request source envelope (PF-06, src/protocols/envelope.ts): features are scanned once and
 * only on demand; every fresh body is an independent copy charged to the translator budget.
 */
import { describe, expect, test } from "bun:test";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { isTranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function chatBody(): Record<string, unknown> {
  return {
    model: "fixture/model",
    messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
    seed: 7,
  };
}

describe("createProtocolEnvelope", () => {
  test("features are not scanned at creation and are scanned exactly once", () => {
    let reads = 0;
    const body = chatBody();
    Object.defineProperty(body, "n", { enumerable: true, get: () => { reads++; return 2; } });
    const envelope = createProtocolEnvelope({ inbound: "chat", body, translatorBudget: createTestTranslatorBudget() });
    expect(reads).toBe(0);

    const first = envelope.features();
    const readsAfterFirst = reads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect([...first].sort()).toEqual(["request.multiple_choices", "request.seed"]);

    expect(envelope.features()).toBe(first);
    expect(reads).toBe(readsAfterFirst);
    expect(envelope.inbound).toBe("chat");
  });

  test("freshBody returns an independent copy each time", () => {
    const source = chatBody();
    const envelope = createProtocolEnvelope({ inbound: "chat", body: source, translatorBudget: createTestTranslatorBudget() });
    const a = envelope.freshBody();
    const b = envelope.freshBody();
    expect(a).toEqual(source);
    expect(a).not.toBe(source);
    expect(a).not.toBe(b);

    a.model = "rewritten";
    (a.messages as Array<Record<string, unknown>>)[0]!.role = "system";
    delete a.seed;
    expect(source).toEqual(chatBody());
    expect(b).toEqual(chatBody());
  });

  test("each fresh copy is charged to the translator budget", () => {
    const budget = createTestTranslatorBudget();
    const source = chatBody();
    const envelope = createProtocolEnvelope({ inbound: "chat", body: source, translatorBudget: budget });
    const bytes = Buffer.byteLength(JSON.stringify(source), "utf8");
    expect(budget.snapshot().currentBytes).toBe(0);
    envelope.features();
    expect(budget.snapshot().currentBytes).toBe(0);
    envelope.freshBody();
    expect(budget.snapshot().currentBytes).toBe(bytes);
    envelope.freshBody();
    expect(budget.snapshot().currentBytes).toBe(2 * bytes);
  });

  test("a copy over the turn budget is refused", () => {
    const source = chatBody();
    const bytes = Buffer.byteLength(JSON.stringify(source), "utf8");
    const budget = createTestTranslatorBudget({ maxTurnBytes: bytes + 1 });
    const envelope = createProtocolEnvelope({ inbound: "chat", body: source, translatorBudget: budget });
    envelope.freshBody();
    let thrown: unknown;
    try { envelope.freshBody(); } catch (error) { thrown = error; }
    expect(isTranslatorBudgetExceededError(thrown)).toBe(true);
  });
});
