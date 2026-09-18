import { describe, expect, test } from "bun:test";
import {
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import type { CodexWsStageRecord } from "../../src/server/responses/codex-ws-wire";

/**
 * #4191: the WS stage record must survive the usage.jsonl write/read round
 * trip — every serializer on that path is an explicit field copy, so a stage
 * that is not named there is silently dropped on write and on restart
 * hydrate. Corrupt rows (hand-edited or partially written) must lose the
 * stage, never pass strings through into the DTO.
 */

const validStage: CodexWsStageRecord = {
  requestBytes: 512,
  sent: true,
  upstreamFrames: 2,
  controlFrames: 1,
  relayedEvents: 1,
  firstFrameMs: 40,
  elapsedMs: 900,
  pings: 0,
  pongs: 0,
  closeCode: 1006,
  reused: true,
  ocxVersion: "2.52.0",
  bunVersion: "1.4.0",
};

function entryWithStage(stage: unknown): PersistedUsageEntry {
  return {
    requestId: "req-ws-stage",
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 502,
    durationMs: 1000,
    usageStatus: "unreported",
    attempts: [{
      ordinal: 1,
      provider: "openai",
      model: "gpt-5.5",
      adapter: "openai-responses",
      status: 502,
      durationMs: 1000,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
      ...(stage !== undefined ? { codexWsStage: stage as CodexWsStageRecord } : {}),
    }],
  } as PersistedUsageEntry;
}

describe("usage log persists the codex ws stage record (#4191)", () => {
  test("a valid stage survives the normalize round trip", () => {
    const roundTripped = normalizeUsageEntryForTest(entryWithStage(validStage));
    expect(roundTripped.attempts?.[0]?.codexWsStage).toEqual(validStage);
  });

  test("a success-shaped stage keeps requestBytes null", () => {
    const stage = { ...validStage, requestBytes: null, closeCode: null };
    const roundTripped = normalizeUsageEntryForTest(entryWithStage(stage));
    expect(roundTripped.attempts?.[0]?.codexWsStage?.requestBytes).toBeNull();
    expect(roundTripped.attempts?.[0]?.codexWsStage?.closeCode).toBeNull();
  });

  test("corrupt stage shapes are dropped, not passed through", () => {
    const corrupt = { ...validStage, closeCode: "1006", upstreamFrames: "many" };
    const roundTripped = normalizeUsageEntryForTest(entryWithStage(corrupt));
    expect(roundTripped.attempts?.[0]?.codexWsStage).toBeUndefined();
  });

  test("a stage carrying free-form strings is dropped whole", () => {
    const poisoned = { ...validStage, reason: "upstream said things", ocxVersion: 252 };
    const roundTripped = normalizeUsageEntryForTest(entryWithStage(poisoned));
    expect(roundTripped.attempts?.[0]?.codexWsStage).toBeUndefined();
    expect(JSON.stringify(roundTripped)).not.toContain("upstream said things");
  });
});
