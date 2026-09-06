import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGEMENT_ROUTES } from "../src/server/management/route-registry";
import { READ_SURFACE_DIFF_MATRIX, READ_SURFACE_DIFF_MATRIX_OWNER_DOC } from "../src/server/management/read-surface-ownership";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = (method: string, path: string) => method + " " + path;

describe("read-surface differential matrix (ticket #25)", () => {
  test("gives every management read route exactly one Go transition verdict", () => {
    const reads = MANAGEMENT_ROUTES.filter(route => !route.mutates);
    const matrixKeys = READ_SURFACE_DIFF_MATRIX.map(row => key(row.method, row.path));
    expect(new Set(matrixKeys).size).toBe(matrixKeys.length);
    expect(new Set(matrixKeys)).toEqual(new Set(reads.map(route => key(route.method, route.path))));
    expect(READ_SURFACE_DIFF_MATRIX).toHaveLength(reads.length);
  });

  test("keeps each verdict attached to its registry owner and state source", () => {
    for (const row of READ_SURFACE_DIFF_MATRIX) {
      const route = MANAGEMENT_ROUTES.find(candidate => candidate.method === row.method && candidate.path === row.path);
      expect(route, key(row.method, row.path) + " is absent from the registry").toBeDefined();
      expect(route!.mutates).toBe(false);
      expect(route!.module).toBe(row.module);
      expect(row.stateSources.length, key(row.method, row.path)).toBeGreaterThan(0);
      if (row.transition === "go-now") {
        expect(route!.go, key(row.method, row.path) + " must carry the Go marker").toBeDefined();
        expect(row.parityFixture).toBe("default-get");
        expect(row.rationale).toBeUndefined();
      } else {
        expect(route!.go, key(row.method, row.path) + " cannot be both deferred and Go-owned").toBeUndefined();
        expect(row.rationale?.trim().length, key(row.method, row.path)).toBeGreaterThanOrEqual(40);
        expect(row.parityFixture).toBeUndefined();
      }
    }
  });

  test("the Go marker and go-now matrix verdicts are a bidirectional set", () => {
    const matrixGoNow = READ_SURFACE_DIFF_MATRIX.filter(row => row.transition === "go-now").map(row => key(row.method, row.path)).sort();
    const registryGoReads = MANAGEMENT_ROUTES.filter(route => !route.mutates && route.go).map(route => key(route.method, route.path)).sort();
    expect(matrixGoNow).toEqual(registryGoReads);
    // This count makes adding a new pre-flip Go-owned read deliberate; the
    // bidirectional set assertion above still proves the count cannot mask a
    // route-registry/matrix disagreement. Ticket #20 adds /api/usage.
    expect(matrixGoNow).toHaveLength(17);
  });

  test("records runtime-flip evidence in tracked repository documentation", () => {
    expect(existsSync(join(repoRoot, READ_SURFACE_DIFF_MATRIX_OWNER_DOC))).toBe(true);
  });
});
