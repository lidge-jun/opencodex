import { describe, expect, test } from "bun:test";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAsideProfileBoundary, guardAsideProfileIO, listAsideProfiles,
} from "../../src/clients/aside-profiles";
import { ClientPathError } from "../../src/clients/config-export";
import { defaultIntegrationIO } from "../../src/integrations/config-io";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accounts = [{ id: 0, name: "Cloud" }, { id: 1, name: "Local one" }, { id: 2, name: "Local two" }];

function fixture(run: (home: string, root: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "ocx-aside-paths-"));
  const root = join(home, ".aside");
  try {
    for (const { id } of accounts) mkdirSync(join(root, "u", String(id)), { recursive: true });
    manifest(root, { currentAccountId: 0, accounts });
    run(home, root);
  } finally { removeTreeWithRetry(home); }
}

function manifest(root: string, value: unknown): void {
  writeFileSync(join(root, "accounts.json"), JSON.stringify(value));
}

function ioFor(home: string) {
  const store = createIntegrationStateStore(join(home, "integration-store"));
  return { store, io: defaultIntegrationIO(store) };
}

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("Aside profile manifest", () => {
  test("projects only safe metadata for cloud and local accounts", () => fixture((home, root) => {
    manifest(root, {
      currentAccountId: 1,
      accounts: accounts.map(account => ({
        ...account, session: { token: "fixture-private-value" }, email: "fixture@example.test", userId: "private-user",
      })),
      profileAccountBindings: [{ accountId: 0, profilePath: join(home, "not-a-target") }],
    });
    const profiles = listAsideProfiles({}, home);
    expect(profiles).toEqual(accounts.map(account => ({
      ...account, current: account.id === 1, root,
      detectDir: join(root, "u", String(account.id)),
      configPath: join(root, "u", String(account.id), "models.json"),
    })));
    expect(JSON.stringify(profiles)).not.toMatch(/session|token|email|userId|private-value|profilePath/);
  }));

  test("supports currentAccountId-only legacy manifests without guessing zero", () => fixture((home, root) => {
    manifest(root, { currentAccountId: 2 });
    expect(listAsideProfiles({}, home)).toEqual([{
      id: 2, current: true, root, detectDir: join(root, "u", "2"), configPath: join(root, "u", "2", "models.json"),
    }]);
  }));

  test("refuses a missing or malformed manifest with safe errors", () => fixture((home, root) => {
    rmSync(join(root, "accounts.json"));
    expect(() => listAsideProfiles({}, home)).toThrow(ClientPathError);
    writeFileSync(join(root, "accounts.json"), '{"session":"fixture-private-value",broken');
    try { listAsideProfiles({}, home); throw new Error("expected refusal"); } catch (error) {
      expect(error).toBeInstanceOf(ClientPathError);
      expect((error as Error).message).not.toContain("fixture-private-value");
    }
  }));

  test("rejects malformed identities, duplicates and inconsistent current metadata", () => fixture((home, root) => {
    const invalid = [
      null, [], {}, { currentAccountId: "0" }, { currentAccountId: -1 },
      { currentAccountId: 0, accounts: null }, { currentAccountId: 0, accounts: [] },
      { currentAccountId: 0, accounts: [{ id: 0 }, { id: 0 }] },
      { currentAccountId: 3, accounts },
      { currentAccountId: 0, accounts: [{ id: 0, current: false }] },
      { currentAccountId: 0, accounts: [{ id: 0 }, { id: 1, current: true }] },
      ...["1", "../2", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null].map(id => ({
        currentAccountId: 0, accounts: [{ id: 0 }, { id }],
      })),
    ];
    for (const value of invalid) {
      manifest(root, value);
      expect(() => listAsideProfiles({}, home)).toThrow(ClientPathError);
    }
    writeFileSync(join(root, "accounts.json"), '{"currentAccountId":-0}');
    expect(() => listAsideProfiles({}, home)).toThrow(ClientPathError);
  }));

  test("accepts safe integer IDs and exactly 128 accounts, but never truncates overflow", () => fixture((home, root) => {
    manifest(root, { currentAccountId: Number.MAX_SAFE_INTEGER });
    expect(listAsideProfiles({}, home)[0]!.id).toBe(Number.MAX_SAFE_INTEGER);
    const bounded = Array.from({ length: 128 }, (_, id) => ({ id }));
    manifest(root, { currentAccountId: 0, accounts: bounded });
    expect(listAsideProfiles({}, home)).toHaveLength(128);
    manifest(root, { currentAccountId: 0, accounts: [...bounded, { id: 128 }] });
    expect(() => listAsideProfiles({}, home)).toThrow(ClientPathError);
  }));
});

describe("Aside profile filesystem boundary", () => {
  test("missing account directories report not installed and cannot be recreated", () => fixture((home, root) => {
    rmSync(join(root, "u", "1"), { recursive: true });
    const profiles = listAsideProfiles({}, home);
    const profile = profiles[1]!;
    assertAsideProfileBoundary(profile, profiles);
    const guarded = guardAsideProfileIO(profile, ioFor(home).io, profiles);
    expect(guarded.statKind(profile.detectDir)).toBe("missing");
    expect(guarded.readText(profile.configPath)).toEqual({ kind: "missing" });
    expect(() => assertAsideProfileBoundary(profile, profiles, true)).toThrow(ClientPathError);
    expect(() => guarded.mkdirp(profile.detectDir)).toThrow(ClientPathError);
    expect(() => guarded.writeText(profile.configPath, "{}")).toThrow(ClientPathError);
    expect(() => guarded.removeFile(profile.configPath)).toThrow(ClientPathError);
    expect(existsSync(profile.detectDir)).toBe(false);
  }));

  test("allows an OS alias before the configured root", () => fixture((home, root) => {
    const alias = join(home, "home-alias");
    const actual = join(home, "actual-home");
    mkdirSync(actual);
    renameSync(root, join(actual, ".aside"));
    directoryLink(actual, alias);
    const profiles = listAsideProfiles({}, alias);
    const selected = profiles[0]!;
    assertAsideProfileBoundary(selected, profiles, true);
    guardAsideProfileIO(selected, ioFor(home).io, profiles).writeText(selected.configPath, "{}");
    expect(readFileSync(join(actual, ".aside", "u", "0", "models.json"), "utf8")).toBe("{}");
  }));

  for (const component of ["root", "u", "account"] as const) {
    test(`rejects a linked ${component} directory`, () => fixture((home, root) => {
      const profiles = listAsideProfiles({}, home);
      const selected = profiles[0]!;
      const path = component === "root" ? root : component === "u" ? join(root, "u") : selected.detectDir;
      const moved = join(home, `moved-${component}`);
      renameSync(path, moved);
      directoryLink(moved, path);
      expect(() => assertAsideProfileBoundary(selected, profiles)).toThrow(ClientPathError);
    }));
  }

  test("rejects leaf links, including dangling links", () => fixture((home, root) => {
    const profiles = listAsideProfiles({}, home);
    const selected = profiles[0]!;
    const target = join(root, "u", "1", "models.json");
    symlinkSync(target, selected.configPath, "file");
    expect(() => assertAsideProfileBoundary(selected, profiles)).toThrow(ClientPathError);
    expect(() => assertAsideProfileBoundary(profiles[1]!, profiles)).toThrow(ClientPathError);
    writeFileSync(target, "{}");
    expect(() => assertAsideProfileBoundary(selected, profiles)).toThrow(ClientPathError);
    expect(() => assertAsideProfileBoundary(profiles[1]!, profiles)).toThrow(ClientPathError);
  }));

  test("detects sibling directory aliases even when the selected path is safe", () => fixture((home, root) => {
    const profiles = listAsideProfiles({}, home);
    rmSync(profiles[1]!.detectDir, { recursive: true });
    directoryLink(profiles[0]!.detectDir, profiles[1]!.detectDir);
    expect(() => assertAsideProfileBoundary(profiles[0]!, profiles)).toThrow(ClientPathError);
    expect(() => assertAsideProfileBoundary(profiles[0]!)).toThrow(ClientPathError);
    expect(existsSync(join(root, "u", "0", "models.json"))).toBe(false);
  }));

  test("rejects shared leaf inodes independently of ownership stores", () => fixture(home => {
    const profiles = listAsideProfiles({}, home);
    const a = profiles[0]!;
    const b = profiles[1]!;
    writeFileSync(a.configPath, "{}");
    linkSync(a.configPath, b.configPath);
    expect(() => assertAsideProfileBoundary(a, profiles)).toThrow(ClientPathError);
    expect(() => assertAsideProfileBoundary(b, [b])).toThrow(ClientPathError);
  }));

  test("does not permit caller-supplied or sibling IO paths", () => fixture(home => {
    const profiles = listAsideProfiles({}, home);
    const selected = profiles[0]!;
    expect(() => assertAsideProfileBoundary({ ...selected, configPath: profiles[1]!.configPath }, profiles))
      .toThrow(ClientPathError);
    expect(() => assertAsideProfileBoundary(selected, profiles.slice(1))).toThrow(ClientPathError);
    const guarded = guardAsideProfileIO(selected, ioFor(home).io, profiles);
    expect(() => guarded.writeText(profiles[1]!.configPath, "{}")).toThrow(ClientPathError);
    expect(() => guarded.readText(join(selected.detectDir, "settings.json"))).toThrow(ClientPathError);
    expect(() => guarded.mkdirp(selected.root)).toThrow(ClientPathError);
  }));

  for (const component of ["root", "u", "account"] as const) {
    test(`rejects a ${component} inode replacement after guard capture`, () => fixture((home, root) => {
      const profiles = listAsideProfiles({}, home);
      const selected = profiles[0]!;
      const guarded = guardAsideProfileIO(selected, ioFor(home).io, profiles);
      const path = component === "root" ? root : component === "u" ? join(root, "u") : selected.detectDir;
      renameSync(path, join(home, `old-${component}`));
      mkdirSync(selected.detectDir, { recursive: true });
      expect(() => guarded.statKind(selected.detectDir)).toThrow(ClientPathError);
      expect(() => guarded.readText(selected.configPath)).toThrow(ClientPathError);
      expect(() => guarded.mkdirp(selected.detectDir)).toThrow(ClientPathError);
      expect(() => guarded.writeText(selected.configPath, "{}")).toThrow(ClientPathError);
      expect(() => guarded.removeFile(selected.configPath)).toThrow(ClientPathError);
      expect(existsSync(selected.configPath)).toBe(false);
    }));
  }

  test("rechecks leaf collisions immediately before all config mutations", () => fixture(home => {
    const profiles = listAsideProfiles({}, home);
    const selected = profiles[0]!;
    const sibling = profiles[1]!;
    const guarded = guardAsideProfileIO(selected, ioFor(home).io, profiles);
    writeFileSync(selected.configPath, "original");
    symlinkSync(selected.configPath, sibling.configPath, "file");
    expect(() => guarded.writeText(selected.configPath, "changed")).toThrow(ClientPathError);
    expect(() => guarded.removeFile(selected.configPath)).toThrow(ClientPathError);
    expect(() => guarded.mkdirp(selected.detectDir)).toThrow(ClientPathError);
    expect(readFileSync(selected.configPath, "utf8")).toBe("original");
  }));

  test("rejects a selected leaf replaced by a link after guard capture", () => fixture(home => {
    const profiles = listAsideProfiles({}, home);
    const selected = profiles[0]!;
    const guarded = guardAsideProfileIO(selected, ioFor(home).io, profiles);
    writeFileSync(profiles[1]!.configPath, "sibling");
    symlinkSync(profiles[1]!.configPath, selected.configPath, "file");
    expect(() => guarded.readText(selected.configPath)).toThrow(ClientPathError);
    expect(() => guarded.writeText(selected.configPath, "changed")).toThrow(ClientPathError);
    expect(() => guarded.removeFile(selected.configPath)).toThrow(ClientPathError);
    expect(readFileSync(profiles[1]!.configPath, "utf8")).toBe("sibling");
  }));

  test("pins the chosen account across current-account switches and preserves bound IO", () => fixture((home, root) => {
    const profiles = listAsideProfiles({}, home);
    const selected = profiles[1]!;
    const { store, io } = ioFor(home);
    const receiverIO = {
      ...io,
      now() { expect(this).toBe(receiverIO); return 123; },
      writeText(path: string, text: string) { expect(this).toBe(receiverIO); io.writeText(path, text); },
    };
    const guarded = guardAsideProfileIO(selected, receiverIO, profiles);
    manifest(root, { currentAccountId: 2, accounts });
    expect(listAsideProfiles({}, home)[2]!.current).toBe(true);
    guarded.mkdirp(selected.detectDir);
    guarded.writeText(selected.configPath, "first");
    guarded.writeText(selected.configPath, "second");
    expect(guarded.now()).toBe(123);
    expect(readFileSync(selected.configPath, "utf8")).toBe("second");
    expect(existsSync(profiles[2]!.configPath)).toBe(false);
    guarded.appendJournal({
      opId: "fixture-op", clientId: "aside", kind: "apply", at: new Date(123).toISOString(),
      configPath: selected.configPath, snapshot: { kind: "none" }, resultFingerprint: "fixture-hash",
      resultAbsent: false, priorRecord: null,
    });
    expect(store.listOperations()).toHaveLength(1);
    guarded.putRecord({
      clientId: "aside", configPath: selected.configPath, fileFingerprint: "fixture-file",
      blockFingerprint: "fixture-block", fragmentPaths: [], appliedAt: new Date(123).toISOString(), opId: "fixture-op",
    });
    expect(store.readRecords().aside?.configPath).toBe(selected.configPath);
    guarded.dropRecord("aside");
    expect(store.readRecords().aside).toBeUndefined();
    guarded.removeFile(selected.configPath);
    expect(existsSync(selected.configPath)).toBe(false);
  }));
});
