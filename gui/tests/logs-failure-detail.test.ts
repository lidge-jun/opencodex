import { describe, expect, test } from "bun:test";
import { en, type TKey } from "../src/i18n/en";
import { interpolate, type Vars } from "../src/i18n/shared";
import { failureDetailLabel } from "../src/pages/logs-failure-summary";
import { FAILURE_DETAIL_CODES } from "../../src/lib/failure-detail";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const t = (key: TKey, vars?: Vars) => interpolate(en[key], vars);

describe("failure detail renders as proxy-owned localized text", () => {
  test("each closed code renders, with its bounded parameter", () => {
    expect(failureDetailLabel({ code: "header_timeout" }, t)).toBe("Timed out waiting for response headers");
    expect(failureDetailLabel({ code: "header_timeout", value: 300 }, t)).toBe("Timed out waiting for response headers after 300 ms");
    expect(failureDetailLabel({ code: "body_overflow", value: 1024 }, t)).toBe("The response body exceeded 1024 bytes");
    expect(failureDetailLabel({ code: "provider_error", type: "permission_error" }, t)).toBe("The provider returned an error (permission_error)");
    expect(failureDetailLabel({ code: "provider_error" }, t)).toBe("The provider returned an error");
    for (const code of FAILURE_DETAIL_CODES) {
      expect(failureDetailLabel({ code, value: 1 }, t)).toBeString();
    }
  });

  test("free text, forged codes and malformed parameters render nothing", () => {
    for (const value of [
      "anthropic passthrough timed out " + PROVIDER_KEY, { code: PROVIDER_KEY }, { code: "constructor" }, null, [],
      { code: "body_stall" }, { code: "body_overflow", value: -1 }, { code: "connect_timeout", value: PROVIDER_KEY },
    ]) {
      expect(failureDetailLabel(value, t)).toBeUndefined();
    }
    const typed = failureDetailLabel({ code: "provider_error", type: PROVIDER_KEY }, t);
    expect(typed).toBe("The provider returned an error");
  });
});


test("validation detail names only closed fields and causes in the dashboard", () => {
  expect(failureDetailLabel({ code: "provider_error", type: "invalid_request_error", validation: [
    { field: "max_completion_tokens", type: "extra_forbidden" }, { field: "messages.role", type: "union_tag_invalid" },
    { field: PROVIDER_KEY, type: "extra_forbidden" },
  ] }, t)).toBe("The provider returned an error (invalid_request_error): max_completion_tokens [extra_forbidden]; messages.role [union_tag_invalid]");
});
