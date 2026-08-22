import { describe, expect, test } from "bun:test";
import {
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_OPENAI_PROVIDER_ID,
} from "../src/providers/replit/constants";
import { parseReplitPairInstallSuccess } from "../src/providers/replit/pair-install-response";

const VALID = {
  success: true,
  providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
  probe: {
    ok: true,
    healthz: { status: 200, latencyMs: 10 },
    models: { status: 200, modelCount: 2, latencyMs: 20 },
  },
} as const;

describe("parseReplitPairInstallSuccess", () => {
  test("accepts the complete success DTO", () => {
    const parsed = parseReplitPairInstallSuccess(VALID);
    expect(parsed?.providers).toEqual([REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID]);
    expect(parsed?.probe.healthz.status).toBe(200);
    expect(parsed?.probe.models.modelCount).toBe(2);
  });

  test("rejects bare {success:true}", () => {
    expect(parseReplitPairInstallSuccess({ success: true })).toBeNull();
  });

  test("rejects missing probe fields", () => {
    expect(parseReplitPairInstallSuccess({
      success: true,
      providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
    })).toBeNull();
  });

  test("rejects wrong provider IDs and probe numeric types", () => {
    expect(parseReplitPairInstallSuccess({
      ...VALID,
      providers: ["replit", "other"],
    })).toBeNull();
    expect(parseReplitPairInstallSuccess({
      ...VALID,
      probe: {
        ok: true,
        healthz: { status: 200, latencyMs: "slow" },
        models: { status: 200, modelCount: 2, latencyMs: 20 },
      },
    })).toBeNull();
  });
});
