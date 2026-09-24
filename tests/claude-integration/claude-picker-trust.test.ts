import { expect, test } from "bun:test";
import {
  inspectPickerTrust, loginKeychainPath, trustPickerCa, untrustPickerCa,
  type SecurityResult, type SecurityRunner,
} from "../../src/claude/intercept/picker-trust";
import { PICKER_CA_COMMON_NAME } from "../../src/claude/intercept/picker-ca";

const sha1 = "A".repeat(40);
const ok: SecurityResult = { code: 0, stdout: "", stderr: "" };

function fake(...results: SecurityResult[]): { run: SecurityRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return { calls, run: async args => {
    calls.push([...args]);
    return results.shift() ?? ok;
  } };
}

test("inspection requires the current root fingerprint and verifies the persisted leaf", async () => {
  const f = fake({ ...ok, stdout: `SHA-1 hash: ${sha1}\n` }, ok);
  expect(await inspectPickerTrust("/leaf.pem", sha1, f.run, "darwin")).toBe("trusted");
  expect(f.calls).toEqual([
    ["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, loginKeychainPath()],
    ["verify-cert", "-q", "-L", "-c", "/leaf.pem", "-p", "ssl", "-n", "claude.ai", "-k", loginKeychainPath()],
  ]);
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
