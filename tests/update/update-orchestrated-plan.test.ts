import { expect, test } from "bun:test";
import { buildOrchestratedPlan, type PlanInputs } from "../../src/update/orchestrated-plan";

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
