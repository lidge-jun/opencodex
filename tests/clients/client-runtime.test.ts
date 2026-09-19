import { describe, expect, test } from "bun:test";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { standaloneRecycleEnv } from "../../src/client/runtime";

describe("standalone recycle environment", () => {
  test("removes a disconnected hub token and its token-file source", () => {
    const hubToken = "hub-issued-token";
    const source = {
      OPENCODEX_API_AUTH_TOKEN: hubToken,
      OCX_API_TOKEN_FILE: "/tmp/hub-service-token",
      PATH: "/usr/bin",
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint(hubToken))).toEqual({
      PATH: "/usr/bin",
    });
    expect(source.OPENCODEX_API_AUTH_TOKEN).toBe(hubToken);
  });

  test("preserves an independently configured operator credential", () => {
    const operatorToken = "operator-token";
    const source = {
      OPENCODEX_API_AUTH_TOKEN: operatorToken,
      OCX_API_TOKEN_FILE: "/tmp/operator-token",
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint("disconnected-hub-token"))).toEqual(source);
  });
});
