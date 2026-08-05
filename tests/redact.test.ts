import { describe, expect, test } from "bun:test";
import {
  REDACTED_SECRET,
  redactHeaders,
  redactSecretString,
  redactSecrets,
  redactUrlForLog,
} from "../src/lib/redact";

describe("redactSecretString", () => {
  test("masks bearer, api, access, refresh, and profile values", () => {
    const input = [
      "Authorization: Bearer access-token-value-123456",
      "api_key=sk-secret-provider-key",
      "accessToken=access-live-value",
      "refresh_token=refresh-live-value",
      "clientSecret=client-secret-live-value",
      "profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`Bearer ${REDACTED_SECRET}`);
    expect(redacted).toContain(`api_key=${REDACTED_SECRET}`);
    expect(redacted).toContain(`accessToken=${REDACTED_SECRET}`);
    expect(redacted).toContain(`refresh_token=${REDACTED_SECRET}`);
    expect(redacted).toContain(`clientSecret=${REDACTED_SECRET}`);
    expect(redacted).not.toContain("access-token-value-123456");
    expect(redacted).not.toContain("sk-secret-provider-key");
    expect(redacted).not.toContain("refresh-live-value");
    expect(redacted).not.toContain("client-secret-live-value");
    expect(redacted).not.toContain("arn:aws:codewhisperer");
  });

  test("preserves non-secret diagnostic text", () => {
    expect(redactSecretString("status=429 model=gpt-5.5")).toBe("status=429 model=gpt-5.5");
  });

  test("masks colon-labelled credentials echoed back by an upstream error", () => {
    // #1020 review: upstream 4xx bodies quote the offending header at us. The
    // `=` rules never fire for `header: value`, so a custom credential used to
    // survive into the client-visible error text.
    const input = [
      "x-api-key: customcredential123456",
      "X-Goog-Api-Key: another-live-credential",
      "client_secret: not-a-sk-shaped-value",
      "token: opaque-session-value",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`x-api-key: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`X-Goog-Api-Key: ${REDACTED_SECRET}`);
    expect(redacted).not.toContain("customcredential123456");
    expect(redacted).not.toContain("another-live-credential");
    expect(redacted).not.toContain("not-a-sk-shaped-value");
    expect(redacted).not.toContain("opaque-session-value");
  });

  test("leaves non-credential colon labels readable", () => {
    // The colon rule must not swallow ordinary diagnostics.
    expect(redactSecretString("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123"))
      .toBe("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123");
  });

  test("masks the WHOLE colon-labelled value, including delimiter-bearing forms", () => {
    // Re-review of the first fix: tokenizing the value on quotes, spaces, and
    // semicolons leaked every variant that contains one. A credential header's
    // value is the rest of the line, so that is what must be masked.
    expect(redactSecretString('x-api-key: "quotedcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Basic dXNlcjpwYXNz"))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    expect(redactSecretString("Cookie: session=secret-one; csrf=secret-two"))
      .toBe(`Cookie: ${REDACTED_SECRET}`);
  });

  test("keeps the Bearer scheme readable while masking its token", () => {
    // An auth scheme is diagnostically useful; the credential after it is not.
    expect(redactSecretString("Authorization: Bearer abcdefgh12345678"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("masks each credential line independently without eating the next", () => {
    // End-of-line, not end-of-string: a multi-line error body must not collapse.
    expect(redactSecretString("x-api-key: one-secret\nmodel: gpt-5.5\ncookie: two=secret"))
      .toBe(`x-api-key: ${REDACTED_SECRET}\nmodel: gpt-5.5\ncookie: ${REDACTED_SECRET}`);
  });
});

describe("redactSecrets", () => {
  test("recursively masks sensitive keys and embedded secret strings", () => {
    const input = {
      ok: true,
      count: 3,
      headers: {
        Authorization: "Bearer nested-secret-token",
        "content-type": "application/json",
      },
      tokens: [
        { accessToken: "access-abc" },
        "refreshToken=refresh-abc",
      ],
      nested: {
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      },
    };

    const redacted = redactSecrets(input) as typeof input;
    expect(redacted.ok).toBe(true);
    expect(redacted.count).toBe(3);
    expect(redacted.headers.Authorization).toBe(REDACTED_SECRET);
    expect(redacted.headers["content-type"]).toBe("application/json");
    expect(redacted.tokens[0].accessToken).toBe(REDACTED_SECRET);
    expect(redacted.tokens[1]).toBe(`refreshToken=${REDACTED_SECRET}`);
    expect(redacted.nested.profileArn).toBe(REDACTED_SECRET);
  });

  test("leaves dates and primitive non-secrets intact", () => {
    const date = new Date("2026-06-29T00:00:00.000Z");
    expect(redactSecrets(date)).toBe(date);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42)).toBe(42);
  });
});

describe("redactHeaders", () => {
  test("masks sensitive headers and preserves safe metadata", () => {
    const redacted = redactHeaders(new Headers({
      Authorization: "Bearer header-token-value",
      Cookie: "session=secret",
      "Set-Cookie": "session=secret",
      "X-Api-Key": "sk-header-key",
      "Content-Type": "application/json",
      "X-Request-Id": "req_123",
    }));

    expect(redacted.authorization).toBe(REDACTED_SECRET);
    expect(redacted.cookie).toBe(REDACTED_SECRET);
    expect(redacted["set-cookie"]).toBe(REDACTED_SECRET);
    expect(redacted["x-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted["content-type"]).toBe("application/json");
    expect(redacted["x-request-id"]).toBe("req_123");
  });

  test("supports plain header records", () => {
    const redacted = redactHeaders({
      "x-goog-api-key": "google-secret",
      accept: "application/json",
      "x-extra": undefined,
    });

    expect(redacted["x-goog-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted.accept).toBe("application/json");
    expect(redacted).not.toHaveProperty("x-extra");
  });
});

describe("redactUrlForLog", () => {
  test("strips credentials, query, and hash from valid URLs", () => {
    expect(redactUrlForLog("https://user:pass@example.test/v1/models?api_key=sk-secret#frag"))
      .toBe("https://example.test/v1/models");
  });

  test("best-effort redacts invalid URL strings", () => {
    expect(redactUrlForLog("not a url?refreshToken=refresh-secret")).toBe("not a url");
  });
});
