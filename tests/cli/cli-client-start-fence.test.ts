import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { startClientRuntimeUnderOwnershipLease } from "../../src/cli/client-start-fence";
import { recoverStartStateUnderOwnershipLease } from "../../src/cli/start-owner-fence";
import { serviceChildOwnershipDecisionForClassifiedChild } from "../../src/service/service-child-ownership";
import type { ServiceOwnershipResolution } from "../../src/service/state";

class StayOut extends Error {}

describe("connected-client start ownership fence", () => {
  test("a desktop claim committed at recovery lease acquisition skips sibling marking and journal reconciliation", async () => {
    let ownership: ServiceOwnershipResolution = { kind: "none", revision: 0 };
    expect(serviceChildOwnershipDecisionForClassifiedChild(true, () => ownership)).toEqual({ kind: "proceed" });
    const events: string[] = [];
    await expect(recoverStartStateUnderOwnershipLease({
      supervised: true,
      acquireLease: () => {
        ownership = { kind: "owned", ownership: { owner: "desktop", installId: "app", consentGeneration: 1 }, revision: 1 };
        events.push("lease");
        return { release: () => { events.push("release"); } };
      },
      decide: () => serviceChildOwnershipDecisionForClassifiedChild(true, () => ownership),
      stayOut: refusal => { events.push("stay-out"); throw new StayOut(refusal); },
      recover: async () => { events.push("sibling-mark", "journal-reconcile"); return false; },
    })).rejects.toThrow(/desktop app owns the runtime/);
    expect(events).toEqual(["lease", "release", "stay-out"]);
  });

  test("ordinary starts recover without taking the service lease", async () => {
    const events: string[] = [];
    expect(await recoverStartStateUnderOwnershipLease({
      supervised: false,
      acquireLease: () => { throw new Error("ordinary start must not acquire the service lease"); },
      decide: () => { throw new Error("ordinary start must not inspect service ownership"); },
      stayOut: () => { throw new Error("ordinary start must not stay out"); },
      recover: async () => { events.push("recover"); return true; },
    })).toBe(true);
    expect(events).toEqual(["recover"]);
  });

  test("supervised recovery holds the lease through the shared mutation", async () => {
    const events: string[] = [];
    expect(await recoverStartStateUnderOwnershipLease({
      supervised: true,
      acquireLease: () => { events.push("lease"); return { release: () => { events.push("release"); } }; },
      decide: () => { events.push("owner-check"); return { kind: "proceed" }; },
      stayOut: () => { throw new Error("must not stay out"); },
      recover: async () => { events.push("sibling-mark", "journal-reconcile"); return false; },
    })).toBe(false);
    expect(events).toEqual(["lease", "owner-check", "sibling-mark", "journal-reconcile", "release"]);
  });

  test("handleStart fences recovery before either startup branch", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const start = cli.slice(cli.indexOf("async function handleStart("), cli.indexOf("function detachedStartEnvironment("));
    const fence = start.indexOf("recoverStartStateUnderOwnershipLease(");
    expect(fence).toBeGreaterThan(start.indexOf("probeOwnerPastRestartParent("));
    expect(fence).toBeLessThan(start.indexOf("markCrossHomeSibling()"));
    expect(fence).toBeLessThan(start.indexOf("removePidIfValueIs(owner.pidSnapshot)"));
    expect(fence).toBeLessThan(start.indexOf("reconcileStartupJournal()"));
    expect(fence).toBeLessThan(start.indexOf('if (clientState.kind === "connected")'));
    expect(fence).toBeLessThan(start.indexOf("bindAndPublishStartOwnership("));
    expect(start.slice(fence, start.indexOf('if (clientState.kind === "connected")')))
      .toContain("serviceChildOwnershipDecisionForClassifiedChild(supervisedServiceChild)");
  });

  test("a desktop claim committed at lease acquisition never reaches startClientRuntime", async () => {
    let ownership: ServiceOwnershipResolution = { kind: "none", revision: 0 };
    const resolve = () => ownership;
    // The early check before the lease still passes.
    expect(serviceChildOwnershipDecisionForClassifiedChild(true, resolve)).toEqual({ kind: "proceed" });
    const events: string[] = [];
    await expect(startClientRuntimeUnderOwnershipLease({
      acquireLease: () => {
        ownership = { kind: "owned", ownership: { owner: "desktop", installId: "app", consentGeneration: 1 }, revision: 1 };
        events.push("lease");
        return { release: () => { events.push("release"); } };
      },
      decide: () => serviceChildOwnershipDecisionForClassifiedChild(true, resolve),
      stayOut: refusal => { events.push("stay-out"); throw new StayOut(refusal); },
      start: async () => { events.push("client-runtime"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
    expect(events).toEqual(["lease", "release", "stay-out"]);
  });

  test("a proceeding start holds the lease until the runtime publishes, then releases once", async () => {
    const events: string[] = [];
    await startClientRuntimeUnderOwnershipLease({
      acquireLease: () => ({ release: () => { events.push("release"); } }),
      decide: () => ({ kind: "proceed" }),
      stayOut: () => { throw new Error("must not refuse"); },
      start: async afterPublish => {
        events.push("bind", "pid", "runtime");
        afterPublish();
        events.push("serving");
      },
    });
    expect(events).toEqual(["bind", "pid", "runtime", "release", "serving"]);
  });

  test("a start that throws before publishing still releases the lease", async () => {
    const events: string[] = [];
    await expect(startClientRuntimeUnderOwnershipLease({
      acquireLease: () => ({ release: () => { events.push("release"); } }),
      decide: () => ({ kind: "proceed" }),
      stayOut: () => { throw new Error("must not refuse"); },
      start: async () => { throw new Error("bind failed"); },
    })).rejects.toThrow("bind failed");
    expect(events).toEqual(["release"]);
  });

  test("handleStart routes the connected-client branch through the fence and the runtime releases after publication", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const branch = cli.slice(cli.indexOf('if (clientState.kind === "connected") {'));
    const fence = branch.indexOf("startClientRuntimeUnderOwnershipLease(");
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(branch.indexOf("startClientRuntime({"));
    expect(branch.slice(fence, branch.indexOf("return;"))).toContain("serviceChildOwnershipDecisionForClassifiedChild(supervisedServiceChild)");
    const runtime = readFileSync(repoPath("src/client/runtime.ts"), "utf8");
    expect(runtime).toMatch(/writeRuntimePort\(clientRuntimeRecord\(process\.pid, boundPort\)\);\s*\n\s*options\.afterPublish\?\.\(\);/);
  });
});
