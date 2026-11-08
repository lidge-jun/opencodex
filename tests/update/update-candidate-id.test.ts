import { describe, expect, test } from "bun:test";
import { deriveCandidateId } from "../../src/update/update-candidate-id.mjs";

describe("signed update candidate identity", () => {
  test("matches the specified byte-level golden vector", () => {
    expect(deriveCandidateId("00".repeat(32), "linux-x64-npm"))
      .toBe("496737c902f9e38cbd89b81b0ba6935e245a026f4d0a931904ddd4617eafc7c4");
  });

  test("binds both release bytes and target and rejects malformed identities", () => {
    const original = deriveCandidateId("00".repeat(32), "linux-x64-npm");
    expect(deriveCandidateId("01".repeat(32), "linux-x64-npm")).not.toBe(original);
    expect(deriveCandidateId("00".repeat(32), "linux-x64-pnpm")).not.toBe(original);
    for (const digest of ["0".repeat(63), "AA".repeat(32), "gg".repeat(32)]) {
      expect(() => deriveCandidateId(digest, "linux-x64-npm")).toThrow();
    }
    for (const id of ["", "../x", "linux/x64", "é", "x".repeat(129)]) {
      expect(() => deriveCandidateId("00".repeat(32), id)).toThrow();
    }
  });
});
