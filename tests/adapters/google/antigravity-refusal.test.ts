import { ANTIGRAVITY_TOS_VIOLATION_PREFIX } from "../../../src/adapters/google-errors";
import { describe, expect, test } from "bun:test";
import { classifyAntigravityRefusal } from "../../../src/adapters/antigravity-refusal";

const classified = (status: number, body: unknown) =>
  classifyAntigravityRefusal(status, typeof body === "string" ? body : JSON.stringify(body));

describe("Antigravity refusal classification", () => {
  test("a 403 verification demand convicts the account", () => {
    expect(classified(403, {
      error: {
        message: "Please verify your account to continue using Antigravity.",
        status: "PERMISSION_DENIED",
        code: 403,
      },
    }).kind).toBe("verify_account");
    expect(classified(403,
      "Provider error 403: Antigravity access denied (PERMISSION_DENIED): Verify your account to continue.",
    ).kind).toBe("verify_account");
  });

  test("other statuses never convict, even with verification wording", () => {
    for (const status of [400, 401, 429, 500])
      expect(classified(status,
        "Please verify your account to continue using Antigravity.",
      ).kind).toBe("other");
  });

  test("other 403 shapes, malformed and oversized bodies never convict", () => {
    for (const body of ["not-json", "{",
      JSON.stringify({ error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }),
      JSON.stringify({ error: { message: "Location not supported", status: "FAILED_PRECONDITION" } }),
      JSON.stringify({ reason: "verify your account", padding: "x".repeat(70_000) })])
      expect(classified(403, body).kind).toBe("other");
  });
});


describe("Antigravity TOS suspension refusal", () => {
  test("only the normalized suspension marker convicts", () => {
    expect(classifyAntigravityRefusal(403, `${ANTIGRAVITY_TOS_VIOLATION_PREFIX}: disabled`)).toEqual({ kind: "tos_violation" });
    for (const text of [
      ANTIGRAVITY_TOS_VIOLATION_PREFIX,
      `Antigravity access denied (PERMISSION_DENIED): ${ANTIGRAVITY_TOS_VIOLATION_PREFIX}: fake`,
      "This service has been disabled for violation of Terms of Service.",
      JSON.stringify({ error: { details: [{ reason: "TOS_VIOLATION" }] } }),
    ]) expect(classifyAntigravityRefusal(403, text)).toEqual({ kind: "other" });
    expect(classifyAntigravityRefusal(429, `${ANTIGRAVITY_TOS_VIOLATION_PREFIX}: disabled`)).toEqual({ kind: "other" });
  });
});
