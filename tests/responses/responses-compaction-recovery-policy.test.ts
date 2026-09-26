import { describe, expect, test } from "bun:test";
import { decideCompactionRecovery, readCompactionRecoveryConfig, type CompactionRecoveryEvidence } from "../../src/server/responses/compaction-recovery-policy";

const config = { enabled: true, model: "emergency-alias", allowDevinInvalidArgument: true };
const failure = (patch: Partial<CompactionRecoveryEvidence> = {}): CompactionRecoveryEvidence => ({
  requestKind: "compaction-v2", recoveryAttempts: 0, cancelled: false, nonReplayable: false,
  partialOutput: false, toolEffects: false, remainingSends: 1,
  originalModel: "devin/main/swe-2", fallbackModel: "google/main/gemini", provider: "devin",
  httpStatus: 400, responseStatus: "failed", errorCode: "invalid_argument",
  authenticationDenied: false, policyDenied: false, budgetDenied: false, refusal: false,
  upstreamFailure: true, ...patch,
});

describe("compaction emergency recovery policy", () => {
  test("accepts the explicit Devin exception on v1 and HTTP-200 failed v2", () => {
    expect(decideCompactionRecovery(config, failure({ requestKind: "compaction-v1" }))).toEqual({
      recover: true, model: "emergency-alias", reason: "devin-invalid-argument",
    });
    expect(decideCompactionRecovery(config, failure({ httpStatus: 200 }))).toMatchObject({ recover: true });
  });

  test("successful compaction and ordinary generation never request fallback", () => {
    expect(decideCompactionRecovery(config, failure({ httpStatus: 200, responseStatus: "completed" }))).toEqual({ recover: false, reason: "succeeded" });
    expect(decideCompactionRecovery(config, failure({ requestKind: "ordinary" }))).toEqual({ recover: false, reason: "ordinary-request" });
  });

  test("the exception needs both opt-ins, exact serving provider and structured code", () => {
    for (const candidate of [undefined, null, {}, { ...config, enabled: false }]) {
      expect(decideCompactionRecovery(candidate, failure()).recover).toBe(false);
    }
    for (const patch of [
      { provider: "google" }, { errorCode: "invalid_request_error" }, { errorCode: undefined },
      { errorCode: "message_contains_invalid_argument" }, { upstreamFailure: false },
      { httpStatus: 200, responseStatus: "unknown" as const },
      { httpStatus: 502, responseStatus: "unknown" as const },
    ]) expect(decideCompactionRecovery(config, failure(patch)).recover).toBe(false);
    expect(decideCompactionRecovery({ enabled: true, model: "google/gemini" }, failure()).recover).toBe(false);
  });

  test("caller cancellation and semantic output or tool effects stop replay", () => {
    for (const patch of [{ cancelled: true }, { httpStatus: 499 }, { errorCode: "client_cancelled" }]) {
      expect(decideCompactionRecovery(config, failure(patch))).toEqual({ recover: false, reason: "cancelled" });
    }
    for (const patch of [{ nonReplayable: true }, { partialOutput: true }, { toolEffects: true }]) {
      expect(decideCompactionRecovery(config, failure(patch))).toEqual({ recover: false, reason: "unsafe-replay" });
    }
  });

  test("auth, policy, refusal and budget evidence outrank the provider exception", () => {
    for (const patch of [
      { authenticationDenied: true }, { policyDenied: true }, { budgetDenied: true }, { refusal: true },
      { httpStatus: 401 }, { httpStatus: 403 }, { httpStatus: 402 }, { httpStatus: 429 },
      ...["authentication_error", "permission_denied", "origin_rejected", "cyber_policy_violation",
        "content_filter", "request_send_budget_exhausted", "failed_precondition", "admission_model_denied"]
        .map(errorType => ({ errorType })),
    ]) expect(decideCompactionRecovery(config, failure(patch))).toEqual({ recover: false, reason: "protected-failure" });
  });

  test("same canonical target, recursive recovery and exhausted allowance stop dispatch", () => {
    expect(decideCompactionRecovery(config, failure({ fallbackModel: "devin/main/swe-2" }))).toEqual({ recover: false, reason: "same-model" });
    for (const recoveryAttempts of [1, 2, 100]) {
      expect(decideCompactionRecovery(config, failure({ recoveryAttempts }))).toEqual({ recover: false, reason: "already-attempted" });
    }
    expect(decideCompactionRecovery(config, failure({ remainingSends: 0 }))).toEqual({ recover: false, reason: "budget-exhausted" });
  });

  test("recognizes typed overflow and compact-output failures without a Devin exception", () => {
    const configured = { enabled: true, model: "google/gemini" };
    expect(decideCompactionRecovery(configured, failure({ provider: "google", errorCode: "context_length_exceeded" }))).toMatchObject({ recover: true, reason: "context-overflow" });
    expect(decideCompactionRecovery(configured, failure({ httpStatus: 200, errorCode: "invalid_compaction_output" }))).toMatchObject({ recover: true, reason: "compaction-output" });
    expect(decideCompactionRecovery(configured, failure({ httpStatus: 503, errorCode: "unavailable" }))).toMatchObject({ recover: true, reason: "upstream-unavailable" });
    // classifyError normalizes codeless 5xx bodies and overloads before the evidence reaches us.
    expect(decideCompactionRecovery(configured, failure({ httpStatus: 500, errorCode: "upstream_server_error" }))).toMatchObject({ recover: true, reason: "upstream-unavailable" });
    expect(decideCompactionRecovery(configured, failure({ httpStatus: 503, errorCode: "server_is_overloaded" }))).toMatchObject({ recover: true, reason: "upstream-unavailable" });
    expect(decideCompactionRecovery(configured, failure({ httpStatus: 503, errorCode: "unrecognized_failure" })).recover).toBe(false);
  });

  test("missing or malformed evidence cannot silently grant a send", () => {
    for (const patch of [
      { recoveryAttempts: NaN }, { remainingSends: Infinity }, { remainingSends: -1 },
      { partialOutput: undefined }, { toolEffects: undefined }, { originalModel: "" },
      { fallbackModel: "bad\nmodel" }, { httpStatus: 99 }, { errorCode: "x".repeat(129) },
    ]) expect(decideCompactionRecovery(config, failure(patch as Partial<CompactionRecoveryEvidence>))).toEqual({ recover: false, reason: "invalid-evidence" });
  });

  test("configuration is bounded, detached and requires explicit booleans", () => {
    expect(readCompactionRecoveryConfig(config)).toEqual(config);
    expect(readCompactionRecoveryConfig(config)).not.toBe(config);
    for (const model of ["", " x", "x ", "x\ny", "x".repeat(513)]) {
      expect(readCompactionRecoveryConfig({ ...config, model })).toBeNull();
    }
    expect(readCompactionRecoveryConfig({ ...config, allowDevinInvalidArgument: "true" })).toBeNull();
    expect(readCompactionRecoveryConfig({ ...config, retries: 10 })).toBeNull();
  });

  test("decision is pure and does not consume the caller's shared send allowance", () => {
    const evidence = Object.freeze(failure());
    expect(decideCompactionRecovery(Object.freeze(config), evidence).recover).toBe(true);
    expect(evidence.remainingSends).toBe(1);
    expect(evidence.recoveryAttempts).toBe(0);
  });
});
