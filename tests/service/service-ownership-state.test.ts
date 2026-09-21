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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  removeServiceInstallStateRecords,
  resolveServiceOwnership,
  resolveServiceState,
  ServiceOwnershipSubjectMismatchError,
  ServiceTakeoverCompatibilityChangedError,
  ServiceStateConflictError,
  serviceOwnership,
  serviceStatePath,
  serviceStatePaths,
  swapServiceInstallState,
  writeServiceInstallState,
  type RecordServiceOwnerDeps,
  type ServiceOwner,
  type ServiceStateSwapDeps,
} from "../../src/service/state";
import { assessServiceTakeoverCompatibility, type ManagingCliObservation } from "../../src/service/ownership-compatibility";

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
const COMPATIBLE_MANAGERS: Readonly<Record<"service-registration" | "path", ManagingCliObservation>> = {
  "service-registration": { status: "absent" },
  path: { status: "observed", version: "2.61.0", identity: "path-manager-a" },
};

function grantServiceOwner(
  claim: { owner: ServiceOwner; installId: string },
  deps: ServiceStateSwapDeps & Pick<Partial<RecordServiceOwnerDeps>, "observeManagers"> = {},
) {
  const request = approvedOwnerRequest(claim);
  const { observeManagers = () => COMPATIBLE_MANAGERS, ...swapDeps } = deps;
  return recordServiceOwner(request, { ...swapDeps, observeManagers });
}

function approvedOwnerRequest(
  claim: { owner: ServiceOwner; installId: string },
  managers = COMPATIBLE_MANAGERS,
) {
  const expectedSubject = resolveServiceOwnership();
  if (expectedSubject.kind === "unknown") throw new Error(expectedSubject.reason);
  const resolved = resolveServiceState();
  if (resolved.kind === "unknown") throw new Error(resolved.reason);
  const expectedCompatibility = assessServiceTakeoverCompatibility({
    state: resolved.kind === "state" ? resolved.state : null,
    subject: expectedSubject,
    managers,
  });
  if (expectedCompatibility.kind !== "supported") throw new Error(expectedCompatibility.detail);
  return { ...claim, expectedSubject, expectedCompatibility };
}

function releaseCurrentOwner(deps: ServiceStateSwapDeps = {}) {
  const expected = resolveServiceOwnership();
  if (expected.kind === "unknown") throw new Error(expected.reason);
  return releaseServiceOwner(expected, deps);
}

describe("ownership survives every install-state writer", () => {
  test("a repair over a desktop takeover keeps the owner, the install id and the generation", () => {
    const claimed = grantServiceOwner(DESKTOP);
    expect(claimed.ownership).toEqual({ owner: "desktop", installId: "app-install-a", consentGeneration: 1 });

    // What a repair does: rebuild the install provenance and write it.
    writeServiceInstallState("scheduler", null);

    const after = readServiceInstallState();
    expect(after?.ownership).toEqual(claimed.ownership);
    // The provenance half really was refreshed, so this is preservation rather than a
    // write that quietly did nothing.
    expect(after?.bunPath).toBeTruthy();
    expect(after?.backend).toBe("scheduler");
    expect(after?.ownershipProtocolVersion).toBe(1);
    expect(desktopOwnsService()).toBe(true);
  });

  test("a native-backend switch preserves the claim too", () => {
    grantServiceOwner(DESKTOP);
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
    expect(grantServiceOwner(DESKTOP).ownership.consentGeneration).toBe(1);
    expect(grantServiceOwner(DESKTOP).ownership.consentGeneration).toBe(1);
    expect(grantServiceOwner({ owner: "desktop", installId: "app-install-b" }).ownership.consentGeneration).toBe(2);
    expect(grantServiceOwner({ owner: "cli", installId: "app-install-b" }).ownership.consentGeneration).toBe(3);
  });

  test("a grant belongs to one installation, not to the kind of owner", () => {
    const ownership = grantServiceOwner(DESKTOP).ownership;
    expect(ownershipGrantedTo(ownership, "desktop", "app-install-a")).toBe(true);
    // A reinstalled app carries a different id and must ask for consent again.
    expect(ownershipGrantedTo(ownership, "desktop", "app-install-b")).toBe(false);
    expect(ownershipGrantedTo(ownership, "cli", "app-install-a")).toBe(false);
    expect(ownershipGrantedTo(null, "desktop", "app-install-a")).toBe(false);
  });

  test("an install id is required, because an empty one would match nothing and claim everything", () => {
    expect(() => grantServiceOwner({ owner: "desktop", installId: "" })).toThrow(/install id/);
  });

  test("releasing returns the dropped claim and creates no record when there is none", () => {
    expect(releaseCurrentOwner()).toBeNull();
    expect(existsSync(serviceStatePath())).toBe(false);

    writeServiceInstallState("scheduler", null);
    grantServiceOwner(DESKTOP);
    expect(releaseCurrentOwner()).toEqual({ owner: "desktop", installId: "app-install-a", consentGeneration: 1 });
    expect(serviceOwnership()).toBeNull();
    expect(desktopOwnsService()).toBe(false);
    // The install record itself is untouched: releasing ownership is not an uninstall.
    expect(readServiceInstallState()?.bunPath).toBeTruthy();
  });

  test("claiming with no install state writes no install provenance it cannot vouch for", () => {
    grantServiceOwner(DESKTOP);
    const record = readServiceInstallState();
    expect(record?.ownership?.owner).toBe("desktop");
    expect(record?.bunPath).toBeUndefined();
    expect(record?.launcherPath).toBeUndefined();
  });
});

describe("the compare-and-swap", () => {
  test("a revocation that lands while a provenance writer waits is not resurrected", () => {
    grantServiceOwner(DESKTOP);
    let revoked = false;
    writeServiceInstallState("scheduler", null, {
      beforeCommit: attempt => {
        if (attempt === 0 && !revoked) {
          revoked = true;
          releaseCurrentOwner();
        }
      },
    });
    expect(readServiceInstallState()?.ownership).toBeUndefined();
    expect(readServiceInstallState()?.consentGenerationCeiling).toBe(1);
  });

  test("authority commit survives a mirror failure and the next writer repairs the mirror", () => {
    const mirror = home.path("active", "service-state.json");
    const authority = home.path("default", "service-state.json");
    mkdirSync(home.path("active"), { recursive: true });
    mkdirSync(home.path("default"), { recursive: true });
    const initial = {
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler",
      revision: 1, ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 },
      consentGenerationCeiling: 1,
    } as const;
    const bytes = `${JSON.stringify(initial, null, 2)}\n`;
    writeFileSync(mirror, bytes);
    writeFileSync(authority, bytes);
    const degraded: string[] = [];
    releaseServiceOwner({ kind: "owned", ownership: initial.ownership, revision: 1 }, {
      paths: [mirror, authority],
      commitStateFile: (path, serialized, validate) => {
        validate();
        if (path === mirror) throw new Error("mirror unavailable");
        writeFileSync(path, serialized);
      },
      onMirrorError: path => degraded.push(path),
    });
    expect(degraded).toEqual([mirror]);
    expect(resolveServiceOwnership(inspectServiceStateEvidence([mirror, authority])))
      .toEqual({ kind: "none", revision: 2 });
    expect(JSON.parse(readFileSync(mirror, "utf8")).ownership.installId).toBe("app-install-a");

    writeServiceInstallState("scheduler", null, { paths: [mirror, authority] });
    expect(readFileSync(mirror, "utf8")).toBe(readFileSync(authority, "utf8"));
    expect(resolveServiceOwnership(inspectServiceStateEvidence([mirror, authority])).kind).toBe("none");
  });

  test("an authority publication failure leaves both prior records unchanged", () => {
    const mirror = home.path("active-state.json");
    const authority = home.path("authority-state.json");
    const initial = JSON.stringify({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler", revision: 4,
    });
    writeFileSync(mirror, initial);
    writeFileSync(authority, initial);
    expect(() => swapServiceInstallState(current => ({ ...current!, launcherPath: "/next/ocx" }), {
      paths: [mirror, authority],
      commitStateFile: () => { throw new Error("rename refused"); },
    })).toThrow(/rename refused/);
    expect(readFileSync(mirror, "utf8")).toBe(initial);
    expect(readFileSync(authority, "utf8")).toBe(initial);
  });

  test("a mirror deletion failure keeps the authority, so a revoked claim cannot migrate back", () => {
    const mirror = home.path("active-delete.json");
    const authority = home.path("authority-delete.json");
    writeFileSync(mirror, JSON.stringify({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler", revision: 4,
      ownership: { owner: "desktop", installId: "revoked", consentGeneration: 1 },
    }));
    writeFileSync(authority, JSON.stringify({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler", revision: 5,
      consentGenerationCeiling: 1,
    }));
    expect(() => removeServiceInstallStateRecords({
      paths: [mirror, authority],
      unlink: path => {
        if (path === mirror) throw new Error("mirror delete refused");
        unlinkSync(path);
      },
    })).toThrow(/mirror delete refused/);
    expect(existsSync(authority)).toBe(true);
    expect(resolveServiceOwnership(inspectServiceStateEvidence([mirror, authority])))
      .toEqual({ kind: "none", revision: 5 });
  });

  test("a writer that lands inside the commit window is detected and the swap recomputes", () => {
    writeServiceInstallState("scheduler", null);
    const before = readServiceInstallState()?.revision ?? 0;

    const result = swapServiceInstallState(current => ({ ...current!, launcherPath: "/opt/ocx" }), {
      beforeCommit: attempt => {
        // Exactly one interleaved writer, on the first attempt only.
        if (attempt === 0) grantServiceOwner(DESKTOP);
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
      beforeCommit: () => { competitors += 1; grantServiceOwner({ owner: "desktop", installId: "app-" + competitors }); },
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

  test("exhausted revision refuses before publishing an unreadable successor", () => {
    writeFileSync(serviceStatePath(), JSON.stringify({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root,
      backend: "scheduler", revision: Number.MAX_SAFE_INTEGER,
    }));
    const before = readFileSync(serviceStatePath(), "utf8");
    expect(() => swapServiceInstallState(current => ({ ...current!, launcherPath: "/next/ocx" })))
      .toThrow(/revision is exhausted/);
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

describe("the consented subject is a precondition", () => {
  test("a delayed service-install release cannot delete a successor claim", () => {
    const first = grantServiceOwner(DESKTOP);
    const successor = grantServiceOwner({ owner: "desktop", installId: "app-install-b" });
    expect(() => releaseServiceOwner(first, { allowRevisionAdvance: true }))
      .toThrow(ServiceOwnershipSubjectMismatchError);
    expect(resolveServiceOwnership()).toEqual(successor);
  });

  test("a revocation during the internal retry invalidates the approval", () => {
    grantServiceOwner(DESKTOP);
    const request = approvedOwnerRequest({ owner: "desktop", installId: "app-install-b" });
    let revoked = false;
    expect(() => recordServiceOwner(request, {
      observeManagers: () => COMPATIBLE_MANAGERS,
      beforeCommit: attempt => {
        if (attempt === 0 && !revoked) {
          revoked = true;
          releaseCurrentOwner();
        }
      },
    })).toThrow(ServiceOwnershipSubjectMismatchError);
    expect(resolveServiceOwnership().kind).toBe("none");
  });

  test("a revision-only change requires fresh approval even when the owner is unchanged", () => {
    writeServiceInstallState("scheduler", null);
    const request = approvedOwnerRequest(DESKTOP);
    let changed = false;
    expect(() => recordServiceOwner(request, {
      observeManagers: () => COMPATIBLE_MANAGERS,
      beforeCommit: attempt => {
        if (attempt === 0 && !changed) {
          changed = true;
          writeServiceInstallState("scheduler", null);
        }
      },
    })).toThrow(ServiceOwnershipSubjectMismatchError);
    expect(readServiceInstallState()?.ownership).toBeUndefined();
  });

  test("managing CLI compatibility is re-observed immediately before the grant", () => {
    const request = approvedOwnerRequest(DESKTOP);
    expect(() => recordServiceOwner(request, {
      observeManagers: () => ({
        "service-registration": { status: "absent" },
        path: { status: "observed", version: "2.60.0", identity: "path-manager-old" },
      }),
    })).toThrow(ServiceTakeoverCompatibilityChangedError);
    expect(readServiceInstallState()?.ownership).toBeUndefined();
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
    expect(parseServiceInstallState({ ...valid, revision: Number.MAX_SAFE_INTEGER })).not.toBeNull();
    expect(parseServiceInstallState({
      ...valid,
      ownership: { owner: "desktop", installId: "a", consentGeneration: Number.MAX_SAFE_INTEGER },
    })).not.toBeNull();
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
    unlinkSync(serviceStatePath());

    // The second path is the legacy default-home entry. Junk left there by an old version
    // must not be able to block every repair on the machine.
    grantServiceOwner(DESKTOP);
    const legacy = home.path("legacy-service-state.json");
    writeFileSync(legacy, "{ broken");
    const resolution = resolveServiceOwnership(inspectServiceStateEvidence([legacy, serviceStatePath()]));
    expect(resolution).toEqual({
      kind: "owned",
      ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 },
      revision: expect.any(Number),
    });
  });

  test("paths that name different owners are unknown", () => {
    grantServiceOwner(DESKTOP);
    const other = home.path("other-service-state.json");
    const record = JSON.parse(readFileSync(serviceStatePath(), "utf8"));
    writeFileSync(other, JSON.stringify({ ...record, ownership: { ...record.ownership, installId: "app-install-b" } }));
    expect(resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath(), other])).kind).toBe("unknown");
  });

  test("absent everywhere is the only thing that means no claim", () => {
    expect(resolveServiceOwnership(inspectServiceStateEvidence([serviceStatePath()])))
      .toEqual({ kind: "none", revision: 0 });
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
    expect(grantServiceOwner(DESKTOP).ownership.consentGeneration).toBe(1);
    releaseCurrentOwner();
    expect(readServiceInstallState()?.consentGenerationCeiling).toBe(1);
    // Without the ceiling this would be 1 again, and an app-local record still holding the
    // first 1 would read the second grant as its own prior consent.
    expect(grantServiceOwner(DESKTOP).ownership.consentGeneration).toBe(2);
  });

  test("an ordinary install-state write carries the ceiling forward", () => {
    grantServiceOwner(DESKTOP);
    releaseCurrentOwner();
    writeServiceInstallState("scheduler", null);
    expect(readServiceInstallState()?.consentGenerationCeiling).toBe(1);
    expect(grantServiceOwner({ owner: "desktop", installId: "app-install-b" }).ownership.consentGeneration).toBe(2);
  });
});

describe("the anchor lock", () => {
  test("a live update lease blocks ownership mutation before the state lock is touched", () => {
    const leasePath = serviceStatePath() + ".mutation.lock";
    const processInstance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mkdirSync(leasePath, { recursive: true });
    writeFileSync(`${leasePath}/v1-777-${processInstance}-${token}.json`, JSON.stringify({
      version: 1, pid: 777, processInstance, token, createdAt: 1,
    }));
    expect(() => writeServiceInstallState("scheduler", null, {
      paths: [serviceStatePath()],
      mutationLease: { waitMs: 0, now: () => 1_000_000, processAlive: () => true },
    })).toThrow(/runtime mutation lease/);
    expect(existsSync(serviceStatePath())).toBe(false);
  });

  test("a crashed incomplete update lease is reclaimed only after the stale grace", () => {
    const leasePath = serviceStatePath() + ".mutation.lock";
    mkdirSync(leasePath, { recursive: true });
    writeServiceInstallState("scheduler", null, {
      paths: [serviceStatePath()],
      mutationLease: {
        waitMs: 0,
        now: () => Date.now() + 60_000,
        processAlive: () => false,
      },
    });
    expect(readServiceInstallState()?.backend).toBe("scheduler");
  });

  test("age never evicts a holder whose PID is still alive", () => {
    const lockPath = serviceStatePath() + ".lock";
    const processInstance = "11111111-1111-4111-8111-111111111111";
    const token = "22222222-2222-4222-8222-222222222222";
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(`${lockPath}/v1-777-${processInstance}-${token}.json`, JSON.stringify({
      version: 1, pid: 777, processInstance, token, createdAt: 1,
    }));
    expect(() => swapServiceInstallState(() => ({
      version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler",
    }), {
      paths: [serviceStatePath()],
      lockWaitMs: 0,
      lockHooks: { now: () => 1_000_000, processAlive: () => true },
    })).toThrow(/another process owns/);
    // Nothing was written: the swap never reached a commit.
    expect(existsSync(serviceStatePath())).toBe(false);
  });

  test("a late release cannot remove a successor lock", () => {
    const statePath = serviceStatePath();
    const lockPath = `${statePath}.lock`;
    const successorInstance = "33333333-3333-4333-8333-333333333333";
    const successorToken = "44444444-4444-4444-8444-444444444444";
    swapServiceInstallState(current => ({
      ...(current ?? { version: 2, codexHome: home.codexHome, opencodexHome: home.root, backend: "scheduler" }),
      launcherPath: "/opt/ocx",
    }), {
      paths: [statePath],
      lockHooks: {
        beforeRelease: () => {
          for (const entry of readdirSync(lockPath)) unlinkSync(`${lockPath}/${entry}`);
          rmSync(lockPath, { recursive: true });
          mkdirSync(lockPath, { recursive: true });
          writeFileSync(`${lockPath}/v1-888-${successorInstance}-${successorToken}.json`, JSON.stringify({
            version: 1, pid: 888, processInstance: successorInstance, token: successorToken, createdAt: 2,
          }));
        },
      },
    });
    expect(existsSync(`${lockPath}/v1-888-${successorInstance}-${successorToken}.json`)).toBe(true);
  });

});
