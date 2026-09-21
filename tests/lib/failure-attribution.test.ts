import { describe, expect, test } from "bun:test";
import {
  deriveRequestFailureAttribution,
  deriveRequestFailureCause,
  deriveRequestFailureStage,
  type RequestFailureFacts,
} from "../../src/lib/request-failure-attribution";
import {
  REQUEST_FAILURE_CAUSES,
  REQUEST_FAILURE_STAGES,
  permitsResend,
  resendPermission,
  stageCommitment,
} from "../../src/lib/request-failure-model";
import { ATTEMPT_RECOVERY_KIND_ROSTER } from "../../src/usage/telemetry-contract";
import {
  REQUEST_CLOSE_REASONS,
  REQUEST_OUTCOME_CLASSES,
  REQUEST_TERMINAL_STATUSES,
  classifyRequestOutcome,
} from "../../src/usage/request-outcome";
import { REQUEST_TRANSPORT_PHASES } from "../../src/usage/telemetry-contract";

/**
 * The fact space this derivation is total over.
 *
 * Holds INV-ATTRIBUTION-01 from structure/overview.md.
 *
 * Every axis is read from the module that declares it rather than restated, so a member added to
 * a roster widens this cross product instead of leaving a case nobody wrote. The status list is
 * the one axis that cannot be derived -- HTTP statuses are not a roster this repository owns --
 * so it enumerates one representative per branch the derivation distinguishes, plus the two
 * boundary values (`0`, no head at all, and `499`) that decide a branch on their own.
 */
const STATUSES = [0, 101, 200, 400, 401, 403, 413, 429, 451, 499, 500, 502, 503] as const;
// Read from the modules that declare them, so a member added later widens this space instead of
// leaving a case nobody wrote. Restating them is what let the recovery roster drift to nine of
// thirteen while every test stayed green.
const TERMINAL_STATUSES = [undefined, ...REQUEST_TERMINAL_STATUSES] as const;
const CLOSE_REASONS = [undefined, ...REQUEST_CLOSE_REASONS] as const;
const TRANSPORT_PHASES = [undefined, ...REQUEST_TRANSPORT_PHASES] as const;

function* factSpace(): Generator<RequestFailureFacts> {
  for (const status of STATUSES) {
    for (const terminalStatus of TERMINAL_STATUSES) {
      for (const closeReason of CLOSE_REASONS) {
        for (const transportPhase of TRANSPORT_PHASES) {
          for (const outputObserved of [false, true]) {
            for (const sideEffectObserved of [false, true]) {
              yield {
                status,
                ...(terminalStatus ? { terminalStatus } : {}),
                ...(closeReason ? { closeReason } : {}),
                ...(transportPhase ? { transportPhase } : {}),
                outputObserved,
                sideEffectObserved,
              };
            }
          }
        }
      }
    }
  }
}

describe("request failure attribution", () => {
  test("every derived stage and cause is a member of the landed rosters", () => {
    let seen = 0;
    for (const facts of factSpace()) {
      seen += 1;
      expect(REQUEST_FAILURE_STAGES).toContain(deriveRequestFailureStage(facts));
      const cause = deriveRequestFailureCause(facts);
      if (cause !== undefined) expect(REQUEST_FAILURE_CAUSES).toContain(cause);
    }
    // The generator is the oracle: an axis added above must actually widen the space.
    expect(seen).toBe(
      STATUSES.length * TERMINAL_STATUSES.length * CLOSE_REASONS.length * TRANSPORT_PHASES.length * 4,
    );
  });

  test("attribution is recorded for exactly the outcomes that are not completed", () => {
    const outcomesWithAttribution = new Set<string>();
    for (const facts of factSpace()) {
      const outcome = classifyRequestOutcome(facts);
      const attribution = deriveRequestFailureAttribution(facts);
      if (outcome === "completed") {
        expect(attribution).toBeUndefined();
        continue;
      }
      expect(attribution).toBeDefined();
      outcomesWithAttribution.add(outcome);
    }
    expect([...outcomesWithAttribution].toSorted())
      .toEqual(REQUEST_OUTCOME_CLASSES.filter(outcome => outcome !== "completed").toSorted());
  });

  test("a cause is recorded for a failure and withheld from an incomplete turn", () => {
    for (const facts of factSpace()) {
      const outcome = classifyRequestOutcome(facts);
      const cause = deriveRequestFailureCause(facts);
      if (outcome === "completed" || outcome === "incomplete") expect(cause).toBeUndefined();
      else expect(cause).toBeDefined();
    }
  });

  test("an aborted request is attributed to the caller, whichever way it was signalled", () => {
    expect(deriveRequestFailureCause({ status: 499 })).toBe("client-cancelled");
    expect(deriveRequestFailureCause({ status: 502, closeReason: "client_cancel" })).toBe("client-cancelled");
  });

  test("a stage never claims more than the caller observed", () => {
    for (const facts of factSpace()) {
      const stage = deriveRequestFailureStage(facts);
      if (facts.outputObserved !== true) {
        // Nothing reached the caller, so no stage may report an irreversible observation.
        expect(stageCommitment(stage)).not.toBe("output-observed");
        expect(stageCommitment(stage)).not.toBe("answer-delivered");
      }
    }
  });

  test("an observed side effect refuses a resend for every cause", () => {
    const facts: RequestFailureFacts = { status: 502, sideEffectObserved: true };
    const stage = deriveRequestFailureStage(facts);
    for (const cause of REQUEST_FAILURE_CAUSES) {
      expect(permitsResend(resendPermission(stage, cause))).toBe(false);
    }
  });

  test("a 400 is refined by the recovery kind that identifies which rejection it was", () => {
    const base = { status: 400 } as const;
    expect(deriveRequestFailureCause(base)).toBe("payload-rejected");
    expect(deriveRequestFailureCause({ ...base, recoveryKinds: ["opaque-blob-rejection"] }))
      .toBe("ciphertext-refusal");
    expect(deriveRequestFailureCause({ ...base, recoveryKinds: ["reasoning-effort-downgrade"] }))
      .toBe("parameter-rejected");
  });

  test("a recovery kind does not become the cause when the request ended on another status", () => {
    // The attempt recovered from a rejected reasoning parameter and then died on a 500. The
    // request failed for the 500, and reporting the earlier rejection would send an operator
    // after a problem that was already worked around.
    for (const kind of ATTEMPT_RECOVERY_KIND_ROSTER) {
      expect(deriveRequestFailureCause({ status: 500, recoveryKinds: [kind] })).toBe("upstream-fault");
    }
  });

  test("a turn that settled with no output is empty output rather than an upstream fault", () => {
    expect(deriveRequestFailureCause({ status: 200, terminalStatus: "failed", outputObserved: false }))
      .toBe("empty-output");
    expect(deriveRequestFailureCause({ status: 200, terminalStatus: "failed", outputObserved: true }))
      .toBe("upstream-fault");
  });

  test("a stream that died mid-flight is ambiguous, not an upstream fault", () => {
    // The production shape: the relay reports a SYNTHETIC 502 after a mid-stream read failure
    // and marks the attempt aborted. Reading the 502 in status order would claim the origin
    // answered when it did not.
    expect(deriveRequestFailureCause({
      status: 502, transportPhase: "mid_stream", terminalSource: "synthetic",
    })).toBe("transport-ambiguous");
    expect(deriveRequestFailureCause({ status: 502, streamAborted: true })).toBe("transport-ambiguous");
    // An upstream 502 that is genuinely upstream stays an upstream fault.
    expect(deriveRequestFailureCause({ status: 502, terminalSource: "upstream" })).toBe("upstream-fault");
  });

  test("an unknown execution state never reads as a proven unsent send", () => {
    // `transport-unsent` permits an automatic resend, so it is reachable only from a site that
    // classified a pre-connect failure and can prove it. Everything else answers ambiguously,
    // which is the safe direction.
    expect(deriveRequestFailureCause({ status: 0 })).toBe("transport-ambiguous");
    expect(deriveRequestFailureCause({ status: 0, causeHint: "transport-unsent" })).toBe("transport-unsent");
  });

  test("payment required is a quota problem, not a bad payload", () => {
    expect(deriveRequestFailureCause({ status: 402 })).toBe("quota-exhausted");
  });

  test("a local refusal is attributed to this proxy rather than to upstream", () => {
    expect(deriveRequestFailureCause({ status: 502, locallyAnswered: true })).toBe("local-refusal");
  });

  test("a cause the finalizer proved outranks the status table", () => {
    // The key-account rotation seals the previous attempt because a named recovery rejected it.
    // That argument is evidence; reconstructing the cause from 502 would lose it.
    expect(deriveRequestFailureCause({ status: 502, causeHint: "credential-rejected" }))
      .toBe("credential-rejected");
    // A client cancel is a fact about the caller and still outranks the hint.
    expect(deriveRequestFailureCause({ status: 499, causeHint: "credential-rejected" }))
      .toBe("client-cancelled");
  });

  test("only the last recovery refines a 400, and only on its own status", () => {
    // The attempt recovered from a rejected ciphertext and then hit a rejected parameter.
    expect(deriveRequestFailureCause({
      status: 400,
      recoveryKinds: ["opaque-blob-rejection", "reasoning-effort-downgrade"],
    })).toBe("parameter-rejected");
    // A recovery for a different status never refines this one.
    expect(deriveRequestFailureCause({ status: 400, recoveryKinds: ["oauth-401"] }))
      .toBe("payload-rejected");
  });

  test("a relayed side effect raises the stage above observed output", () => {
    expect(deriveRequestFailureStage({ status: 502, outputObserved: true })).toBe("semantic-output");
    expect(deriveRequestFailureStage({ status: 502, outputObserved: true, sideEffectObserved: true }))
      .toBe("side-effect");
  });
});
