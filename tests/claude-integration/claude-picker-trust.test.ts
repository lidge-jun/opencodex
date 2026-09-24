import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  inspectPickerTrust, loginKeychainPath, trustPickerCa, untrustPickerCa,
  type SecurityResult, type SecurityRunner,
} from "../../src/claude/intercept/picker-trust";
import { PICKER_CA_COMMON_NAME } from "../../src/claude/intercept/picker-ca";

const sha1 = "A".repeat(40);
const ok: SecurityResult = { code: 0, stdout: "", stderr: "" };
/** A readable trust-settings export with no entry for the picker CA. */
const NO_ENTRIES = "<?xml version=\"1.0\"?><plist><dict><key>trustList</key><dict></dict></dict></plist>";

function fake(...results: SecurityResult[]): { run: SecurityRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return { calls, run: async args => {
    calls.push([...args]);
    const result = results.shift() ?? ok;
    if (args[0] === "trust-settings-export" && result.code === 0) writeFileSync(args[1]!, NO_ENTRIES);
    return result;
  } };
}

test("inspection requires the current root fingerprint and verifies the persisted leaf", async () => {
  const f = fake({ ...ok, stdout: `SHA-1 hash: ${sha1}\n` }, ok);
  expect(await inspectPickerTrust("/leaf.pem", sha1, f.run, "darwin")).toBe("trusted");
  expect(f.calls.slice(0, 2)).toEqual([
    ["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, loginKeychainPath()],
    ["verify-cert", "-q", "-L", "-c", "/leaf.pem", "-p", "ssl", "-n", "claude.ai", "-k", loginKeychainPath()],
  ]);
  // Then the user trust settings are read to rule out a host-scoped setting.
  expect(f.calls[2]?.[0]).toBe("trust-settings-export");
  expect(f.calls).toHaveLength(3);
});

function plist(entries: Record<string, string>): string {
  const body = Object.entries(entries).map(([hash, settings]) =>
    `<key>${hash}</key><dict><key>trustSettings</key><array>${settings}</array></dict>`).join("");
  return `<?xml version="1.0"?><plist><dict><key>trustList</key><dict>${body}</dict></dict></plist>`;
}

test("a host-scoped trust setting for the current CA reads as untrusted so trust is added again", async () => {
  const sslOnly = "<dict><key>kSecTrustSettingsPolicyName</key><string>sslServer</string></dict>";
  const hostScoped = "<dict><key>kSecTrustSettingsPolicyName</key><string>sslServer</string>"
    + "<key>kSecTrustSettingsPolicyString</key><string>claude.ai</string></dict>";
  const other = "C".repeat(40);
  const cases: Array<[string, string, string]> = [
    ["host-scoped current CA", plist({ [sha1]: hostScoped }), "untrusted"],
    ["SSL-only current CA", plist({ [sha1]: sslOnly }), "trusted"],
    ["host scope on another cert only", plist({ [sha1]: sslOnly, [other]: hostScoped }), "trusted"],
  ];
  for (const [, exported, expected] of cases) {
    const run: SecurityRunner = async args => {
      if (args[0] === "find-certificate") return { ...ok, stdout: `SHA-1 hash: ${sha1}\n` };
      if (args[0] === "trust-settings-export") writeFileSync(args[1]!, exported);
      return ok;
    };
    expect(await inspectPickerTrust("/leaf.pem", sha1, run, "darwin")).toBe(expected);
  }
  // Unreadable settings could hide a host scope Chromium skips, so trust stays unknown and unarmed.
  const failing: SecurityRunner = async args => args[0] === "find-certificate"
    ? { ...ok, stdout: `SHA-1 hash: ${sha1}\n` }
    : args[0] === "trust-settings-export" ? { ...ok, code: 1 } : ok;
  expect(await inspectPickerTrust("/leaf.pem", sha1, failing, "darwin")).toBe("unknown");
  const unwritten: SecurityRunner = async args => args[0] === "find-certificate"
    ? { ...ok, stdout: `SHA-1 hash: ${sha1}\n` }
    : ok;
  expect(await inspectPickerTrust("/leaf.pem", sha1, unwritten, "darwin")).toBe("unknown");
});

test("missing or stale root never reaches leaf verification", async () => {
  for (const stdout of ["", `SHA-1 hash: ${"B".repeat(40)}\n`]) {
    const f = fake({ ...ok, stdout });
    expect(await inspectPickerTrust("/leaf.pem", sha1, f.run, "darwin")).toBe("untrusted");
    expect(f.calls).toHaveLength(1);
  }
});

test("exit 1 is untrusted; other command failures are unknown", async () => {
  const matched = { ...ok, stdout: `SHA-1 hash: ${sha1}\n` };
  expect(await inspectPickerTrust("/leaf.pem", sha1, fake(matched, { ...ok, code: 1 }).run, "darwin")).toBe("untrusted");
  expect(await inspectPickerTrust("/leaf.pem", sha1, fake(matched, { ...ok, code: 2 }).run, "darwin")).toBe("unknown");
  expect(await inspectPickerTrust("/leaf.pem", sha1, fake({ ...ok, code: 1 }).run, "darwin")).toBe("untrusted");
  expect(await inspectPickerTrust("/leaf.pem", sha1, fake({ ...ok, code: null }).run, "darwin")).toBe("unknown");
  expect(await inspectPickerTrust("/leaf.pem", sha1, async () => { throw new Error("failed"); }, "darwin")).toBe("unknown");
});

test("trust and untrust pass the exact security argv", async () => {
  const listed = { ...ok, stdout: `SHA-1 hash: ${sha1}\n` };
  const find = ["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, loginKeychainPath()];
  const f = fake(ok, listed, ok, ok, { ...ok, code: 1 });
  expect(await trustPickerCa("/ca.pem", f.run, "darwin")).toEqual({ ok: true });
  expect(await untrustPickerCa("/ca.pem", sha1, f.run, "darwin")).toEqual({ ok: true });
  expect(f.calls).toEqual([
    // No host policy string: Chromium ignores host-scoped trust settings.
    ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychainPath(), "/ca.pem"],
    find,
    ["remove-trusted-cert", "/ca.pem"],
    ["delete-certificate", "-Z", sha1, loginKeychainPath()],
    find,
  ]);
  expect(await trustPickerCa("/ca.pem", fake({ ...ok, code: 1 }).run, "darwin"))
    .toEqual({ ok: false, reason: "declined_or_failed" });
});

test("untrust is a no-op success when the current CA is not in the login keychain", async () => {
  for (const found of [{ ...ok, code: 1 }, { ...ok, stdout: `SHA-1 hash: ${"B".repeat(40)}\n` }]) {
    const f = fake(found);
    expect(await untrustPickerCa("/ca.pem", sha1, f.run, "darwin")).toEqual({ ok: true });
    expect(f.calls.map(call => call[0])).toEqual(["find-certificate"]);
  }
  // A removal that leaves the certificate listed is not success.
  const listed = { ...ok, stdout: `SHA-1 hash: ${sha1}\n` };
  expect(await untrustPickerCa("/ca.pem", sha1, fake(listed, ok, ok, listed).run, "darwin")).toEqual({ ok: false });
});

test("non-darwin never invokes the runner", async () => {
  const run: SecurityRunner = async () => { throw new Error("runner must stay idle"); };
  expect(await inspectPickerTrust("/leaf.pem", sha1, run, "linux")).toBe("unsupported");
  expect(await trustPickerCa("/ca.pem", run, "linux")).toEqual({ ok: false, reason: "unsupported" });
  expect(await untrustPickerCa("/ca.pem", sha1, run, "linux")).toEqual({ ok: false });
});
