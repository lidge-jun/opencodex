import { describe, expect, test } from "bun:test";
import { REDACTED_PROVIDER_FIELDS, providerManagementConfigError } from "../../src/server/auth-cors";
import { PROVIDER_EGRESS_DIRECT } from "../../src/lib/provider-egress";

/**
 * The management write boundary for the per-provider egress fields.
 *
 * A sibling of `management-provider-validation.test.ts` rather than an addition to it: that
 * file sits at its recorded line cap, and the cap only ever moves downward.
 */
function validate(provider: Record<string, unknown>): string | null {
  return providerManagementConfigError("vendor", { adapter: "openai-responses", baseUrl: "https://provider.example/v1", ...provider });
}

describe("provider egress at the management write boundary", () => {
  test("the accepted forms are admitted", () => {
    for (const proxy of [PROVIDER_EGRESS_DIRECT, "http://egress.example:3128", "https://egress.example:3129", "socks5://127.0.0.1:1080", null]) {
      expect(validate({ proxy })).toBeNull();
    }
    expect(validate({ noProxy: "internal.example" })).toBeNull();
    expect(validate({ noProxy: ["internal.example", "10.0.0.1"] })).toBeNull();
    expect(validate({})).toBeNull();
  });

  test("an unusable value is rejected at the write rather than at the first request", () => {
    for (const proxy of ["", "   ", "not a url", "ftp://egress.example", "socks4://127.0.0.1:1080"]) {
      expect(validate({ proxy })).not.toBeNull();
    }
    expect(validate({ noProxy: [42] })).not.toBeNull();
  });

  test("a rejection never echoes the value, because a proxy URL carries credentials", () => {
    // A `.test` host: a credentialed proxy URL reads as `password@host` to the privacy scanner,
    // and that domain is on its allowed list for fixtures.
    const error = validate({ proxy: "ftp://operator:hunter2@egress.test:3128" });
    expect(error).not.toBeNull();
    for (const fragment of ["operator", "hunter2", "egress.test"]) {
      expect(error).not.toContain(fragment);
    }
  });

  test("the proxy field is classified as credential-bearing and never leaves in a DTO", () => {
    // A proxy URL routinely embeds `user:password@`, so it is redacted like `apiKey` and the
    // dashboard editor may not write it. Asserting the classification here is what keeps a
    // later reclassification from quietly publishing the credential.
    expect(REDACTED_PROVIDER_FIELDS).toContain("proxy");
    expect(REDACTED_PROVIDER_FIELDS).not.toContain("noProxy");
  });
});
