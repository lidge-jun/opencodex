import { describe, expect, test } from "bun:test";
import { accountDisplayLabel, emailMaskingEnabled, maskAccountId, maskEmail, maskedAccountLabel, projectEmail } from "../../src/lib/privacy";

test("account display labels omit malformed identities and mask valid addresses", () => {
  expect(maskedAccountLabel("person@example.test")).toBe("p***n@example.test");
  expect(maskedAccountLabel("a@domain")).toBe("*@domain");
  for (const value of [undefined, "", "not-an-email", "a@@example.test", "a@-bad.test", "a@bad..test", "a@example.test\nextra", "x".repeat(255) + "@example.test"]) {
    expect(maskedAccountLabel(value)).toBeUndefined();
  }
});

test("dashboard account labels follow the masking decision (#8286)", () => {
  expect(accountDisplayLabel("person@example.test", true)).toBe("p***n@example.test");
  expect(accountDisplayLabel("not-an-email", true)).toBeUndefined();
  expect(accountDisplayLabel("  person@example.test  ", false)).toBe("person@example.test");
  expect(accountDisplayLabel("workspace-login", false)).toBe("workspace-login");
  for (const value of [undefined, "", "   ", "x".repeat(255), "a@example.test\nextra", "a\u202E@example.test", "a\u200B@example.test"]) {
    expect(accountDisplayLabel(value, false)).toBeUndefined();
  }
});

function fastestLabelMs(input: string, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    maskedAccountLabel(input);
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

test("account label validation stays linear on adversarial domain labels", () => {
  // Each "00." label had two ways to match, so a trailing invalid character backtracked 2^n.
  // The vulnerable pattern took ~400ms at 26 labels and would not finish at 80; a linear
  // check lands orders of magnitude below the bound. The fastest of several runs keeps a
  // single scheduler pause from failing the test.
  for (const labels of [26, 80]) {
    const domain = "0." + "00.".repeat(labels);
    const invalid = `%@${domain}!`;
    const valid = `%@${domain}a`;
    // Valid addresses of the same length prove these inputs still reach the pattern.
    expect(valid.length).toBeLessThanOrEqual(254);
    expect(maskedAccountLabel(valid)).toBe(`*@${domain}a`);
    expect(maskedAccountLabel(invalid)).toBeUndefined();
    expect(fastestLabelMs(invalid)).toBeLessThan(50);
  }
  expect(maskedAccountLabel("a@b-c.d0-e.f")).toBe("*@b-c.d0-e.f");
});

describe("maskAccountId", () => {
  test("redacts long account ids to account-…suffix", () => {
    expect(maskAccountId("acct_abcdefghijklmnopqrstuvwxyz")).toBe("account-…wxyz");
  });

  test("returns null for empty", () => {
    expect(maskAccountId(null)).toBeNull();
    expect(maskAccountId("")).toBeNull();
  });

  test("short ids still redact without leaking full value when length > 4", () => {
    expect(maskAccountId("abcdef")).toBe("account-…cdef");
  });

  test("ids of four characters or fewer never include the source identifier", () => {
    for (const id of ["a", "ab", "abc", "abcd"]) {
      const masked = maskAccountId(id);
      expect(masked).toBe("account-…");
      expect(masked!.endsWith(id)).toBe(false);
      expect(masked).not.toBe(id);
    }
  });
});

/**
 * #3859 — an operator running many accounts on their own machine could not read the addresses
 * they own, because `maskEmail` had no reveal argument and every management projection applied
 * it unconditionally.
 *
 * The opt-in fails closed at every ambiguity. Management is not always loopback: under
 * `remoteGui`, an unmasked projection discloses operator PII to every management principal that
 * can reach the hub, so anything short of an explicit `false` keeps masking.
 */
describe("emailMaskingEnabled (#3859)", () => {
  test("masking is the default for every shape that is not an explicit false", () => {
    expect(emailMaskingEnabled(undefined)).toBe(true);
    expect(emailMaskingEnabled(null)).toBe(true);
    expect(emailMaskingEnabled({})).toBe(true);
    expect(emailMaskingEnabled({ privacy: {} })).toBe(true);
    expect(emailMaskingEnabled({ privacy: { maskEmails: true } })).toBe(true);
  });

  test("only the literal boolean false unmasks", () => {
    expect(emailMaskingEnabled({ privacy: { maskEmails: false } })).toBe(false);
    // A hand-edited config is the expected way in, and the schema drops a malformed block, but
    // the predicate must not disclose an address on a truthy string or a stray zero either.
    for (const value of ["false", "", 0, null] as unknown[]) {
      expect(emailMaskingEnabled({ privacy: { maskEmails: value as boolean } })).toBe(true);
    }
  });
});

describe("projectEmail (#3859)", () => {
  test("masking on reproduces maskEmail exactly", () => {
    for (const address of ["person@example.test", "a@example.test", "ab@example.test", "no-at-sign"]) {
      expect(projectEmail(address, true)).toBe(maskEmail(address));
    }
    expect(projectEmail("person@example.test", true)).toBe("p***n@example.test");
  });

  test("masking off returns the stored address unchanged", () => {
    expect(projectEmail("person@example.test", false)).toBe("person@example.test");
  });

  test("absence normalises to null on both paths", () => {
    // A consumer's "is there an email" test must not start answering differently just because
    // the operator turned masking off.
    for (const mask of [true, false]) {
      expect(projectEmail(null, mask)).toBeNull();
      expect(projectEmail(undefined, mask)).toBeNull();
      expect(projectEmail("", mask)).toBeNull();
    }
  });
});
