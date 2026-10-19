import { describe, expect, test } from "bun:test";
import { cancelLoginFlow, getLoginStatus } from "../../src/oauth";
import { loginState } from "../../src/oauth/login-flow-state";

describe("OAuth login cancellation and error lifecycle", () => {
  test("cancelLoginFlow clears finalized transient error state so it stops masking status", () => {
    const provider = "google-antigravity";
    // Simulate a failed/aborted login attempt that settled with an error
    loginState.set(provider, {
      done: true,
      error: "OAuth authentication failed. Check the OpenCodex account status and retry.",
    });

    // Before cancel, getLoginStatus reflects the error
    let status = getLoginStatus(provider);
    expect(status.error).toBe("OAuth authentication failed. Check the OpenCodex account status and retry.");
    expect(status.done).toBe(true);

    // Call cancelLoginFlow
    const cancelled = cancelLoginFlow(provider);
    expect(cancelled).toBe(true);

    // After cancel, the transient error must be cleared
    status = getLoginStatus(provider);
    expect(status.error).toBeUndefined();
    expect(status.done).toBe(false);
  });
});
