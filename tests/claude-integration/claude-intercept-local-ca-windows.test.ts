import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { claudeInterceptStateDir, ensureLocalInterceptCa } from "../../src/claude/intercept/local-ca";
import { setLocalCaFileHooksForTests } from "../../src/claude/intercept/local-ca-files";
import { setLocalCaWindowsAclRunnerForTests } from "../../src/claude/intercept/local-ca-windows";
import { resetHardenedStateForTests, setIcaclsRunnerForTests, setPlatformForTests, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";

const CURRENT = "S-1-5-21-1-2-3-1001";
const FOREIGN = "S-1-5-21-9-8-7-1002";
const FULL_CONTROL = 2032127;
const roots: string[] = [];
let restoreWrites: (() => void) | undefined;
type Rule = { sid: string; type: number; rights: number };
const ok = (stdout = ""): IcaclsResult => ({ success: true, exitCode: 0, timedOut: false, stdout });
const acl = (owner = CURRENT, rules: Rule[] = [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }], protectedDacl = true): IcaclsResult =>
  ok(JSON.stringify({ owner, protected: protectedDacl, rules }));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ocx-ca-windows-"));
  roots.push(root);
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${CURRENT}\nfixture\\account` }));
  resetHardenedStateForTests();
  const hardened = new Set<string>();
  const emptyTempProtections: string[] = [];
  setIcaclsRunnerForTests(args => {
    if (args[1] === "/grant:r" && args[0]!.endsWith(".tmp")) {
      expect(statSync(args[0]!).size).toBe(0);
      emptyTempProtections.push(args[0]!);
    }
    if (args[1] === "/remove:g") hardened.add(args[0]!);
    return ok();
  });
  setLocalCaWindowsAclRunnerForTests(path => acl(CURRENT, [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }], true));
  const writes: string[] = [];
  const reads: string[] = [];
  const secretWrites: string[] = [];
  const originalWrite = filesystem.writeFileSync;
  const writeSpy = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (String(data).includes("PRIVATE KEY")) secretWrites.push(String(path));
    return originalWrite(path, data, options);
  });
  restoreWrites = () => { writeSpy.mockRestore(); };
  setLocalCaFileHooksForTests({ beforeWrite: path => { writes.push(path); }, beforeRead: path => { reads.push(path); } });
  return { root, hardened, emptyTempProtections, writes, reads, secretWrites };
}

afterEach(() => {
  restoreWrites?.();
  restoreWrites = undefined;
  setLocalCaFileHooksForTests(null);
  setLocalCaWindowsAclRunnerForTests(null);
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  resetHardenedStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Windows local CA protects and verifies empty temps before every PEM write", () => {
  const f = setup();
  setLocalCaWindowsAclRunnerForTests(path => {
    const protectedDacl = f.hardened.has(path);
    const inheritedPrivate = /sqlite-(journal|wal|shm)$/.test(path) && f.hardened.has(claudeInterceptStateDir(f.root));
    return acl(CURRENT, [{ sid: protectedDacl || inheritedPrivate ? CURRENT : "S-1-5-32-545", type: 0, rights: FULL_CONTROL }], protectedDacl);
  });
  // The fake records protection per pathname; rename keeps the DACL of the staged inode.
  setLocalCaFileHooksForTests({ beforeWrite: path => {
    expect(f.hardened.has(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
    f.writes.push(path);
  }, beforePublish: path => { f.hardened.add(path); } });
  const first = ensureLocalInterceptCa(f.root);
  expect(f.writes).toHaveLength(2);
  expect(f.secretWrites).toHaveLength(1);
  expect(f.emptyTempProtections).toHaveLength(2);
  expect(readFileSync(join(claudeInterceptStateDir(f.root), "ca.key"), "utf8")).toBe(first.keyPem);
  expect(ensureLocalInterceptCa(f.root).certPem).toBe(first.certPem);
});

for (const name of ["claude-intercept", "ca.key", "ca.pem", "ca-publication.sqlite"]) {
  for (const failure of ["owner", "foreign read", "foreign tamper", "inspection error", "unprotected"] as const) {
    test(`Windows local CA rejects ${failure} on ${name} before reads or writes`, () => {
      const f = setup();
      const first = ensureLocalInterceptCa(f.root);
      f.writes.length = 0;
      f.reads.length = 0;
      f.secretWrites.length = 0;
      const dir = claudeInterceptStateDir(f.root);
      const keyBefore = readFileSync(join(dir, "ca.key"));
      const certBefore = readFileSync(join(dir, "ca.pem"));
      setLocalCaWindowsAclRunnerForTests(path => {
        if (basename(path) !== name) return acl();
        if (failure === "owner") return acl(FOREIGN);
        if (failure === "inspection error") throw new Error("native inspection unavailable");
        if (failure === "unprotected") return acl(CURRENT, undefined, false);
        return acl(CURRENT, [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }, { sid: FOREIGN, type: 0, rights: failure === "foreign read" ? 1 : 262144 }]);
      });
      expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
      expect(f.writes).toEqual([]);
      expect(f.secretWrites).toEqual([]);
      expect(f.reads).toEqual([]);
      expect(readFileSync(join(dir, "ca.key"))).toEqual(keyBefore);
      expect(readFileSync(join(dir, "ca.pem"))).toEqual(certBefore);
      expect(certBefore.toString()).toBe(first.certPem);
    });
  }
}

for (const failure of ["foreign owner", "foreign grant", "hardener failure", "probe failure", "timeout", "malformed", "empty DACL"] as const) {
  test(`Windows ${failure} while protecting a new temp causes zero secret writes`, () => {
    const f = setup();
    let tempSeen = false;
    setLocalCaWindowsAclRunnerForTests(path => {
      if (!path.endsWith(".tmp")) return acl();
      tempSeen = true;
      expect(statSync(path).size).toBe(0);
      if (failure === "foreign owner") return acl(FOREIGN);
      if (failure === "foreign grant") return acl(CURRENT, [{ sid: FOREIGN, type: 0, rights: 2 }]);
      if (failure === "probe failure") return { success: false, exitCode: 1, timedOut: false, stdout: "native failure" };
      if (failure === "timeout") return { success: false, exitCode: null, timedOut: true, stdout: "" };
      if (failure === "malformed") return ok("{invalid");
      if (failure === "empty DACL") return acl(CURRENT, []);
      return acl();
    });
    if (failure === "hardener failure") setIcaclsRunnerForTests(args => {
      if (args[0]!.endsWith(".tmp")) { tempSeen = true; expect(statSync(args[0]!).size).toBe(0); throw new Error("native ACL failure"); }
      return ok();
    });
    expect(() => { ensureLocalInterceptCa(f.root); }).toThrow();
    expect(tempSeen).toBe(true);
    expect(f.writes).toEqual([]);
    expect(f.secretWrites).toEqual([]);
    const names = readdirSync(claudeInterceptStateDir(f.root));
    expect(names).not.toContain("ca.key");
    expect(names).not.toContain("ca.pem");
    for (const name of names.filter(name => name.endsWith(".tmp"))) expect(statSync(join(claudeInterceptStateDir(f.root), name)).size).toBe(0);
  });
}

test("Windows allows current SID, SYSTEM and Administrators and harmless Deny entries", () => {
  const f = setup();
  setLocalCaWindowsAclRunnerForTests(() => acl(CURRENT, [
    { sid: CURRENT, type: 0, rights: FULL_CONTROL },
    { sid: "S-1-5-18", type: 0, rights: FULL_CONTROL },
    { sid: "S-1-5-32-544", type: 0, rights: FULL_CONTROL },
    { sid: FOREIGN, type: 1, rights: FULL_CONTROL },
  ]));
  const first = ensureLocalInterceptCa(f.root);
  expect(ensureLocalInterceptCa(f.root).keyPem).toBe(first.keyPem);
});

test("Windows inspection failure on corrupt PEM never enters corruption regeneration", () => {
  const f = setup();
  ensureLocalInterceptCa(f.root);
  const path = join(claudeInterceptStateDir(f.root), "ca.key");
  writeFileSync(path, "benign corrupt key");
  f.writes.length = 0;
  f.secretWrites.length = 0;
  setLocalCaWindowsAclRunnerForTests(target => target === path ? acl(FOREIGN) : acl());
  expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
  expect(f.writes).toEqual([]);
  expect(f.secretWrites).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("benign corrupt key");
});

test("Windows effective SID lookup failure occurs before any secret write", () => {
  const f = setup();
  setWindowsPrincipalRunnerForTests(() => ({ success: false, exitCode: 1, timedOut: false, stdout: "" }));
  expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
  expect(f.writes).toEqual([]);
  expect(f.secretWrites).toEqual([]);
});
