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
