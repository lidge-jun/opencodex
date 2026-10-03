import { describe, expect, test } from "bun:test";
import { formatAccountTable } from "../../src/cli/account";

/**
 * The verify_account STATUS rendering.
 *
 * Kept out of the `#180` matrix file because that one sits at its file-size ratchet cap; the
 * rendering assertion needs no harness beyond formatAccountTable.
 */
describe("ocx account CLI verify status", () => {
  test("verify_account reauth renders a distinct STATUS from a dead credential", () => {
    const table = formatAccountTable([
      { provider: "google-antigravity", type: "oauth", id: "bad", label: "bad", active: false, needsReauth: true, needsReauthReason: "verify_account" },
      { provider: "google-antigravity", type: "oauth", id: "dead", label: "dead", active: false, needsReauth: true },
    ]);

    const [, badLine, deadLine] = table.split("\n");
    expect(badLine).toMatch(/needs-reauth\(verify\)$/);
    expect(deadLine).toMatch(/needs-reauth$/);
    expect(deadLine).not.toContain("(verify)");
  });
});
