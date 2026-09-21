/**
 * Durable runtime ownership in the shared service install state.
 *
 * The behaviour under test is the one the plan calls R4: every install, repair, update and
 * stop path reaches service-state.json through `writeServiceInstallState`, which used to
 * rebuild the whole record and replace the file. Ownership recorded by a desktop takeover
 * therefore lasted until the next repair — from a tray helper, from `ocx update`, from a
 * doctor suggestion — and nothing said it had gone.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";
import {
  desktopOwnsService,
  inspectServiceStateEvidence,
  ownershipGrantedTo,
  parseServiceInstallState,
  parseServiceOwnership,
  readServiceInstallState,
  recordServiceOwner,
  releaseServiceOwner,
  resolveServiceOwnership,
  ServiceStateConflictError,
  serviceOwnership,
  serviceStatePath,
  serviceStatePaths,
  swapServiceInstallState,
  writeServiceInstallState,
} from "../../src/service/state";

let home: TempHome;
/**
 * `serviceStatePaths()` deliberately includes the legacy `~/.opencodex/service-state.json`
 * entry so an install made before OPENCODEX_HOME existed can still be found, and a write
 * lands on BOTH. Under the suite that second path is the shared sandbox home, which outlives
 * this file: a claim recorded here reappeared in `tests/service/service.test.ts` and in the
 * dashboard update worker's tests, where the repair gate and the restart veto then fired on
 * state those files never wrote. This fixture restores every state path it touched.
 */
let statePathSnapshot: { path: string; content: string | null }[] = [];

beforeEach(() => {
  home = createTempHome("ocx-service-ownership-");
  statePathSnapshot = serviceStatePaths().map(path => ({
    path,
    content: existsSync(path) ? readFileSync(path, "utf8") : null,
  }));
});

afterEach(() => {
  for (const { path, content } of statePathSnapshot) {
    if (content === null) { if (existsSync(path)) unlinkSync(path); }
    else writeFileSync(path, content);
  }
  home.remove();
});

const DESKTOP = { owner: "desktop", installId: "app-install-a" } as const;

describe("ownership survives every install-state writer", () => {
  test("a repair over a desktop takeover keeps the owner, the install id and the generation", () => {
    const claimed = recordServiceOwner(DESKTOP);
    expect(claimed).toEqual({ owner: "desktop", installId: "app-install-a", consentGeneration: 1 });

    // What a repair does: rebuild the install provenance and write it.
    writeServiceInstallState("scheduler", null);

    const after = readServiceInstallState();
    expect(after?.ownership).toEqual(claimed);
    // The provenance half really was refreshed, so this is preservation rather than a
    // write that quietly did nothing.
    expect(after?.bunPath).toBeTruthy();
    expect(after?.backend).toBe("scheduler");
    expect(desktopOwnsService()).toBe(true);
  });

  test("a native-backend switch preserves the claim too", () => {
    recordServiceOwner(DESKTOP);
    writeServiceInstallState("native");
    const after = readServiceInstallState();
    expect(after?.backend).toBe("native");
    expect(after?.ownership?.installId).toBe("app-install-a");
  });

  test("the writer that every subsystem calls preserves rather than rebuilds", () => {
    const source = readFileSync(repoPath("src", "service", "state.ts"), "utf8");
    const writer = source.slice(
      source.indexOf("export function writeServiceInstallState("),
      source.indexOf("export function readServiceInstallState("),
    );
    expect(writer).toContain("swapServiceInstallState(");
    expect(writer).toContain("current?.ownership");
  });

  /**
   * The conversion R4 asks for is one function deep because every writer already routes
   * through it. This is what keeps that true: a module that composed the record itself, or
   * reached for the raw swap, would reintroduce the replace-the-file behaviour in a place
   * nobody would think to look.
   */
  test("no service module composes or commits the install record itself", () => {
    for (const file of ["orchestration.ts", "launchd.ts", "systemd.ts", "windows-ops.ts", "windows-scheduler.ts", "repair.ts"]) {
      const source = readFileSync(repoPath("src", "service", file), "utf8");
      expect(source).toContain("writeServiceInstallState");
      expect(source).not.toContain("swapServiceInstallState");
      expect(source).not.toContain("service-state.json");
      expect(source).not.toMatch(/version:\s*2/);
    }
  });
});

describe("consent generation and the comparison rule", () => {
  test("a grant increments once; the same installation relaunching does not", () => {
    expect(recordServiceOwner(DESKTOP).consentGeneration).toBe(1);
    expect(recordServiceOwner(DESKTOP).consentGeneration).toBe(1);
    expect(recordServiceOwner({ owner: "desktop", installId: "app-install-b" }).consentGeneration).toBe(2);
    expect(recordServiceOwner({ owner: "cli", installId: "app-install-b" }).consentGeneration).toBe(3);
  });

  test("a grant belongs to one installation, not to the kind of owner", () => {
    const ownership = recordServiceOwner(DESKTOP);
    expect(ownershipGrantedTo(ownership, "desktop", "app-install-a")).toBe(true);
    // A reinstalled app carries a different id and must ask for consent again.
    expect(ownershipGrantedTo(ownership, "desktop", "app-install-b")).toBe(false);
    expect(ownershipGrantedTo(ownership, "cli", "app-install-a")).toBe(false);
    expect(ownershipGrantedTo(null, "desktop", "app-install-a")).toBe(false);
  });

  test("an install id is required, because an empty one would match nothing and claim everything", () => {
    expect(() => recordServiceOwner({ owner: "desktop", installId: "" })).toThrow(/install id/);
  });

  test("releasing returns the dropped claim and creates no record when there is none", () => {
    expect(releaseServiceOwner()).toBeNull();
    expect(existsSync(serviceStatePath())).toBe(false);

    writeServiceInstallState("scheduler", null);
    recordServiceOwner(DESKTOP);
    expect(releaseServiceOwner()).toEqual({ owner: "desktop", installId: "app-install-a", consentGeneration: 1 });
    expect(serviceOwnership()).toBeNull();
    expect(desktopOwnsService()).toBe(false);
    // The install record itself is untouched: releasing ownership is not an uninstall.
    expect(readServiceInstallState()?.bunPath).toBeTruthy();
  });

  test("claiming with no install state writes no install provenance it cannot vouch for", () => {
    recordServiceOwner(DESKTOP);
    const record = readServiceInstallState();
    expect(record?.ownership?.owner).toBe("desktop");
    expect(record?.bunPath).toBeUndefined();
    expect(record?.launcherPath).toBeUndefined();
  });
});

describe("the compare-and-swap", () => {
  test("a writer that lands inside the commit window is detected and the swap recomputes", () => {
    writeServiceInstallState("scheduler", null);
    const before = readServiceInstallState()?.revision ?? 0;

    const result = swapServiceInstallState(current => ({ ...current!, launcherPath: "/opt/ocx" }), {
      beforeCommit: attempt => {
        // Exactly one interleaved writer, on the first attempt only.
        if (attempt === 0) recordServiceOwner(DESKTOP);
      },
    });

    // Both survive: the late claim because the swap re-read it, the launcher because the
    // swap re-applied its own change to the newer base.
    expect(result?.launcherPath).toBe("/opt/ocx");
    expect(result?.ownership?.installId).toBe("app-install-a");
    expect(readServiceInstallState()).toEqual(result!);
    expect(result!.revision!).toBeGreaterThan(before + 1);
  });

  test("a swap that never wins gives up instead of overwriting the record", () => {
    writeServiceInstallState("scheduler", null);
    let competitors = 0;
    expect(() => swapServiceInstallState(current => ({ ...current!, launcherPath: "/opt/ocx" }), {
      attempts: 3,
      beforeCommit: () => { competitors += 1; recordServiceOwner({ owner: "desktop", installId: "app-" + competitors }); },
    })).toThrow(ServiceStateConflictError);

    expect(competitors).toBe(3);
    // The last competitor's record stands, unmodified by the swap that lost.
    const final = readServiceInstallState();
    expect(final?.ownership?.installId).toBe("app-3");
    expect(final?.launcherPath).toBeUndefined();
  });

  test("every commit bumps the revision", () => {
    writeServiceInstallState("scheduler", null);
    const first = readServiceInstallState()?.revision;
    writeServiceInstallState("scheduler", null);
    expect(readServiceInstallState()?.revision).toBe(first! + 1);
  });

  test("a mutation that returns null writes nothing", () => {
    writeServiceInstallState("scheduler", null);
    const before = readFileSync(serviceStatePath(), "utf8");
    expect(swapServiceInstallState(() => null)?.revision).toBe(readServiceInstallState()?.revision);
    expect(readFileSync(serviceStatePath(), "utf8")).toBe(before);
  });

  /**
   * Unreadable is not absent. Reading a directory is the portable way to produce that
   * answer; a real one is a permission the process does not have. Either way the swap has
   * no base to preserve from, and computing one from an empty record is exactly how an
   * ownership claim would be erased by a writer that was never allowed to see it.
   */
  test("an unreadable record refuses the write instead of erasing what it cannot read", () => {
    const unreadable = home.path("state-as-a-directory");
    mkdirSync(unreadable, { recursive: true });
    expect(() => swapServiceInstallState(() => ({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler",
    }), { paths: [unreadable] })).toThrow(/could not be read/);
  });
});

describe("parsing", () => {
  const valid = { version: 2, codexHome: "/c", opencodexHome: "/o", backend: "scheduler" };

  test("a malformed ownership claim invalidates the record rather than being dropped", () => {
    expect(parseServiceInstallState({ ...valid, ownership: { owner: "desktop", installId: "a", consentGeneration: 1 } })?.ownership?.owner).toBe("desktop");
    expect(parseServiceInstallState({ ...valid, ownership: { owner: "desktop", installId: "a" } })).toBeNull();
    expect(parseServiceInstallState({ ...valid, ownership: { owner: "root", installId: "a", consentGeneration: 1 } })).toBeNull();
    expect(parseServiceInstallState({ ...valid, ownership: { owner: "cli", installId: "", consentGeneration: 1 } })).toBeNull();
    expect(parseServiceInstallState({ ...valid, ownership: { owner: "cli", installId: "a", consentGeneration: -1 } })).toBeNull();
    expect(parseServiceInstallState({ ...valid, ownership: "desktop" })).toBeNull();
  });

  test("the revision must be a non-negative integer, and absent still parses", () => {
    expect(parseServiceInstallState({ ...valid, revision: 0 })?.revision).toBe(0);
    expect(parseServiceInstallState({ ...valid, revision: 1.5 })).toBeNull();
    expect(parseServiceInstallState({ ...valid, revision: -1 })).toBeNull();
    expect(parseServiceInstallState(valid)?.revision).toBeUndefined();
  });

  test("a validated claim is returned as-is so a newer writer's fields survive a preserve", () => {
    const ownership = { owner: "desktop", installId: "a", consentGeneration: 1, grantedBy: "first-launch" };
    expect(parseServiceOwnership(ownership)).toBe(ownership as never);
  });

  test("a record written before this field existed reads as CLI-owned, not unowned-and-free", () => {
    writeFileSync(serviceStatePath(), JSON.stringify({ ...valid, codexHome: home.codexHome, opencodexHome: home.root }));
    expect(serviceOwnership()).toBeNull();
    expect(desktopOwnsService()).toBe(false);
  });
});

describe("the record is read fail-closed", () => {
  test("unreadable at any path is unknown, not unowned", () => {
    const unreadable = home.path("unreadable-state");
    mkdirSync(unreadable, { recursive: true });
    const resolution = resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath(), unreadable]));
    expect(resolution.kind).toBe("unknown");
  });

  test("a corrupt anchor is unknown; corrupt legacy leftovers are ignored", () => {
    writeFileSync(serviceStatePath(), "not json");
    expect(resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath()])).kind).toBe("unknown");

    // The second path is the legacy default-home entry. Junk left there by an old version
    // must not be able to block every repair on the machine.
    recordServiceOwner(DESKTOP);
    const legacy = home.path("legacy-service-state.json");
    writeFileSync(legacy, "{ broken");
    const resolution = resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath(), legacy]));
    expect(resolution).toEqual({ kind: "owned", ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 } });
  });

  test("paths that name different owners are unknown", () => {
    recordServiceOwner(DESKTOP);
    const other = home.path("other-service-state.json");
    const record = JSON.parse(readFileSync(serviceStatePath(), "utf8"));
    writeFileSync(other, JSON.stringify({ ...record, ownership: { ...record.ownership, installId: "app-install-b" } }));
    expect(resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath(), other])).kind).toBe("unknown");
  });

  test("absent everywhere is the only thing that means no claim", () => {
    expect(resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath()]))).toEqual({ kind: "none" });
  });

  /**
   * Pre-existing, and it is why this had to be fixed here: cliEntry() returns null for a
   * standalone binary, so every standalone install wrote a record its own parser rejected.
   * After ownership moved into that record, an unparseable record reads as "nobody owns the
   * runtime" — the exact demotion the claim exists to prevent.
   */
  test("a standalone install record parses, so its ownership is readable at all", () => {
    const standalone = { version: 2, codexHome: "/c", opencodexHome: "/o", bunPath: "/b", cliPath: null, backend: "scheduler" };
    expect(parseServiceInstallState(standalone)).not.toBeNull();
    expect(parseServiceInstallState(JSON.parse(JSON.stringify(standalone)))).not.toBeNull();
    expect(parseServiceInstallState({ ...standalone, cliPath: "" })).toBeNull();
  });
});

describe("the generation cannot be reused", () => {
  test("a release keeps the high-water mark so the next grant does not repeat it", () => {
    expect(recordServiceOwner(DESKTOP).consentGeneration).toBe(1);
    releaseServiceOwner();
    expect(readServiceInstallState()?.consentGenerationCeiling).toBe(1);
    // Without the ceiling this would be 1 again, and an app-local record still holding the
    // first 1 would read the second grant as its own prior consent.
    expect(recordServiceOwner(DESKTOP).consentGeneration).toBe(2);
  });

  test("an ordinary install-state write carries the ceiling forward", () => {
    recordServiceOwner(DESKTOP);
    releaseServiceOwner();
    writeServiceInstallState("scheduler", null);
    expect(readServiceInstallState()?.consentGenerationCeiling).toBe(1);
    expect(recordServiceOwner({ owner: "desktop", installId: "app-install-b" }).consentGeneration).toBe(2);
  });
});

describe("the anchor lock", () => {
  test("a lock another process holds blocks the write rather than racing it", () => {
    writeFileSync(serviceStatePath() + ".lock", "");
    expect(() => swapServiceInstallState(() => ({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler",
    }), { lockWaitMs: 50 })).toThrow(/another process is writing/);
    // Nothing was written: the swap never reached a commit.
    expect(existsSync(serviceStatePath())).toBe(false);
  });

  test("a swap nested inside another one is not a race and does not deadlock", () => {
    writeServiceInstallState("scheduler", null);
    const result = swapServiceInstallState(current => ({ ...current!, launcherPath: "/opt/ocx" }), {
      beforeCommit: attempt => { if (attempt === 0) recordServiceOwner(DESKTOP); },
    });
    expect(result?.ownership?.installId).toBe("app-install-a");
  });

  /**
   * The lock file names its holder. Without that, a holder evicted as stale would delete the
   * REPLACEMENT lock on its way out and hand a third writer the pathname while the second is
   * still inside its critical section.
   */
  test("release removes only the lock instance this holder created", () => {
    const lockPath = serviceStatePath() + ".lock";
    let observed = "";
    writeServiceInstallState("scheduler", null);
    swapServiceInstallState(current => {
      observed = readFileSync(lockPath, "utf8").trim();
      // Stand in for an eviction: the pathname now belongs to somebody else.
      writeFileSync(lockPath, "a-different-holder\n");
      return { ...current! };
    });
    expect(observed).not.toBe("");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("a-different-holder");
    unlinkSync(lockPath);
  });
});

describe("the record is replaced as a unit", () => {
  /**
   * An in-place write truncates first, so an interrupted commit used to leave the anchor empty
   * or half-serialized. Since the reader became fail-closed that reads as `unknown`, which
   * blocks start, repair, restart and every update until the operator runs a takeover install.
   */
  test("a commit leaves no staging file behind and the record stays parseable", () => {
    writeServiceInstallState("scheduler", null);
    recordServiceOwner(DESKTOP);
    const leftovers = readdirSync(home.root).filter(name => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readServiceInstallState()?.ownership?.installId).toBe("app-install-a");
  });

  test("the write path stages and renames rather than truncating the record in place", () => {
    const source = readFileSync(repoPath("src", "service", "state.ts"), "utf8");
    const commit = source.slice(
      source.indexOf("function commitServiceStateFile("),
      source.indexOf("export function swapServiceInstallState("),
    );
    expect(commit).toContain("renameSync(staged, path)");
    // Hardened BEFORE the rename: between rename and chmod the record would be readable
    // at the default mode.
    expect(commit.indexOf("hardenSecretPath(staged")).toBeLessThan(commit.indexOf("renameSync(staged, path)"));
  });
});

describe("a claim recorded under the lock is never overwritten by an older one", () => {
  /**
   * `writeServiceInstallState` used to resolve ownership BEFORE the swap took the lock. A
   * takeover landing in between reached `current`, passed the revision check untouched, and
   * was then overwritten by the older claim the resolution had captured — a lost update the
   * compare-and-swap cannot see, because the stale value never came from the base record.
   */
  test("the resolution is read inside the swap, not before it", () => {
    const source = readFileSync(repoPath("src", "service", "state.ts"), "utf8");
    const writer = source.slice(
      source.indexOf("export function writeServiceInstallState("),
      source.indexOf("function preservedConsent("),
    );
    expect(writer).toContain("preservedConsent(current, resolveServiceOwnership())");
    expect(writer).not.toMatch(/const resolution = resolveServiceOwnership\(\);/);
  });

  test("a higher generation wins, and an equal generation keeps the anchor", () => {
    recordServiceOwner(DESKTOP);
    recordServiceOwner({ owner: "desktop", installId: "app-install-b" });
    const before = readServiceInstallState();
    expect(before?.ownership?.installId).toBe("app-install-b");
    expect(before?.ownership?.consentGeneration).toBe(2);

    // An ordinary install-state refresh must not demote it to the earlier grant.
    writeServiceInstallState("scheduler", null);
    const after = readServiceInstallState();
    expect(after?.ownership?.installId).toBe("app-install-b");
    expect(after?.ownership?.consentGeneration).toBe(2);
  });
});
