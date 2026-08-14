import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const FORBIDDEN_RUNTIME_MODULES = [
  "/src/lab/",
  "/src/lib/lab-live-route-production.ts",
  "/src/routing/compatibility/assemble.ts",
  "/src/server/management/lab-routes.ts",
  "/src/server/management/lab-automation-routes.ts",
  "/src/server/management/routing-profile-routes.ts",
] as const;

function loadedModules(entry: string): string[] {
  const script = `
    require(${JSON.stringify(`./${entry}`)});
    const loaded = Object.keys(require.cache).map((value) => value.replaceAll("\\\\", "/"));
    process.stdout.write("__OCX_MODULES__" + JSON.stringify(loaded));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  expect(result.status, result.stderr).toBe(0);
  const marker = "__OCX_MODULES__";
  const markerIndex = result.stdout.lastIndexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(markerIndex + marker.length)) as string[];
}

function expectCoreEntryIsolated(entry: string): void {
  const loaded = loadedModules(entry);
  const forbidden = loaded.filter((modulePath) =>
    FORBIDDEN_RUNTIME_MODULES.some((fragment) => modulePath.includes(fragment))
  );
  expect(forbidden).toEqual([]);
}

describe("Compatibility Lab core isolation", () => {
  test("ordinary Responses import graph does not load Lab runtime modules", () => {
    expectCoreEntryIsolated("src/server/responses/core.ts");
  });

  test("router import graph does not load compatibility assembly", () => {
    expectCoreEntryIsolated("src/router.ts");
  });

  test("server startup and lifecycle import graphs do not load Lab runtime modules", () => {
    expectCoreEntryIsolated("src/server/index.ts");
    expectCoreEntryIsolated("src/server/lifecycle.ts");
  });

  test("management API import graph keeps Lab and routing-profile handlers on demand", () => {
    expectCoreEntryIsolated("src/server/management-api.ts");
  });
});
