import { describe, expect, test } from "bun:test";
import {
  authorizeResend,
  authorizeResendForRecovery,
  RESEND_REFUSALS,
  type AmbiguousResendAllowance,
} from "../../src/lib/request-resend-gate";
import {
  causeDisposition,
  causeForRecoveryKind,
  permitsResend,
  REQUEST_FAILURE_CAUSES,
  REQUEST_FAILURE_STAGES,
  resendPermission,
  resendSendClass,
  stageCommitment,
} from "../../src/lib/request-failure-model";
import { ATTEMPT_RECOVERY_KIND_ROSTER } from "../../src/usage/telemetry-contract";

/*
 * Holds INV-RESEND-02 from structure/overview.md.
 */

/**
 * A grant with a counted `claim`. `limit` is the number of replacements the whole logical
 * request may make, which is the property every test below is really about.
 */
function allowance(options: { selfContained?: boolean; limit?: number } = {}): AmbiguousResendAllowance & {
  claims: () => number;
} {
  let claimed = 0;
  const limit = options.limit ?? 1;
  return {
    selfContained: options.selfContained ?? true,
    claim: () => {
      if (claimed >= limit) return false;
      claimed += 1;
      return true;
    },
    claims: () => claimed,
  };
}

describe("authorizeResend over the whole stage-by-cause cross product", () => {
  test("agrees with the table wherever the table already answers", () => {
    for (const stage of REQUEST_FAILURE_STAGES) {
      for (const cause of REQUEST_FAILURE_CAUSES) {
        const permission = resendPermission(stage, cause);
        const decision = authorizeResend(stage, cause);
        expect(decision.permission).toBe(permission);
        expect(decision.stage).toBe(stage);
        expect(decision.cause).toBe(cause);
        // The gate adds an override for exactly one answer and changes none of the others.
        if (permission !== "refused-ambiguous") {
          expect(decision.allowed).toBe(permitsResend(permission));
        }
        if (decision.allowed) expect(decision.sendClass).toBe(resendSendClass(cause));
      }
    }
  });

  test("a stage the caller observed something at refuses whatever the operator granted", () => {
    const grant = allowance({ limit: 5 });
    for (const stage of REQUEST_FAILURE_STAGES) {
      if (stageCommitment(stage) === "nothing-observed") continue;
      for (const cause of REQUEST_FAILURE_CAUSES) {
        const decision = authorizeResend(stage, cause, grant);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.refusal).toBe("committed");
      }
    }
    // Nothing committed may drain the grant a later ambiguous failure is entitled to.
    expect(grant.claims()).toBe(0);
  });

  test("a futile cause refuses without spending the grant", () => {
    const grant = allowance({ limit: 5 });
    for (const cause of REQUEST_FAILURE_CAUSES) {
      if (causeDisposition(cause) !== "resend-is-futile") continue;
      const decision = authorizeResend("pre-header", cause, grant);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.refusal).toBe("futile");
    }
    expect(grant.claims()).toBe(0);
  });

  test("every refusal the gate can produce is a declared member", () => {
    const produced = new Set<string>();
    const cases: Array<AmbiguousResendAllowance | undefined> = [
      undefined,
      allowance({ selfContained: false }),
      allowance({ limit: 0 }),
    ];
    for (const stage of REQUEST_FAILURE_STAGES) {
      for (const cause of REQUEST_FAILURE_CAUSES) {
        for (const grant of cases) {
          const decision = authorizeResend(stage, cause, grant);
          if (!decision.allowed) produced.add(decision.refusal);
        }
      }
    }
    for (const refusal of produced) expect(RESEND_REFUSALS).toContain(refusal);
    // Every declared member is reachable, so the roster is not carrying a dead name.
    expect([...RESEND_REFUSALS].sort()).toEqual([...produced].sort());
  });
});

describe("the ambiguous override", () => {
  const ambiguous = REQUEST_FAILURE_STAGES.filter(stage => stageCommitment(stage) === "nothing-observed");

  test("refuses with no operator policy and never claims", () => {
    for (const stage of ambiguous) {
      const decision = authorizeResend(stage, "transport-ambiguous");
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-no-policy");
    }
  });

  test("refuses a request it cannot judge replayable, without spending the grant", () => {
    const grant = allowance({ selfContained: false, limit: 3 });
    for (const stage of ambiguous) {
      const decision = authorizeResend(stage, "transport-ambiguous", grant);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-request-not-replayable");
    }
    expect(grant.claims()).toBe(0);
  });

  test("one logical request buys one replacement, whichever stage asks first", () => {
    // The defect this gate exists to prevent: #4942 asked before the response head and #4989
    // asked after it, and two separate grants would let one turn be sent twice more.
    const grant = allowance({ limit: 1 });
    const first = authorizeResend("pre-header", "transport-ambiguous", grant);
    expect(first.allowed).toBe(true);
    if (first.allowed) expect(first.spentOperatorAllowance).toBe(true);

    for (const stage of ambiguous) {
      const later = authorizeResend(stage, "transport-ambiguous", grant);
      expect(later.allowed).toBe(false);
      if (!later.allowed) expect(later.refusal).toBe("ambiguous-allowance-spent");
    }
    expect(grant.claims()).toBe(1);
  });

  test("a grant of two is spent exactly twice", () => {
    const grant = allowance({ limit: 2 });
    expect(authorizeResend("pre-header", "transport-ambiguous", grant).allowed).toBe(true);
    expect(authorizeResend("protocol-prelude", "transport-ambiguous", grant).allowed).toBe(true);
    expect(authorizeResend("headers-only", "transport-ambiguous", grant).allowed).toBe(false);
    expect(grant.claims()).toBe(2);
  });
});

describe("authorizeResendForRecovery", () => {
  test("derives the cause from the kind it will be recorded as, for every kind", () => {
    for (const kind of ATTEMPT_RECOVERY_KIND_ROSTER) {
      const decision = authorizeResendForRecovery("pre-header", kind, allowance({ limit: 99 }));
      expect(decision.cause).toBe(causeForRecoveryKind(kind));
      expect(decision.recoveryKind).toBe(kind);
      // The answer is the table's, asked in the other vocabulary.
      expect(decision.permission).toBe(resendPermission("pre-header", causeForRecoveryKind(kind)));
    }
  });

  test("a connection reset is the ambiguous row at both observable-nothing stages", () => {
    for (const stage of ["pre-header", "headers-only", "protocol-prelude"] as const) {
      expect(authorizeResendForRecovery(stage, "connection-reset").permission).toBe("refused-ambiguous");
      expect(authorizeResendForRecovery(stage, "connection-reset", allowance()).allowed).toBe(true);
    }
    expect(authorizeResendForRecovery("semantic-output", "connection-reset", allowance()).allowed).toBe(false);
  });
});
