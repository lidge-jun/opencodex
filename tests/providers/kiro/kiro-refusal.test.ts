import { describe, expect, test } from "bun:test";
import { classifyKiroRefusal } from "../../../src/adapters/kiro-refusal";
import { kiroEvidenceIdentity } from "../../../src/providers/kiro-account-state-disk";
import type { ProviderAccount } from "../../../src/oauth/types";

const classified = (status: number, body: unknown) =>
  classifyKiroRefusal(status, typeof body === "string" ? body : JSON.stringify(body));

describe("Kiro refusal classification", () => {
  test("kiro refusal: 429 rate and 400 or 429 monthly reasons stay distinct", () => {
    expect(classified(429, { reason: "USER_REQUEST_RATE_EXCEEDED" }).kind).toBe("rate");
    for (const status of [400, 429])
      expect(classified(status, { reason: "MONTHLY_REQUEST_COUNT" }).kind).toBe("monthly_quota");
    expect(classified(403, { reason: "MONTHLY_REQUEST_COUNT" }).kind).toBe("other");
  });

  test("kiro refusal: runtime and q-host suspension shapes require 403", () => {
    expect(classified(403, { reason: "TEMPORARILY_SUSPENDED" }).kind).toBe("suspended");
    for (const message of ["temporarily suspended", "temporarily is suspended",
      "locked your account", "locked it as a"]) {
      expect(classified(403, { message: `Your account was ${message} pending review` }).kind).toBe("suspended");
      expect(classified(400, { message }).kind).toBe("other");
    }
  });

  test("kiro refusal: unknown, nested, malformed and oversized shapes never quarantine", () => {
    for (const body of ["not-json", "{", JSON.stringify({ error: { reason: "TEMPORARILY_SUSPENDED" } }),
      JSON.stringify({ reason: "INVALID_MODEL_ID" }),
      JSON.stringify({ reason: "TEMPORARILY_SUSPENDED", padding: "x".repeat(70_000) })])
      expect(classified(403, body).kind).toBe("other");
  });

  test("kiro refusal: resetAt is absent without verified refusal evidence", () => {
    expect(classified(400, { reason: "MONTHLY_REQUEST_COUNT", resetAt: 1 })).toEqual({ kind: "monthly_quota" });
  });

  test("kiro login identity changes on same-slot re-login and survives token refresh", () => {
    const base = { id: "same", addedAt: 1, credential: { access: "a", accountId: "same" } } as ProviderAccount;
    const first = { ...base, loginId: "11111111-1111-4111-8111-111111111111" };
    const second = { ...base, loginId: "22222222-2222-4222-8222-222222222222" };
    expect(kiroEvidenceIdentity(first)).not.toBe(kiroEvidenceIdentity(second));
    expect(kiroEvidenceIdentity({ ...first, credential: { ...first.credential, access: "new-token" } }))
      .toBe(kiroEvidenceIdentity(first));
    expect(kiroEvidenceIdentity(base)).toBe(kiroEvidenceIdentity({ ...base, credential: { ...base.credential, access: "new" } }));
  });
});
