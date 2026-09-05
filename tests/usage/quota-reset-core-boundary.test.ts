import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  firstLoadTimePathTo,
  repoRoot,
  resolvedImportEdges,
  runtimeImportEdges,
  slashed,
} from "../helpers/import-graph";

/**
 * Quota-reset detection is an optional subsystem, so it must stay off the core path.
 *
 * AGENTS.md states that obligation for optional subsystems generally, but
 * tests/core-lab-boundary.test.ts hardcodes "/src/lab/" -- so nothing enforced it for
 * src/quota/. The gap is not theoretical here. Both quota seams
 * (src/codex/quota.ts, src/providers/quota.ts) are statically reachable from
 * src/server/responses/core.ts, so one static import in either puts the detector, its
 * claim store, and -- through src/quota/reset-notify-config.ts, which pulls the ../config
 * barrel -- a large module graph onto the request path of a user who never enabled
 * notifications. The Lab regression AGENTS.md documents reached ~69 modules through a
 * six-hop chain where no single file looked wrong, and it was caught only after shipping.
 *
 * The walker lives in tests/helpers/import-graph.ts and is SHARED with the Lab guard
 * rather than copied. That guard records why: its own self-test once re-declared a private
 * copy of the matcher, so it proved a local literal behaved rather than that the guard did.
 */
const PROTECTED = [
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
  "src/server/management-api.ts",
] as const;

/** The two quota subsystems that observe a committed snapshot. */
const SEAMS = ["src/codex/quota.ts", "src/providers/quota.ts"] as const;

const OBSERVER_SPEC = "../quota/reset-observer";

/**
 * The whole directory is the boundary, not just the reset-* prefix.
 *
 * src/quota/ holds this subsystem and nothing else, so a core file reaching any part of it
 * is the defect. A prefix match would have let src/quota/window-mapping.ts onto the core
 * path unnoticed, and every future sibling would inherit that hole by default.
 */
function isQuotaModule(absoluteSlashedPath: string): boolean {
  return absoluteSlashedPath.includes("/src/quota/");
}

describe("core / quota-reset boundary", () => {
  test.each(PROTECTED)("%s reaches no src/quota module at load time", file => {
    const chain = firstLoadTimePathTo(file, isQuotaModule);
    // Print the whole chain: a bare verdict would send the next maintainer on the same
    // multi-hop hunt the Lab decoupling unit required.
    expect(chain === null ? "clean" : chain.join(" -> ")).toBe("clean");
  });

  test.each(SEAMS)("%s names the observer only through a dynamic import", seam => {
    const quotaEdges = resolvedImportEdges(seam).filter(
      edge => edge.resolved !== null && isQuotaModule(slashed(edge.resolved)),
    );

    // Assert the seam DOES reach the observer before asserting how. A guard that passes
    // because the wiring is absent is worthless: delete the observer call and detection
    // stops silently while a reachability-only assertion stays green.
    expect(quotaEdges.map(edge => edge.spec)).toContain(OBSERVER_SPEC);
    expect(quotaEdges.filter(edge => !edge.dynamic).map(edge => edge.spec)).toEqual([]);
  });
});

/**
 * The composition root may know the subsystem exists -- src/server/index.ts is exempt from
 * the Lab guard for the same reason. What is not free is what that edge drags in, so the
 * exemption is pinned to an exact shape rather than left open.
 */
describe("the poller edge from the composition root stays cheap", () => {
  test("the only load-time path runs through background-lifecycle to the poller", () => {
    const chain = firstLoadTimePathTo("src/server/index.ts", isQuotaModule);
    expect(chain?.join(" -> ")).toBe(
      "src/server/index.ts -> src/server/background-lifecycle.ts -> src/quota/reset-poller.ts",
    );
  });

  test("the poller pulls in nothing at load time", () => {
    // This keeps the exemption honest. The poller resolves its config gate, the provider
    // quota refresh, and its shutdown hook through import() inside the callee, so the
    // static edge above costs exactly one small module. A static import added here would
    // reach ../config -- a 154-module barrel -- from every install that starts a server,
    // which is the cost this boundary exists to prevent.
    const staticEdges = resolvedImportEdges("src/quota/reset-poller.ts").filter(
      edge => !edge.dynamic,
    );
    expect(staticEdges.map(edge => edge.spec)).toEqual([]);
  });
});

/**
 * A guard nobody attacks is a guard nobody can trust.
 *
 * These synthesize each import form inside a real protected directory and assert the walker
 * sees it, so the guard cannot silently regress into matching only the shapes that happen
 * to exist today. Each case was driven red before being committed green.
 */
describe("the quota boundary guard cannot be defeated", () => {
  // Load-time edges: the graph walk must follow all three.
  const attacks: Array<[string, string]> = [
    ["static import", 'import { observeQuotaSnapshot } from "../quota/reset-observer";'],
    ["side-effect import", 'import "../quota/reset-observer";'],
    ["runtime re-export", 'export { observeQuotaSnapshot } from "../quota/reset-observer";'],
  ];

  test.each(attacks)("detects a %s reaching src/quota", (_label, line) => {
    // The probe sits next to a protected file so its relative specifier resolves exactly as
    // a real violation would. A probe in a scratch directory would only prove the walker
    // handles a path shape that no violation can actually have.
    const probe = join(
      repoRoot,
      "src",
      "server",
      "__quota_boundary_probe_" + Math.random().toString(36).slice(2) + ".ts",
    );
    writeFileSync(probe, line + "\nexport const probe = 1;\n");
    try {
      const chain = firstLoadTimePathTo(
        slashed(probe.slice(repoRoot.length + 1)),
        isQuotaModule,
      );
      expect(chain).not.toBeNull();
      expect(chain!.join(" -> ")).toContain("src/quota/reset-observer.ts");
    } finally {
      rmSync(probe, { force: true });
    }
  });

  test("a dynamic import is a deferred edge and does not propagate the walk", () => {
    // This is the behavior the seams rely on, so it is pinned rather than assumed. If the
    // walker ever followed import(), both seams would report as violations and the honest
    // fix would look like deleting the guard.
    const probe = join(
      repoRoot,
      "src",
      "server",
      "__quota_boundary_probe_dyn_" + Math.random().toString(36).slice(2) + ".ts",
    );
    writeFileSync(
      probe,
      'void import("../quota/reset-observer");' + "\nexport const probe = 1;\n",
    );
    try {
      expect(
        firstLoadTimePathTo(slashed(probe.slice(repoRoot.length + 1)), isQuotaModule),
      ).toBeNull();
    } finally {
      rmSync(probe, { force: true });
    }
  });

  test("an import type edge is erased and is not a runtime edge", () => {
    const edges = runtimeImportEdges(
      'import type { QuotaResetEvent } from "../quota/reset-detector";' + "\n",
    );
    expect(edges).toEqual([]);
  });

  test("the seam assertion fails when the observer wiring is removed", () => {
    // Guard on the guard: proves the dynamic-only assertion is not vacuously satisfiable by
    // a seam that names the observer nowhere at all.
    const edges = runtimeImportEdges("export const nothing = 1;\n");
    expect(edges.map(edge => edge.spec)).not.toContain(OBSERVER_SPEC);
  });
});
