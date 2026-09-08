import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationIO } from "../../src/integrations/config-io";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Capture real delegates before spying. Only fixture inode values are controlled;
// existence, file type, link count, realpath and link resolution remain native.
const nativeLstat = fs.lstatSync;
const nativeStat = fs.statSync;
const FIRST_INODE = 2n ** 53n;
const SECOND_INODE = FIRST_INODE + 1n;

test("Aside preserves high file identities without admitting shared targets or directory replacement", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "ocx-aside-identity-"));
  const root = join(home, ".aside");
  const paths = [0, 1].map(id => join(root, "u", String(id), "models.json"));
  const identities = new Map<string, bigint>();
  const reads = new Set<string>();
  let observingBoundary = false;
  const restoreSpies: Array<() => void> = [];

  function controlledStat(delegate: typeof fs.statSync, kind: "stat" | "lstat"): typeof fs.statSync {
    // Preserve fs's overload contract: the native delegate determines the result
    // type, including undefined for throwIfNoEntry:false and number vs bigint.
    return ((path: fs.PathLike, options?: fs.StatOptions) => {
      const stats = delegate(path, options);
      const inode = typeof path === "string" ? identities.get(path) : undefined;
      if (stats && inode !== undefined) {
        if (observingBoundary) reads.add(`${kind}:${path}`);
        // Mutate this fresh native result, retaining its prototype and method
        // receiver. Spreading Stats would lose native isFile/isDirectory methods.
        stats.ino = options?.bigint ? inode : Number(inode);
      }
      return stats;
    }) as typeof fs.statSync;
  }

  function observe<T>(run: () => T): T {
    reads.clear();
    observingBoundary = true;
    try { return run(); } finally { observingBoundary = false; }
  }

  try {
    for (const id of [0, 1]) fs.mkdirSync(join(root, "u", String(id)), { recursive: true });
    fs.writeFileSync(join(root, "accounts.json"), JSON.stringify({
      currentAccountId: 0, accounts: [{ id: 0 }, { id: 1 }],
    }));
    for (const path of paths) fs.writeFileSync(path, "{}");
    // Controlled IDs must not hide a runtime lacking native BigInt stat support.
    expect(typeof nativeStat(paths[0]!, { bigint: true }).ino).toBe("bigint");
    expect(typeof nativeLstat(paths[0]!, { bigint: true }).ino).toBe("bigint");
    const lstatSpy = spyOn(fs, "lstatSync");
    restoreSpies.push(() => lstatSpy.mockRestore());
    lstatSpy.mockImplementation(controlledStat(nativeLstat, "lstat"));
    const statSpy = spyOn(fs, "statSync");
    restoreSpies.push(() => statSpy.mockRestore());
    statSpy.mockImplementation(controlledStat(nativeStat, "stat"));

    // Load after spies so the regression also covers the native named-import seam.
    const { assertAsideProfileBoundary, guardAsideProfileIO, listAsideProfiles } =
      await import("../../src/clients/aside-profiles");
    const [selected, peer] = listAsideProfiles({}, home);
    if (!selected || !peer) throw new Error("fixture requires two profiles");
    const profiles = [selected, peer];
    expect(Number(FIRST_INODE)).toBe(Number(SECOND_INODE));
    expect(FIRST_INODE).not.toBe(SECOND_INODE);
    expect(nativeStat(selected.configPath, { bigint: true }).dev)
      .toBe(nativeStat(peer.configPath, { bigint: true }).dev);
    // Distinct catalogs and directories are allowed even though their Number
    // representations collide.
    // Reads are recorded only DURING boundary calls, so a missed spy binding
    // cannot silently turn this into a passing ordinary-filesystem test.
    for (const target of ["configPath", "detectDir"] as const) {
      identities.clear();
      identities.set(selected[target], FIRST_INODE);
      identities.set(peer[target], SECOND_INODE);
      for (const profile of profiles) {
        const sibling = profile === selected ? peer : selected;
        observe(() => expect(() => assertAsideProfileBoundary(profile, profiles, true)).not.toThrow());
        expect(reads.has(`lstat:${profile[target]}`)).toBe(true);
        expect(reads.has(`stat:${sibling[target]}`)).toBe(true);
      }
    }

    identities.clear();
    identities.set(selected.detectDir, FIRST_INODE);
    let delegatedReads = 0;
    const io: IntegrationIO = {
      readText: () => { delegatedReads++; return { kind: "text", text: "{}" }; },
      statKind: () => "file",
      writeText: () => {}, removeFile: () => {}, mkdirp: () => {},
      now: () => 0, appendJournal: () => {}, putRecord: () => {}, dropRecord: () => {},
    };
    const guarded = observe(() => guardAsideProfileIO(selected, io, profiles));
    expect(reads.has(`lstat:${selected.detectDir}`)).toBe(true);
    observe(() => expect(guarded.readText(selected.configPath)).toEqual({ kind: "text", text: "{}" }));
    expect(reads.has(`lstat:${selected.detectDir}`)).toBe(true);
    expect(delegatedReads).toBe(1);
    identities.set(selected.detectDir, SECOND_INODE);
    observe(() => expect(() => guarded.readText(selected.configPath))
      .toThrow("the account directory changed after the operation began."));
    expect(reads.has(`lstat:${selected.detectDir}`)).toBe(true);
    expect(delegatedReads).toBe(1);

    // No synthetic IDs for these controls: real hardlinks and symlinks must
    // continue to be refused by the same boundary, with native stat delegates.
    identities.clear();
    fs.unlinkSync(peer.configPath);
    fs.linkSync(selected.configPath, peer.configPath);
    expect(nativeLstat(selected.configPath, { bigint: true }).nlink).toBe(2n);
    for (const profile of profiles) {
      expect(() => assertAsideProfileBoundary(profile, profiles, true))
        .toThrow("the model catalog is a link, shared file or non-regular file.");
    }
    fs.unlinkSync(peer.configPath);
    fs.symlinkSync(selected.configPath, peer.configPath, "file");
    expect(nativeLstat(peer.configPath, { bigint: true }).isSymbolicLink()).toBe(true);
    expect(() => assertAsideProfileBoundary(selected, profiles, true))
      .toThrow("account catalogs share a target.");
    expect(() => assertAsideProfileBoundary(peer, profiles, true))
      .toThrow("the model catalog is a link, shared file or non-regular file.");
  } finally {
    observingBoundary = false;
    identities.clear();
    reads.clear();
    for (const restore of restoreSpies.reverse()) restore();
    removeTreeWithRetry(home);
  }
});
