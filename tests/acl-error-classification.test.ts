import { describe, expect, test } from "bun:test";
import {
  adapterFailureFromMessage,
  inferHttpStatusFromAdapterMessage,
} from "../src/lib/errors";

describe("Windows ACL error classification", () => {
  test("maps local ACL hardening failures to 503 server errors", () => {
    const messages = [
      "icacls /grant:r timed out while applying authentication permissions",
      "ACL hardening failed: access denied",
      "NTFS permission setup failed during authentication",
      "Secret path hardening failed: access denied",
      "Windows secret ACL update failed: authentication error",
      "/inheritance:r failed: access denied",
      "/grant:r failed while applying authentication permissions",
    ];

    for (const message of messages) {
      expect(inferHttpStatusFromAdapterMessage(message)).toBe(503);
      expect(adapterFailureFromMessage(message)).toMatchObject({
        httpStatus: 503,
        error: { type: "server_error" },
      });
    }
  });

  test("keeps genuine credential failures classified as authentication errors", () => {
    expect(adapterFailureFromMessage(
      "Provider authentication failed: invalid API key",
    )).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });
});
