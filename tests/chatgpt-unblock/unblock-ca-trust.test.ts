import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateSha1, chatgptCaTrustCommand, inspectChatgptCaTrust } from "../../src/chatgpt/desktop-unblock/ca-trust";
import { createLocalInterceptCa } from "../../src/claude/intercept/local-ca";
import type { SecurityRunner } from "../../src/claude/intercept/picker-trust";

let dir: string;
let caPath: string;
let sha1: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-ca-trust-"));
  caPath = join(dir, "ca.pem");
  const ca = createLocalInterceptCa();
  writeFileSync(caPath, ca.certPem);
  sha1 = certificateSha1(ca.certPem);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `security trust-settings-export <file>` stand-in that writes the given trusted fingerprints. */
function exporting(fingerprints: string[]): SecurityRunner {
  return async args => {
    expect(args[0]).toBe("trust-settings-export");
    const entries = fingerprints.map(f => `<key>${f}</key><dict><key>trustSettings</key><array/></dict>`).join("");
    writeFileSync(args[1]!, `<plist><dict><key>trustList</key><dict>${entries}</dict></dict></plist>`);
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("a CA whose fingerprint has user trust settings is trusted", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting(["00".repeat(20), sha1]), "darwin")).toBe("trusted");
});

test("trust for a different certificate does not count", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting(["AB".repeat(20)]), "darwin")).toBe("untrusted");
});

test("a user domain with no trust settings at all is untrusted, not unknown", async () => {
  const none: SecurityRunner = async () => ({ code: 1, stdout: "", stderr: "SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found." });
  expect(await inspectChatgptCaTrust(caPath, none, "darwin")).toBe("untrusted");
});

test("any other export failure is reported as unknown, never as trusted", async () => {
  const failing: SecurityRunner = async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." });
  expect(await inspectChatgptCaTrust(caPath, failing, "darwin")).toBe("unknown");
  const throwing: SecurityRunner = async () => { throw new Error("spawn failed"); };
  expect(await inspectChatgptCaTrust(caPath, throwing, "darwin")).toBe("unknown");
});

test("a CA that was never created is reported as missing", async () => {
  expect(await inspectChatgptCaTrust(join(dir, "absent.pem"), exporting([]), "darwin")).toBe("missing");
});

test("other platforms are not applicable", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting([sha1]), "linux")).toBe("unsupported");
});

test("the restore command trusts this CA for TLS as a root in the login keychain", () => {
  const command = chatgptCaTrustCommand(caPath);
  expect(command).toStartWith("security add-trusted-cert -r trustRoot -p ssl -k ");
  expect(command).toContain("login.keychain-db");
  expect(command).toEndWith(`"${caPath}"`);
});
