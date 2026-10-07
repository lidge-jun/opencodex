import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { claudeInterceptStateDir, ensureLocalInterceptCa } from "../../src/claude/intercept/local-ca";
import { setLocalCaFileHooksForTests, withLocalCaPublication } from "../../src/claude/intercept/local-ca-files";
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
  for (const failure of ["owner", "foreign read", "foreign tamper", "inspection error", "unprotected after hardening"] as const) {
    test(`Windows local CA rejects ${failure} on ${name} before reads or writes`, () => {
      const f = setup();
      const first = ensureLocalInterceptCa(f.root);
      f.writes.length = 0;
      f.reads.length = 0;
      f.secretWrites.length = 0;
      f.hardened.clear();
      resetHardenedStateForTests();
      const dir = claudeInterceptStateDir(f.root);
      const target = name === "claude-intercept" ? dir : join(dir, name);
      const keyBefore = readFileSync(join(dir, "ca.key"));
      const certBefore = readFileSync(join(dir, "ca.pem"));
      setLocalCaWindowsAclRunnerForTests(path => {
        if (basename(path) !== name) return acl();
        if (failure === "owner") return acl(FOREIGN);
        if (failure === "inspection error") throw new Error("native inspection unavailable");
        if (failure === "unprotected after hardening") return acl(CURRENT, undefined, false);
        return acl(CURRENT, [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }, { sid: FOREIGN, type: 0, rights: failure === "foreign read" ? 1 : 262144 }]);
      });
      expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
      expect(f.writes).toEqual([]);
      expect(f.secretWrites).toEqual([]);
      expect(f.reads).toEqual([]);
      // Only a trusted-grant DACL may be narrowed; foreign owners, grants and failed probes are never mutated.
      if (failure !== "unprotected after hardening") expect(f.hardened.has(target)).toBe(false);
      expect(readFileSync(join(dir, "ca.key"))).toEqual(keyBefore);
      expect(readFileSync(join(dir, "ca.pem"))).toEqual(certBefore);
      expect(certBefore.toString()).toBe(first.certPem);
    });
  }
}

for (const failure of ["foreign owner", "Administrators default owner", "foreign grant", "hardener failure", "probe failure", "timeout", "malformed", "empty DACL"] as const) {
  test(`Windows ${failure} while protecting a new temp causes zero secret writes`, () => {
    const f = setup();
    let tempSeen = false;
    setLocalCaWindowsAclRunnerForTests(path => {
      if (!path.endsWith(".tmp")) return acl();
      tempSeen = true;
      expect(statSync(path).size).toBe(0);
      if (failure === "foreign owner") return acl(FOREIGN);
      if (failure === "Administrators default owner") {
        expect(f.hardened.has(path)).toBe(true);
        return acl("S-1-5-32-544");
      }
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
  expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("ACL hardening failed (EACLIDENTITY)");
  expect(f.writes).toEqual([]);
  expect(f.secretWrites).toEqual([]);
});

test("Windows refuses a newly created directory with an Administrators default owner after hardening", () => {
  const f = setup();
  const dir = claudeInterceptStateDir(f.root);
  setLocalCaWindowsAclRunnerForTests(path => {
    expect(path).toBe(dir);
    expect(f.hardened.has(dir)).toBe(true);
    return acl("S-1-5-32-544");
  });
  expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
  expect(readdirSync(dir)).toEqual([]);
  expect(f.secretWrites).toEqual([]);
});

// Platform, principal and icacls seams exercise the Windows branch on POSIX CI too.
test("Windows accepts and hardens an existing unprotected directory with only trusted grants", () => {
  const f = setup();
  const dir = claudeInterceptStateDir(f.root);
  mkdirSync(dir, { mode: 0o700 });
  let inspections = 0;
  setLocalCaWindowsAclRunnerForTests(path => {
    if (path !== dir) return acl();
    inspections++;
    return acl(CURRENT, undefined, f.hardened.has(dir));
  });
  const ca = ensureLocalInterceptCa(f.root);
  expect(inspections).toBe(3); // strict, inherited, strict after hardening
  expect(f.hardened.has(dir)).toBe(true);
  expect(readFileSync(join(dir, "ca.key"), "utf8")).toBe(ca.keyPem);
});

for (const foreign of ["owner", "grant"] as const) {
  test(`Windows refuses an existing inherited directory with a foreign ${foreign} without hardening`, () => {
    const f = setup();
    const dir = claudeInterceptStateDir(f.root);
    mkdirSync(dir, { mode: 0o700 });
    setLocalCaWindowsAclRunnerForTests(() => acl(foreign === "owner" ? FOREIGN : CURRENT,
      [{ sid: foreign === "grant" ? FOREIGN : CURRENT, type: 0, rights: FULL_CONTROL }], false));
    const mutations: string[] = [];
    setIcaclsRunnerForTests(args => { mutations.push(args[0]!); return ok(); });
    expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
    expect(mutations).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(f.secretWrites).toEqual([]);
  });
}

for (const name of ["ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test(`Windows hardens a legacy inherited ${name} and retains the authority`, () => {
    const f = setup();
    const first = ensureLocalInterceptCa(f.root);
    const path = join(claudeInterceptStateDir(f.root), name);
    resetHardenedStateForTests();
    f.hardened.clear();
    f.writes.length = 0;
    let inspections = 0;
    setLocalCaWindowsAclRunnerForTests(target => {
      if (target !== path) return acl();
      inspections++;
      return acl(CURRENT, undefined, f.hardened.has(path));
    });
    const restored = ensureLocalInterceptCa(f.root);
    expect(restored.certPem).toBe(first.certPem);
    expect(restored.keyPem).toBe(first.keyPem);
    expect(f.hardened.has(path)).toBe(true);
    expect(inspections).toBe(3);
    expect(f.writes).toEqual([]);
  });
}

test("Windows memo verifies unchanged identities once per publication, including repeated pair reads", () => {
  const f = setup();
  const first = ensureLocalInterceptCa(f.root);
  const dir = claudeInterceptStateDir(f.root);
  const inspections: string[] = [];
  setLocalCaWindowsAclRunnerForTests(path => { inspections.push(path); return acl(); });
  withLocalCaPublication(dir, "ca-publication.sqlite", files => {
    expect(files.readPair()).toEqual({ certPem: first.certPem, keyPem: first.keyPem });
    expect(files.readPair()).toEqual({ certPem: first.certPem, keyPem: first.keyPem });
  });
  // Native SQLite may retain a journal during the lease; POSIX seams may not.
  expect(inspections.filter(path => !/sqlite-(journal|wal|shm)$/.test(path)).map(path => basename(path)).sort())
    .toEqual(["ca-publication.sqlite", "ca.key", "ca.pem", "claude-intercept"]);
  expect(new Set(inspections).size).toBe(inspections.length); // each unchanged sidecar is inspected at most once too
  inspections.length = 0;
  expect(ensureLocalInterceptCa(f.root).keyPem).toBe(first.keyPem);
  expect(inspections.filter(path => !/sqlite-(journal|wal|shm)$/.test(path))).toHaveLength(4); // no memo survives a publication
  expect(new Set(inspections).size).toBe(inspections.length);
});

test("Windows memo follows staged identities across rename without another ACL inspection", () => {
  const f = setup();
  const inspections: string[] = [];
  setLocalCaWindowsAclRunnerForTests(path => { inspections.push(path); return acl(); });
  ensureLocalInterceptCa(f.root);
  expect(inspections.filter(path => basename(path) === "claude-intercept")).toHaveLength(1);
  expect(inspections.filter(path => basename(path) === "ca-publication.sqlite")).toHaveLength(1);
  expect(inspections.filter(path => path.endsWith(".tmp"))).toHaveLength(2); // strict after hardening for each temp
  expect(inspections.filter(path => ["ca.key", "ca.pem"].includes(basename(path)))).toEqual([]);
});

test("Windows inherited SQLite sidecar is inspected once per identity without requiring protection or hardening", () => {
  const f = setup();
  ensureLocalInterceptCa(f.root);
  const dir = claudeInterceptStateDir(f.root);
  const sidecar = join(dir, "ca-publication.sqlite-shm");
  writeFileSync(sidecar, "fixture", { mode: 0o600 });
  let inspections = 0;
  setLocalCaWindowsAclRunnerForTests(path => {
    if (path !== sidecar) return acl();
    inspections++;
    return acl(CURRENT, undefined, false);
  });
  withLocalCaPublication(dir, "ca-publication.sqlite", files => { files.readPair(); files.readPair(); });
  expect(inspections).toBe(1);
  expect(f.hardened.has(sidecar)).toBe(false);
});

test("Windows re-inspects a substituted key identity and rejects foreign grants before reading it", () => {
  const f = setup();
  ensureLocalInterceptCa(f.root);
  const dir = claudeInterceptStateDir(f.root);
  const key = join(dir, "ca.key");
  const original = statSync(key, { bigint: true });
  const inspected: bigint[] = [];
  let substituted = false;
  setLocalCaWindowsAclRunnerForTests(path => {
    if (path !== key) return acl();
    inspected.push(statSync(path, { bigint: true }).ino);
    return substituted ? acl(CURRENT, [{ sid: FOREIGN, type: 0, rights: FULL_CONTROL }]) : acl();
  });
  withLocalCaPublication(dir, "ca-publication.sqlite", files => {
    files.readPair();
    // Keep the original inode alive so this fixture cannot accidentally recycle it.
    renameSync(key, join(f.root, "original-key"));
    writeFileSync(key, "substituted fixture", { mode: 0o600 });
    substituted = true;
    f.reads.length = 0;
    expect(() => { files.readPair(); }).toThrow("Windows owner/ACL");
    expect(f.reads).toEqual([]);
    // Restore before the publication's final entry guard.
    renameSync(key, join(f.root, "substituted-key"));
    renameSync(join(f.root, "original-key"), key);
    substituted = false;
  });
  expect(inspected).toHaveLength(3); // original private, replacement private + inherited
  expect(inspected[0]).toBe(original.ino);
  expect(inspected[1]).not.toBe(original.ino);
  expect(inspected[2]).toBe(inspected[1]);
});
