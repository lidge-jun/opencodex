import { describe, expect, test } from "bun:test";
import { shouldAttemptOpaqueBlobRecovery } from "../../src/server/responses/core";
import { isLiteLlmWrappedCiphertextRejection } from "../../src/server/responses/core-opaque-recovery";
import { causeForRecoveryKind, resendPermission } from "../../src/lib/request-failure-model";

/**
 * #5245: an OpenAI-compatible gateway relays the ciphertext rejection inside its own error
 * string, so the identity the single-shot sanitized rebuild keys on never matched and the turn
 * failed outright instead of retrying without the stale blob.
 *
 * Held in a sibling file rather than appended to responses-opaque-blob-recovery.test.ts, which
 * sits 148 lines under the size ratchet's new-file threshold. Two branches can each stay under a
 * cap alone and sum over it together, and the remedy for that is a move, never a number.
 *
 * The negative cases carry the weight here. Recognising the wrapper is easy; recognising ONLY
 * the coded identity through it is the part a broad implementation gets wrong, because rerunning
 * the whole classifier on the embedded payload silently admits four other identities that were
 * each accepted on evidence about how one specific upstream words its own rejection.
 */

const BLOB = "provider-minted-opaque-state";

function outboundWithBlob(): string {
  return JSON.stringify({
    model: "model-a",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
      { type: "reasoning", content: [], summary: [], encrypted_content: BLOB, status: "completed" },
    ],
  });
}

/** An upstream error body as a gateway relays it: the real payload inside a prose message. */
function wrapped(inner: unknown, trailing = ""): string {
  return JSON.stringify({
    error: {
      message: `litellm.BadRequestError: OpenAIException - ${JSON.stringify(inner)}${trailing}`,
      type: "invalid_request_error",
      code: "400",
    },
  });
}

const CODED_CIPHERTEXT_REJECTION = {
  error: {
    message: "The encrypted content could not be verified.",
    type: "invalid_request_error",
    code: "invalid_encrypted_content",
  },
};

const base = {
  status: 400,
  adapterName: "openai-responses",
  outboundBody: outboundWithBlob(),
  errorBody: wrapped(CODED_CIPHERTEXT_REJECTION),
  alreadyAttempted: false,
};

describe("a relayed ciphertext rejection", () => {
  test("earns the sanitized rebuild the direct rejection already earned", () => {
    expect(shouldAttemptOpaqueBlobRecovery(base)).toBe(true);
  });

  test("survives braces and escaped quotes inside the relayed message", () => {
    const awkward = {
      error: {
        message: 'The encrypted content {"id": "a\\"b"} could not be verified.',
        type: "invalid_request_error",
        code: "invalid_encrypted_content",
      },
    };
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, errorBody: wrapped(awkward) })).toBe(true);
  });

  test("survives the prose a gateway appends after the payload", () => {
    const errorBody = wrapped(CODED_CIPHERTEXT_REJECTION, " Received Model Group=gpt-5");
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, errorBody })).toBe(true);
  });

  test("is still single-shot and still requires the send to have carried a blob", () => {
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, alreadyAttempted: true })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      outboundBody: JSON.stringify({ model: "model-a", input: [{ type: "message", role: "user" }] }),
    })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, status: 500 })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, adapterName: "openai-chat" })).toBe(false);
  });
});

describe("the wrapper admits the coded identity and nothing else", () => {
  /**
   * Each of these is accepted when the upstream states it DIRECTLY. None may be accepted through
   * a relay: the wording evidence belongs to the upstream that produced it, and a gateway in
   * between is not that evidence.
   */
  const relayedButNotAdmitted: ReadonlyArray<readonly [string, unknown]> = [
    ["an unrelated parameter complaint", {
      error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter" },
    }],
    ["the code-less unverifiable-ciphertext wording", {
      error: {
        type: "invalid_request_error",
        code: null,
        message: "The encrypted content 6871-test-ef-0 could not be verified."
          + " Reason: Encrypted content could not be decrypted or parsed.",
      },
    }],
    ["the caller-mismatch wording", {
      error: {
        type: "invalid_request_error",
        code: null,
        message: "reasoning `encrypted_content` was not issued to this caller",
      },
    }],
    ["an xAI compaction-blob decoder error", {
      code: "invalid-argument",
      error: "Could not decode the compaction blob: invalid payload",
    }],
    ["a rate limit", { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Slow down" } }],
    ["a quota exhaustion", { error: { type: "insufficient_quota", code: "insufficient_quota", message: "No credit" } }],
    ["a policy refusal", { error: { type: "invalid_request_error", code: "content_policy_violation", message: "Refused" } }],
  ];

  for (const [label, inner] of relayedButNotAdmitted) {
    test(`does not resend on ${label}`, () => {
      expect(shouldAttemptOpaqueBlobRecovery({ ...base, errorBody: wrapped(inner) })).toBe(false);
    });
  }

  test("ignores a message that only looks like the wrapper", () => {
    expect(isLiteLlmWrappedCiphertextRejection(JSON.parse(wrapped(CODED_CIPHERTEXT_REJECTION)))).toBe(true);
    expect(isLiteLlmWrappedCiphertextRejection({
      error: { message: `OpenAIException - ${JSON.stringify(CODED_CIPHERTEXT_REJECTION)}` },
    })).toBe(false);
    expect(isLiteLlmWrappedCiphertextRejection({ error: { message: "litellm.BadRequestError: no payload" } })).toBe(false);
    expect(isLiteLlmWrappedCiphertextRejection({ error: { message: 17 } })).toBe(false);
    expect(isLiteLlmWrappedCiphertextRejection(null)).toBe(false);
  });

  test("refuses a relayed payload too large to be this envelope", () => {
    const padded = {
      error: {
        message: "x".repeat(20_000),
        type: "invalid_request_error",
        code: "invalid_encrypted_content",
      },
    };
    expect(isLiteLlmWrappedCiphertextRejection(JSON.parse(wrapped(padded)))).toBe(false);
  });
});

describe("the relayed rejection lands on the shared cause", () => {
  /**
   * The recovery this path takes is recorded as `opaque-blob-rejection`, and the shared table has
   * to agree that a ciphertext refusal is repaired rather than repeated or waited out. If these
   * ever disagree, the durable log and the metrics projection describe a different decision from
   * the one the code made.
   */
  test("is a ciphertext refusal, repaired rather than repeated", () => {
    expect(causeForRecoveryKind("opaque-blob-rejection")).toBe("ciphertext-refusal");
    expect(resendPermission("headers-only", "ciphertext-refusal")).toBe("permitted-after-repair");
    expect(resendPermission("headers-only", "rate-limit")).toBe("permitted");
    expect(resendPermission("headers-only", "quota-exhausted")).toBe("refused-futile");
  });

  test("a ciphertext refusal after output reached the caller is not repaired either", () => {
    expect(resendPermission("semantic-output", "ciphertext-refusal")).toBe("refused-committed");
  });
});
