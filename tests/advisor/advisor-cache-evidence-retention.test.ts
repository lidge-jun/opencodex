import { expect, test } from "bun:test";
import type { OcxUsage } from "../../src/types";
import { AdvisorRetention } from "../../src/server/responses/advisor-retention";
import { jsonUtf8Bytes } from "../../src/lib/json-byte-size";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const usage = (): OcxUsage => ({ inputTokens: 100, outputTokens: 1, cachedInputTokens: 40 });

test("first adapter cache observation retains exactly its transformed bytes", () => {
  const budget = createTestTranslatorBudget();
  const retention = new AdvisorRetention(budget);
  const original = usage();
  const first = retention.usage(undefined, original)!;
  expect(first.cacheTelemetry).toEqual({ source: "adapter", usagePresent: true, read: 40 });
  expect(original.cacheTelemetry).toBeUndefined();
  expect(budget.snapshot().currentBytes).toBe(jsonUtf8Bytes(first) + 1);
  const second = retention.usage(first, usage())!;
  expect(second.cacheTelemetry).toMatchObject({ source: "aggregate", complete: true, read: 80, readComplete: true });
  expect(budget.snapshot().currentBytes).toBe(jsonUtf8Bytes(second) + 1);
  retention.release();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test.each([true, false])("missing physical usage remains unknown without fabricated tokens (first=%s)", missingFirst => {
  const budget = createTestTranslatorBudget();
  const retention = new AdvisorRetention(budget);
  const first = retention.usage(undefined, missingFirst ? undefined : usage());
  if (missingFirst) expect(budget.snapshot().currentBytes).toBe(0);
  const second = retention.usage(first, missingFirst ? usage() : undefined)!;
  expect(second).toMatchObject({ inputTokens: 100, outputTokens: 1,
    cacheTelemetry: { source: "aggregate", complete: false, read: 40, readComplete: false } });
  expect(budget.snapshot().currentBytes).toBe(jsonUtf8Bytes(second) + 1);
  retention.release();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("failed replacement does not leak its reservation or release the previous owner", () => {
  const budget = createTestTranslatorBudget({ maxTurnBytes: 1000 });
  const retention = new AdvisorRetention(budget);
  const first = retention.usage(undefined, usage())!;
  const before = budget.snapshot().currentBytes;
  expect(() => retention.usage(first, { ...usage(), rawUsage: { synthetic: "x".repeat(600) } }))
    .toThrow(TranslatorBudgetExceededError);
  expect(budget.snapshot().currentBytes).toBe(before);
  expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(1000);
  retention.release();
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("post-admission failure releases only the new copy reservation", () => {
  const budget = createTestTranslatorBudget();
  const retention = new AdvisorRetention(budget);
  const first = retention.usage(undefined, usage())!;
  const before = budget.snapshot().currentBytes;
  let reads = 0;
  const second: OcxUsage = { inputTokens: 1, outputTokens: 1,
    get cacheTelemetry() { if (++reads > 1) throw new Error("synthetic getter failure"); return undefined; } };
  expect(() => retention.usage(first, second)).toThrow("synthetic getter failure");
  expect(budget.snapshot().currentBytes).toBe(before);
  retention.release();
  expect(budget.snapshot().currentBytes).toBe(0);
});
