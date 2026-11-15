import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestratedPlan, type PlanInputs } from "../../src/update/orchestrated-plan";
import { classifyOrchestratedOutcome } from "../../src/update/orchestrated-outcome.mjs";
import { decideOrchestratedApply } from "../../src/update/orchestrated-admission.mjs";
import { classifyChildUpdatePlan, mapUpdateApplyExit, parseChildUpdatePlan, parseChildUpdateResult, UPDATE_OUTPUT_MAX_BYTES,
  type ChildUpdatePlan } from "../../src/link/child-update-contract";
import { classifyUpdatePlanProbe } from "../../src/link/child-gated-ocx";
import { repoPath } from "../helpers/repo-root";

const live = { kind: "live" as const, servingRoot: "/opt/ocx", runtime: { pid: 42, port: 10531, hostname: "127.0.0.1", command: ["/opt/ocx/ocx"] } };
const base: PlanInputs = { currentVersion: "2.97.0", targetVersion: "2.100.0", installer: "bun", runtimeOwner: "service", cliRoot: "/opt/ocx",
  identity: live, ownershipPermits: true, updateInFlight: false };
const ctx = { homeVersion: "2.100.0", desktopUpdateRequest: false, entry: "binary" as const };
const roundTrip = (value: unknown) => JSON.stringify(value);
function parsedPlan(value: unknown): ChildUpdatePlan {
  const parsed = parseChildUpdatePlan(roundTrip(value));
  if (!parsed.ok) throw new Error("plan did not parse: " + parsed.reason);
  return parsed.value;
}

describe("oracle: every plan buildOrchestratedPlan can emit parses", () => {
  const cases: Array<[string, Partial<PlanInputs>, Record<string, unknown>]> = [
    ["desktop-app-owned", { installer: "desktop-app" }, { installKind: "desktop-app", updateRoute: "owner-action", updateReason: "desktop-app-owned" }],
    ["source-checkout", { installer: "source" }, { installKind: "source", updateRoute: "owner-action", updateReason: "source-checkout" }],
    ["mise-managed", { installer: "mise" }, { installKind: "mise", updateRoute: "owner-action", updateReason: "mise-managed" }],
    ["installer-unknown", { installer: "unknown" }, { installKind: "unknown", updateRoute: "owner-action", updateReason: "installer-unknown" }],
    ["serving-install-unknown", { identity: { kind: "unknown" } }, { installKind: "bun", updateRoute: "none", updateReason: "refused:serving-install-unknown" }],
    ["cli-not-serving-install", { identity: { kind: "mismatch" } }, { installKind: "bun", updateRoute: "none", updateReason: "refused:cli-not-serving-install" }],
    ["runtime-ownership-refused", { ownershipPermits: false }, { installKind: "bun", updateRoute: "none", updateReason: "refused:runtime-ownership-refused" }],
    ["target-unresolved", { targetVersion: null }, { installKind: "bun", updateRoute: "none", updateReason: "refused:target-unresolved", targetVersion: null }],
    ["downgrade-refused", { targetVersion: "2.96.0" }, { installKind: "bun", updateRoute: "none", updateReason: "refused:downgrade-refused" }],
    ["up-to-date", { targetVersion: "2.97.0" }, { installKind: "bun", updateRoute: "none", updateReason: "up-to-date" }],
    ["canApply", {}, { installKind: "bun", updateRoute: "orchestrated", updateReason: null, installedVersion: "2.97.0", targetVersion: "2.100.0", runtimeOwner: "service" }],
  ];
  test.each(cases)("%s", (reason, overrides, expected) => {
    const plan = buildOrchestratedPlan({ ...base, ...overrides });
    expect(reason === "canApply" ? plan.canApply : plan.reason).toBe(reason === "canApply" ? true : reason as never);
    const parsed = parsedPlan(plan);
    expect(classifyChildUpdatePlan(parsed, ctx)).toMatchObject({ ...expected, planToken: plan.planToken, updateInFlight: false, mutationBoundMs: 900_000 });
  });

  test("plan-unavailable override and unknown current version", () => {
    const plan = { ...buildOrchestratedPlan({ ...base, currentVersion: "unknown", installer: "unknown" }), canApply: false, reason: "plan-unavailable" as const };
    expect(classifyChildUpdatePlan(parsedPlan(plan), ctx)).toMatchObject({ installKind: "unknown", updateRoute: "none", updateReason: "refused:plan-unavailable", installedVersion: null });
  });

  test("desktop request route and in-flight passthrough", () => {
    const plan = parsedPlan(buildOrchestratedPlan({ ...base, installer: "desktop-app", updateInFlight: true }));
    expect(classifyChildUpdatePlan(plan, { ...ctx, desktopUpdateRequest: true })).toMatchObject({ updateRoute: "desktop-request", updateInFlight: true });
  });

  test("a GOAT-managed install is owner-action goat", () => {
    const plan = parsedPlan(buildOrchestratedPlan({ ...base, installer: "unknown", cliRoot: "/home/u/.local/share/goat/opencodex/current" }));
    expect(classifyChildUpdatePlan(plan, ctx)).toMatchObject({ installKind: "goat", updateRoute: "owner-action", updateReason: "goat" });
    const windows = parsedPlan(buildOrchestratedPlan({ ...base, installer: "unknown", cliRoot: "C:\\Users\\u\\.local\\share\\goat\\opencodex\\current" }));
    expect(classifyChildUpdatePlan(windows, ctx)).toMatchObject({ installKind: "goat" });
  });

  test("target mismatch and launcher-bypassed rows", () => {
    expect(classifyChildUpdatePlan(parsedPlan(buildOrchestratedPlan({ ...base, targetVersion: "2.99.0" })), ctx)).toMatchObject({ updateRoute: "none", updateReason: "target-mismatch" });
    const npm = parsedPlan(buildOrchestratedPlan({ ...base, installer: "npm" }));
    expect(classifyChildUpdatePlan(npm, { ...ctx, entry: "pair" })).toMatchObject({ installKind: "npm", updateRoute: "owner-action", updateReason: "launcher-bypassed" });
    expect(classifyChildUpdatePlan(npm, ctx)).toMatchObject({ installKind: "npm", updateRoute: "orchestrated", updateReason: null });
    const bun = parsedPlan(buildOrchestratedPlan(base));
    expect(classifyChildUpdatePlan(bun, { ...ctx, entry: "pair" })).toMatchObject({ updateRoute: "orchestrated" });
  });

  test("A4 launcher rows for an npm or pnpm pair", () => {
    for (const installer of ["npm", "pnpm"] as const) {
      const plan = parsedPlan(buildOrchestratedPlan({ ...base, installer }));
      expect(classifyChildUpdatePlan(plan, { ...ctx, entry: "pair", launcher: "available" })).toMatchObject({ installKind: installer, updateRoute: "orchestrated", updateReason: null });
      expect(classifyChildUpdatePlan(plan, { ...ctx, entry: "pair", launcher: "unavailable" })).toMatchObject({ installKind: installer, updateRoute: "owner-action", updateReason: "launcher-node-missing" });
      expect(classifyChildUpdatePlan(plan, { ...ctx, entry: "pair", launcher: null })).toMatchObject({ installKind: installer, updateRoute: "owner-action", updateReason: "launcher-bypassed" });
    }
    // installer bun ignores the launcher report: it plans and applies on the served Bun entry.
    const bun = parsedPlan(buildOrchestratedPlan(base));
    expect(classifyChildUpdatePlan(bun, { ...ctx, entry: "pair", launcher: "unavailable" })).toMatchObject({ installKind: "bun", updateRoute: "orchestrated", updateReason: null });
  });

  test("the plan probe passes the launcher report into the classifier", () => {
    const plan = buildOrchestratedPlan({ ...base, installer: "npm" });
    const probe = (launcher: string) => classifyUpdatePlanProbe({ code: 0, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(plan) + "\n",
      stderr: "ocx-fanout:selected:2.97.0\nocx-fanout:entry:pair\n" + launcher }, { homeVersion: "2.100.0", desktopUpdateRequest: false });
    expect(probe("ocx-fanout:launcher:available\n")).toMatchObject({ kind: "plan", classification: { updateRoute: "orchestrated" } });
    expect(probe("ocx-fanout:launcher:unavailable\n")).toMatchObject({ kind: "plan", classification: { updateRoute: "owner-action", updateReason: "launcher-node-missing" } });
    expect(probe("ocx-fanout:launcher:exec\n")).toMatchObject({ kind: "plan", classification: { updateRoute: "owner-action", updateReason: "launcher-bypassed" } });
    expect(probe("")).toMatchObject({ kind: "plan", classification: { updateReason: "launcher-bypassed" } });
  });
});

describe("oracle: every result shape parses and maps", () => {
  const outcome = { fromVersion: "2.97.0", toVersion: "2.100.0", installer: "bun", childExited: true, childExitCode: 0,
    outcome: { phase: "installed", activeRoot: "/opt/ocx" }, previousVerified: true, targetVerified: true, runtimeHealthy: true, restarted: true };
  const mapped = (value: { exitCode: number; result: unknown }) => mapUpdateApplyExit(value.exitCode, roundTrip(value.result));
  test("exit 0 applied", () => {
    const value = classifyOrchestratedOutcome(outcome);
    expect(value.exitCode).toBe(0);
    expect(parseChildUpdateResult(roundTrip(value.result)).ok).toBe(true);
    expect(mapped(value)).toEqual({ state: "succeeded", reason: null, fromVersion: "2.97.0", toVersion: "2.100.0", suppressTarget: false, reobserve: false });
  });
  test("exit 11 rolled back and not", () => {
    const rolled = classifyOrchestratedOutcome({ ...outcome, childExitCode: 1, outcome: { phase: "failed", error: "install-failed", rollbackPerformed: true } });
    expect(rolled.exitCode).toBe(11);
    expect(mapped(rolled)).toEqual({ state: "failed", reason: "rolled-back", suppressTarget: true, reobserve: false });
    const plain = classifyOrchestratedOutcome({ ...outcome, childExitCode: 1, outcome: { phase: "preflight" } });
    expect(plain.exitCode).toBe(11);
    expect(mapped(plain)).toEqual({ state: "failed", reason: "update-failed", suppressTarget: true, reobserve: false });
  });
  test("exit 12", () => {
    const value = classifyOrchestratedOutcome({ ...outcome, childExited: false });
    expect(value.exitCode).toBe(12);
    expect(mapped(value)).toEqual({ state: "uncertain", reason: "outcome-unverified", suppressTarget: false, reobserve: true });
  });
  test("admission refusals and up-to-date", () => {
    const plan = buildOrchestratedPlan(base);
    const done = (planValue: unknown, request: object, now = 0) => {
      const decision = decideOrchestratedApply(planValue, request, now);
      if (decision.kind !== "done") throw new Error("expected a decision");
      return decision;
    };
    expect(mapped(done(plan, { expectPlan: "AAAAAAAAAAAAAAAAAAAA" }))).toEqual({ state: "refused", reason: "plan-changed", suppressTarget: false, reobserve: false });
    expect(mapped(done(plan, { notAfter: 1 }, 2))).toEqual({ state: "refused", reason: "deadline-passed", suppressTarget: false, reobserve: false });
    expect(mapped(done({ ...plan, updateInFlight: true }, {}))).toEqual({ state: "busy", reason: "update-in-flight", suppressTarget: false, reobserve: false });
    expect(mapped(done(buildOrchestratedPlan({ ...base, targetVersion: "2.97.0" }), {}))).toEqual({ state: "up-to-date", reason: null, fromVersion: "2.97.0", toVersion: "2.97.0", suppressTarget: false, reobserve: false });
    const unknownFrom = done({ ...buildOrchestratedPlan({ ...base, currentVersion: "unknown", installer: "unknown" }), canApply: false, reason: "plan-unavailable" }, {});
    expect(parseChildUpdateResult(roundTrip(unknownFrom.result)).ok).toBe(true);
    expect(mapped(unknownFrom)).toEqual({ state: "refused", reason: "plan-unavailable", suppressTarget: false, reobserve: false });
  });
  test("exit mapping edges", () => {
    expect(mapUpdateApplyExit(0, "not json")).toEqual({ state: "uncertain", reason: "contract-output-invalid", suppressTarget: false, reobserve: true });
    expect(mapUpdateApplyExit(10, "not json")).toEqual({ state: "refused", reason: "contract-output-invalid", suppressTarget: false, reobserve: false });
    expect(mapUpdateApplyExit(11, "not json")).toEqual({ state: "failed", reason: "update-failed", suppressTarget: true, reobserve: false });
    expect(mapUpdateApplyExit(12, "not json")).toEqual({ state: "uncertain", reason: "outcome-unverified", suppressTarget: false, reobserve: true });
    expect(mapUpdateApplyExit(64, "{\"error\":\"usage\"}")).toEqual({ state: "refused", reason: "contract-usage", suppressTarget: false, reobserve: false });
    expect(mapUpdateApplyExit(3, "")).toEqual({ state: "uncertain", reason: "unexpected-exit", suppressTarget: false, reobserve: true });
  });
});

describe("strictness", () => {
  const plan = buildOrchestratedPlan(base) as Record<string, unknown>;
  const result = classifyOrchestratedOutcome({ fromVersion: "2.97.0", toVersion: "2.100.0", installer: "bun", childExited: false }).result as Record<string, unknown>;
  const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  test.each([
    ["extra key", roundTrip({ ...plan, extra: 1 }), "contract-output-invalid"],
    ["missing key", roundTrip(without(plan, "cliPath")), "contract-output-invalid"],
    ["future schema", roundTrip({ ...plan, schema: "ocx.update.plan/2" }), "contract-unknown"],
    ["oversized payload", " ".repeat(UPDATE_OUTPUT_MAX_BYTES + 1), "contract-output-too-large"],
    ["two JSON lines", roundTrip(plan) + "\n" + roundTrip(plan), "contract-output-invalid"],
    ["canApply with a reason", roundTrip({ ...plan, reason: "up-to-date" }), "contract-output-invalid"],
    ["canApply with installer mise", roundTrip({ ...plan, installer: "mise" }), "contract-output-invalid"],
    ["canApply without a target", roundTrip({ ...plan, targetVersion: null }), "contract-output-invalid"],
    ["bad token", roundTrip({ ...plan, planToken: "bad token" }), "contract-output-invalid"],
    ["unknown installer", roundTrip({ ...plan, installer: "brew" }), "contract-output-invalid"],
    ["bound out of range", roundTrip({ ...plan, mutationBoundMs: 3_600_001 }), "contract-output-invalid"],
    ["path with NUL", roundTrip({ ...plan, cliPath: "/opt/\u0000x" }), "contract-output-invalid"],
    ["an array", "[]", "contract-output-invalid"],
  ])("plan: %s", (_name, payload, reason) => {
    expect(parseChildUpdatePlan(payload)).toEqual({ ok: false, reason: reason as never });
  });
  test("the original plan parses", () => {
    expect(parseChildUpdatePlan(roundTrip(plan)).ok).toBe(true);
  });
  test.each([
    ["error with spaces", roundTrip({ ...result, error: "rm -rf /" }), "contract-output-invalid"],
    ["future schema", roundTrip({ ...result, schema: "ocx.update.result/2" }), "contract-unknown"],
    ["extra key", roundTrip({ ...result, more: true }), "contract-output-invalid"],
    ["missing key", roundTrip(without(result, "healthy")), "contract-output-invalid"],
  ])("result: %s", (_name, payload, reason) => {
    expect(parseChildUpdateResult(payload)).toEqual({ ok: false, reason: reason as never });
  });
});

describe("real CLI plan and usage", () => {
  const run = (args: string[]) => {
    const home = mkdtempSync(join(tmpdir(), "ocx-child-contract-"));
    try {
      const proc = Bun.spawnSync([process.execPath, repoPath("src", "cli", "index.ts"), ...args], {
        env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), PATH: process.env.PATH ?? "" },
        stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      return { code: proc.exitCode, stdout: proc.stdout.toString() };
    } finally { rmSync(home, { recursive: true, force: true }); }
  };
  test("update --plan --json parses and classifies as source-checkout", () => {
    const { code, stdout } = run(["update", "--plan", "--json"]);
    expect(code).toBe(0);
    const parsed = parseChildUpdatePlan(stdout.trim());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.installer).toBe("source");
    expect(classifyChildUpdatePlan(parsed.value, ctx)).toMatchObject({ updateRoute: "owner-action", updateReason: "source-checkout", installKind: "source" });
    const probe = classifyUpdatePlanProbe({ code: 0, stdout: "ocx-fanout:stdout-begin\n" + stdout, stderr: "ocx-fanout:selected:" + parsed.value.currentVersion + "\nocx-fanout:entry:pair\n" }, { homeVersion: "2.100.0", desktopUpdateRequest: false });
    expect(probe).toMatchObject({ kind: "plan", classification: { updateRoute: "owner-action", updateReason: "source-checkout" } });
  }, 30_000);
  test("update --plan without --json is a usage refusal", () => {
    const { code, stdout } = run(["update", "--plan"]);
    expect(code).toBe(64);
    expect(mapUpdateApplyExit(64, stdout.trim())).toMatchObject({ state: "refused", reason: "contract-usage" });
    expect(classifyUpdatePlanProbe({ code: 64, stdout: "ocx-fanout:stdout-begin\n" + stdout, stderr: "ocx-fanout:selected:2.100.0\n" }, { homeVersion: "2.100.0", desktopUpdateRequest: false }))
      .toEqual({ kind: "failed", reason: "contract-usage" });
  }, 30_000);
});

