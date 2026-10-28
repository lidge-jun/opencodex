// Scanner/inventory cases are best-effort known-pattern lint, not a security
// boundary or completeness proof. The runtime cases exercise the authority guard.
import { afterAll, expect, test } from "bun:test";
import { lintTest, openUpdateLintParser } from "../helpers/update-lint-parser";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy } from "../../src/update/service-home-policy.mjs";
import { files, rawMutationViolations, updateModuleFiles } from "../helpers/update-mutation-scanner";
import { helperControlInventory } from "../helpers/update-helper-inventory";
import { helperControlContracts } from "../helpers/update-helper-control-contracts";

const api = openUpdateLintParser();
const lint = lintTest(api);
afterAll(() => api?.close());
lint("known-pattern lint finds no unclassified update primitive references", () => {
  const scanFiles = ["bin/ocx.mjs", ...updateModuleFiles()];
  const snapshot = api!.updateSnapshot({openFiles:scanFiles.map(f=>repoPath(f))});
  const failures: string[]=[];
  try { for (const file of scanFiles) {
    const source=snapshot.getDefaultProjectForFile(repoPath(file))!.program.getSourceFile(repoPath(file))!;
    failures.push(...rawMutationViolations(source,file).map(f=>file+": "+f));
  }} finally {snapshot.dispose();}
  expect(scanFiles.length).toBeGreaterThan(35); expect(failures).toEqual([]);
});

test("one refused mutation closes every later kind despite home re-matching", () => {
  for (const throws of [false, true]) {
    let home: "same" | "unknown" = "same", broken = false;
    const policy = createUpdateServiceHomePolicy(() => { if (broken && throws) throw new Error("fixture probe"); return { kind: home }; }, () => {});
    expect(policy.authorizeMutation("tray")).toBe(true);
    home = "unknown"; broken = true;
    expect(policy.authorizeMutation("shim")).toBe(false);
    home = "same"; broken = false;
    for (const kind of ["runtime", "service", "tray", "shim", "package", "publish", "package-publish"] as const) expect(policy.authorizeMutation(kind)).toBe(false);
    expect(policy.authorizeMutation("own-child")).toBe(true); expect(policy.authorizeMutation("own-tray")).toBe(true);
  }
});

test("confirmed service disappearance skips service control while retaining foreground and package-only contracts", () => {
  let kind: "same" | "absent" = "same";
  const policy = createUpdateServiceHomePolicy(() => ({ kind }), () => {});
  kind = "absent";
  expect(policy.authorizeMutation("service")).toBe(false);
  expect(policy.authorizeMutation("runtime")).toBe(true); expect(policy.authorizeMutation("publish")).toBe(true);
  const restricted = createUpdateServiceHomePolicy(() => ({ kind: "unknown" }), () => {});
  expect(restricted.authorizeMutation("package")).toBe(true); expect(restricted.authorizeMutation("package-publish")).toBe(true);
  expect(restricted.authorizeMutation("runtime")).toBe(false); expect(restricted.authorizeMutation("package-publish")).toBe(false);
});

lint("known-pattern helper inventory has explicit control-site contracts", () => {
  const { helpers, sites, policyViolations } = helperControlInventory(api!);
  expect(policyViolations).toEqual([]);
  const matched = new Set<number>();
  for (const [file, context, prefix, count, contract] of helperControlContracts) {
    const indices = sites.flatMap((site, index) => site.file === file && site.context === context && site.call.startsWith(prefix) ? [index] : []);
    expect(indices.length, `${file}:${context}: ${prefix} (${contract})`).toBe(count);
    for (const index of indices) { expect(matched.has(index)).toBe(false); matched.add(index); }
  }
  expect(sites.filter((_, index) => !matched.has(index))).toEqual([]);
  expect(helpers.length).toBeGreaterThan(30);
  expect(files).toContain("src/update/job-windows-restart.ts");
  if (process.env.OCX_TEST_UPDATE_GUARD_TABLE === "1") console.log(JSON.stringify({ helpers, helperSites: sites }, null, 2));
});
