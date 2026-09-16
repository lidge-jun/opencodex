import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeCodexUpstreamAuth, materializeCodexUpstreamAuthAsync } from "../../src/codex/auth-context";

export function registerStoredDirectIdentityTests(getTestDir: () => string, liveJwt: () => string): void {
  test("an admission bearer on main substitutes the stored credential, never forwards it (#1686)", () => {
    // The caller proved admission with one of OUR secrets. That secret must never leave the
    // process, so the only acceptable outcome is the stored main credential in its place.
    const admissionSecret = "ocx_data_localsecret";
    const storedCredential = liveJwt();
    writeFileSync(join(getTestDir(), "auth.json"), JSON.stringify({
      tokens: { access_token: storedCredential, account_id: "stored_main_acc" },
    }));

    const headers = materializeCodexUpstreamAuth(
      new Headers({ authorization: `Bearer ${admissionSecret}`, "openai-beta": "responses=experimental" }),
      { kind: "main", accountId: null },
      { substituteMainCredential: true },
    );

    expect(headers.get("authorization")).not.toContain(admissionSecret);
    expect(headers.get("authorization")).toBe(`Bearer ${storedCredential}`);
    expect(headers.get("chatgpt-account-id")).toBe("stored_main_acc");
    // Unrelated forwarded headers still ride along.
    expect(headers.get("openai-beta")).toBe("responses=experimental");
  });

  test("sync stored Direct substitution clears a missing account ID without changing inbound headers", () => {
    const storedCredential = liveJwt();
    writeFileSync(join(getTestDir(), "auth.json"), JSON.stringify({
      tokens: { access_token: storedCredential },
    }));
    const inbound = new Headers({
      authorization: "Bearer ocx_data_localsecret",
      "chatgpt-account-id": "caller-account",
      "openai-beta": "responses=experimental",
    });
    const originalHeaders = [...inbound.entries()];

    const headers = materializeCodexUpstreamAuth(
      inbound,
      { kind: "main", accountId: null },
      { substituteMainCredential: true },
    );

    expect(headers.get("authorization")).toBe(`Bearer ${storedCredential}`);
    expect(headers.get("chatgpt-account-id")).toBeNull();
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect([...inbound.entries()]).toEqual(originalHeaders);
  });

  test.each([
    ["absent", undefined, null],
    ["present", "stored_main_acc", "stored_main_acc"],
  ])("async stored Direct substitution owns account identity when %s", async (_label, accountId, expectedAccountId) => {
    const storedCredential = liveJwt();
    writeFileSync(join(getTestDir(), "auth.json"), JSON.stringify({
      tokens: { access_token: storedCredential, account_id: accountId },
    }));
    const inbound = new Headers({
      authorization: "Bearer ocx_data_localsecret",
      "chatgpt-account-id": "caller-account",
      "openai-beta": "responses=experimental",
    });

    const headers = await materializeCodexUpstreamAuthAsync(
      inbound,
      { kind: "main", accountId: null },
      { substituteMainCredential: true },
    );

    expect(headers.get("authorization")).toBe(`Bearer ${storedCredential}`);
    expect(headers.get("chatgpt-account-id")).toBe(expectedAccountId);
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(inbound.get("chatgpt-account-id")).toBe("caller-account");
  });

}
