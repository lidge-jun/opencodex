import { expect, test } from "bun:test";
import { buildOrchestratedPlan, type PlanInputs } from "../../src/update/orchestrated-plan";
import { classifyPlanRuntimeOwner, observeOrchestratedPlan, type OrchestratedPlanDeps } from "../../src/update/orchestrated-entry";

const base: PlanInputs = {
  currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "npm", runtimeOwner: "none",
  cliRoot: "/fixture/ocx", identity: { kind: "absent" }, ownershipPermits: true, updateInFlight: false,
};

test("plan decision matrix refuses unsafe installs, unknown identity and unsafe versions", () => {
  const live = { kind: "live", servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } } as const;
  const cases: [Partial<PlanInputs>, string][] = [
    [{ installer: "desktop-app" }, "desktop-app-owned"],
    [{ installer: "source" }, "source-checkout"],
    [{ installer: "mise" }, "mise-managed"],
    [{ installer: "unknown" }, "installer-unknown"],
    [{ identity: { kind: "unknown" } }, "serving-install-unknown"],
    [{ identity: { kind: "mismatch" } }, "cli-not-serving-install"],
    [{ identity: { ...live, servingRoot: "/fixture/other" } }, "cli-not-serving-install"],
    [{ ownershipPermits: false }, "runtime-ownership-refused"],
    [{ runtimeOwner: "unknown" }, "runtime-ownership-refused"],
    [{ targetVersion: null }, "target-unresolved"],
    [{ targetVersion: "1.9.0" }, "downgrade-refused"],
    [{ targetVersion: "2.0.0" }, "up-to-date"],
  ];
  for (const [change, reason] of cases) {
    expect(buildOrchestratedPlan({ ...base, ...change })).toMatchObject({ canApply: false, reason });
  }
  const plan = buildOrchestratedPlan({ ...base, identity: live, runtimeOwner: "service" });
  expect(plan).toMatchObject({ schema: "ocx.update.plan/1", canApply: true, restartRequired: true, servingPath: "/fixture/ocx", updateInFlight: false, mutationBoundMs: 900000 });
  expect(plan.planToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect("reason" in plan).toBe(false);
});

test("observed plans bind the selected registry target, serving identity, owner and in-flight status", async () => {
  const live = { kind: "live" as const, servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } };
  let requested = "";
  const deps: OrchestratedPlanDeps = {
    install: () => ({ installer: "npm", cliRoot: "/fixture/ocx", desktopPath: false }),
    currentVersion: () => "2.0.0",
    identity: async () => live,
    ownership: () => ({ runtimeOwner: "service", permits: true }),
    target: (selector) => { requested = selector; return selector === "2.2.0" ? selector : "2.1.0"; },
    inFlight: () => false,
  };
  const first = await observeOrchestratedPlan({ ok: true, mode: "plan", tag: "preview" }, deps);
  expect(requested).toBe("preview");
  expect(first).toMatchObject({ canApply: true, targetVersion: "2.1.0", runtimeOwner: "service", restartRequired: true, updateInFlight: false });
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan", tag: "preview" }, deps)).planToken).toBe(first.planToken);
  const pinned = await observeOrchestratedPlan({ ok: true, mode: "plan", version: "2.2.0" }, deps);
  expect(requested).toBe("2.2.0");
  expect(pinned.targetVersion).toBe("2.2.0");
  expect(pinned.planToken).not.toBe(first.planToken);
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan", version: "2.2.0" }, { ...deps, target: () => "2.3.0" })).reason).toBe("target-unresolved");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => ({ kind: "unknown" }), inFlight: () => { throw Error("unknown"); } })).updateInFlight).toBe(true);
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => ({ kind: "live", ...live, servingRoot: "/fixture/other" }) })).reason).toBe("cli-not-serving-install");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, ownership: () => ({ runtimeOwner: "unknown", permits: false }) })).reason).toBe("runtime-ownership-refused");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, install: () => ({ installer: "standalone", cliRoot: "/fixture/ocx", desktopPath: true }) })).reason).toBe("desktop-app-owned");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => { throw Error("unavailable"); } })).reason).toBe("plan-unavailable");
});

test("a recorded CLI claim is service ownership only when a service is installed", () => {
  const identity = { kind: "live" as const, servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } };
  const owner = { kind: "owned" as const, revision: 1, ownership: { owner: "cli" as const, installId: "fixture", consentGeneration: 1 } };
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "none" }, false)).toMatchObject({ runtimeOwner: "unmanaged", permits: true });
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "none" }, true)).toMatchObject({ runtimeOwner: "service", permits: true });
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "unknown", reason: "fixture", desktopSeen: false }, true)).toMatchObject({ runtimeOwner: "unknown", permits: false });
});
