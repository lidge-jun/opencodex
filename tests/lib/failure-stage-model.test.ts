import { describe, expect, test } from "bun:test";
import {
  REQUEST_FAILURE_CAUSES,
  REQUEST_FAILURE_STAGES,
  causeDisposition,
  causeEvidence,
  causeForRecoveryKind,
  permitsResend,
  resendPermission,
  resendSendClass,
  stageCommitment,
  stageRank,
  type RequestFailureCause,
  type RequestFailureStage,
} from "../../src/lib/request-failure-model";
import { ATTEMPT_RECOVERY_KIND_ROSTER } from "../../src/usage/log";

/**
 * Roadmap items 7 and 14. None of these cases can be satisfied by a request that returned 200:
 * every one of them asks what the proxy would do NEXT after a specific failure, which is the
 * question a success assertion cannot reach.
 *
 * They are written over the full cross product rather than over chosen examples on purpose. A
 * table this shape is exactly where a merge of two individually correct branches goes wrong -- one
 * adds a cause, the other adds a stage, and the cell neither author looked at is the defect. A
 * loop over the declared rosters has no cell to miss and cannot go stale when a member is added.
 *
 * Holds INV-RESEND-01 from structure/overview.md.
 */

const STAGES: readonly RequestFailureStage[] = REQUEST_FAILURE_STAGES;
const CAUSES: readonly RequestFailureCause[] = REQUEST_FAILURE_CAUSES;

describe("request failure stage ordering", () => {
  test("ranks are the declared positions, unique and gapless", () => {
    expect(STAGES.map(stageRank)).toEqual(STAGES.map((_, index) => index));
    expect(new Set(STAGES).size).toBe(STAGES.length);
  });

  test("exactly one stage observes output and exactly one observes an effect", () => {
    const byCommitment = STAGES.filter(stage => stageCommitment(stage) === "output-observed");
    const effects = STAGES.filter(stage => stageCommitment(stage) === "effect-observed");
    expect(byCommitment).toEqual(["semantic-output"]);
    expect(effects).toEqual(["side-effect"]);
  });
});

describe("resend permission", () => {
  test("an uncertain resend after output or a side effect is never automatically permitted", () => {
    const permitted: string[] = [];
    for (const stage of STAGES) {
      const commitment = stageCommitment(stage);
      if (commitment !== "output-observed" && commitment !== "effect-observed") continue;
      for (const cause of CAUSES) {
        const permission = resendPermission(stage, cause);
        if (permission !== "refused-committed") permitted.push(`${stage}/${cause}=${permission}`);
      }
    }
    expect(permitted).toEqual([]);
  });

  /**
   * Stated as "neither output nor an effect" rather than "nothing at all", because a turn can
   * settle without ever producing output. A terminal that failed on a rate limit committed nothing
   * downstream and is safe to send again; forbidding it would be the same mistake as ranking
   * `terminal` above `semantic-output` and calling that commitment.
   */
  test("no permitted resend follows observed output or an observed effect", () => {
    const leaks: string[] = [];
    for (const stage of STAGES) {
      const commitment = stageCommitment(stage);
      if (commitment !== "output-observed" && commitment !== "effect-observed") continue;
      for (const cause of CAUSES) {
        if (permitsResend(resendPermission(stage, cause))) leaks.push(`${stage}/${cause}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  /**
   * The #4989 boundary. A stream that announced itself and produced nothing may be replaced; the
   * first output-bearing event closes that door for every cause at once.
   */
  test("the prelude may still be replaced and the two observed stages may not", () => {
    expect(resendPermission("protocol-prelude", "upstream-declined")).toBe("permitted");
    for (const stage of ["semantic-output", "side-effect"] as const) {
      for (const cause of CAUSES) expect(permitsResend(resendPermission(stage, cause))).toBe(false);
    }
  });

  test("an ambiguous transport failure is refused at every stage, budget or not", () => {
    for (const stage of STAGES) {
      expect(permitsResend(resendPermission(stage, "transport-ambiguous"))).toBe(false);
    }
    expect(resendPermission("pre-header", "transport-ambiguous")).toBe("refused-ambiguous");
    expect(resendPermission("semantic-output", "transport-ambiguous")).toBe("refused-committed");
  });

  /**
   * Stated as a property rather than as a list of causes, because a list here would be one more
   * hand-maintained restatement of the dictionary -- the thing these cases exist to prevent.
   */
  test("nothing is repeated at pre-header unless the origin provably did not run it", () => {
    expect(resendPermission("pre-header", "transport-unsent")).toBe("permitted");
    const unproven = CAUSES
      .filter(cause => permitsResend(resendPermission("pre-header", cause)))
      .filter(cause => causeEvidence(cause) !== "not-processed" && causeEvidence(cause) !== "declined");
    expect(unproven).toEqual([]);
  });

  test("a refusal always says which kind of refusal it is", () => {
    const refusals = new Set<string>();
    for (const stage of STAGES) {
      for (const cause of CAUSES) {
        const permission = resendPermission(stage, cause);
        if (!permitsResend(permission)) refusals.add(permission);
      }
    }
    expect([...refusals].sort()).toEqual(["refused-ambiguous", "refused-committed", "refused-futile"]);
  });
});

describe("the four refusals an operator has to tell apart", () => {
  /**
   * #5180 reported these arriving as one undifferentiated failure. Waiting, changing account,
   * changing the prompt and dropping stale ciphertext are four different responses, so the
   * decision each one produces has to differ somewhere a caller can read.
   */
  test("rate limit, quota exhaustion, policy refusal and ciphertext refusal never collapse", () => {
    const quartet = ["rate-limit", "quota-exhausted", "policy-refusal", "ciphertext-refusal"] as const;
    const decisions = quartet.map(cause => JSON.stringify([
      causeEvidence(cause),
      causeDisposition(cause),
      resendSendClass(cause),
      resendPermission("headers-only", cause),
    ]));
    expect(new Set(decisions).size).toBe(quartet.length);
  });

  test("each of the four keeps the decision its remedy implies", () => {
    expect(resendPermission("headers-only", "rate-limit")).toBe("permitted");
    expect(resendPermission("headers-only", "quota-exhausted")).toBe("refused-futile");
    expect(resendPermission("headers-only", "policy-refusal")).toBe("refused-futile");
    expect(resendPermission("headers-only", "ciphertext-refusal")).toBe("permitted-after-repair");
  });

  test("a rejected parameter is not a refused prompt", () => {
    expect(causeDisposition("parameter-rejected")).toBe("resend-after-repair");
    expect(causeDisposition("policy-refusal")).toBe("resend-is-futile");
  });
});

describe("send funding agrees with the permission table", () => {
  /**
   * Funding follows the disposition, not the permission. A cause the table refuses to resend
   * automatically may still be resent by a bounded opt-in recovery, and that send must still be
   * bought from the request-wide budget -- an unfunded path is how a per-layer counter returns.
   */
  test("a budget class is named for every cause a resend could ever help", () => {
    const disagreements: string[] = [];
    for (const cause of CAUSES) {
      const futile = causeDisposition(cause) === "resend-is-futile";
      if (futile !== (resendSendClass(cause) === null)) disagreements.push(cause);
    }
    expect(disagreements).toEqual([]);
  });

  test("the bounded opt-in recoveries the proxy already performs are funded", () => {
    // #4942's reset replay, the empty-completion rebuild and the transient 5xx ladder are all
    // refused automatically and all really send, so all three need an allowance to draw on.
    for (const cause of ["transport-ambiguous", "empty-output", "upstream-fault"] as const) {
      expect(permitsResend(resendPermission("pre-header", cause))).toBe(false);
      expect(resendSendClass(cause)).toBe("transient");
    }
  });
});

describe("recovery kinds speak the shared dictionary", () => {
  test("every recorded recovery kind resolves to a declared cause", () => {
    const unmapped = ATTEMPT_RECOVERY_KIND_ROSTER.filter(
      kind => !CAUSES.includes(causeForRecoveryKind(kind)),
    );
    expect(unmapped).toEqual([]);
  });

  test("the kinds that drive different recoveries do not share one cause", () => {
    expect(causeForRecoveryKind("opaque-blob-rejection")).toBe("ciphertext-refusal");
    expect(causeForRecoveryKind("image-413")).toBe("payload-too-large");
    expect(causeForRecoveryKind("connection-reset")).toBe("transport-ambiguous");
    expect(causeForRecoveryKind("transient-5xx")).toBe("upstream-fault");
    expect(causeForRecoveryKind("reasoning-effort-downgrade")).toBe("parameter-rejected");
  });

  /**
   * Every kind in the roster names a recovery this proxy actually performs, so none of them may
   * classify as futile. The first draft put the 413 image rebuild and the gateway upload replay
   * under a futile cause, which would have had the shared model assert that recoveries visible in
   * the durable log were forbidden and unfunded.
   */
  test("no recorded recovery classifies as a resend that cannot help", () => {
    const futile = ATTEMPT_RECOVERY_KIND_ROSTER
      .filter(kind => causeDisposition(causeForRecoveryKind(kind)) === "resend-is-futile");
    expect(futile).toEqual([]);
  });
});
