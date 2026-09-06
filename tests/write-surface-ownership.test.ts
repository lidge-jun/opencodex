import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGEMENT_ROUTES } from "../src/server/management/route-registry";
import {
  WRITE_SURFACE_DEFERRAL_OWNER_DOC,
  WRITE_SURFACE_DEFERRED_FAMILIES,
} from "../src/server/management/write-ownership";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const key = (method: string, path: string) => `${method} ${path}`;

/**
 * Write-ownership verdict completeness (ticket #26, seam 1 — devlog 035).
 *
 * Every mutating management route must carry exactly one ownership verdict:
 * a `go` marker (Go-owned), an `exempt` reason (CLI-parity vocabulary), or a
 * deferred row in WRITE_SURFACE_DEFERRED_FAMILIES. The first two are already
 * policed elsewhere; this suite polices the third so the mutating surface has
 * no silent-plain state — a route with neither marker and no ledger row is
 * unarguable, which is precisely how a mutation could later bypass its guard.
 */
describe("every mutating route carries a write-ownership verdict", () => {
  test("the deferred ledger exactly covers the mutating routes with neither a go marker nor an exemption", () => {
    const plain = MANAGEMENT_ROUTES.filter(r => r.mutates && !r.go && !r.exempt);
    expect(plain.length).toBeGreaterThan(0);

    const ledgerRoutes = WRITE_SURFACE_DEFERRED_FAMILIES.flatMap(family =>
      family.routes.map(r => ({ module: family.module, method: r.method, path: r.path })),
    );
    expect(ledgerRoutes.length).toBe(plain.length);

    const ledgerKeys = new Set(ledgerRoutes.map(r => key(r.method, r.path)));
    expect(ledgerKeys.size).toBe(ledgerRoutes.length); // no duplicate ledger rows
    for (const route of plain) {
      expect(ledgerKeys.has(key(route.method, route.path)), `no verdict row for ${key(route.method, route.path)}`).toBe(true);
    }
  });

  test("every ledger row names a real mutating route with neither marker (no ghosts, no mislabeled reads)", () => {
    for (const family of WRITE_SURFACE_DEFERRED_FAMILIES) {
      for (const route of family.routes) {
        const match = MANAGEMENT_ROUTES.find(r =>
          r.method === route.method && r.path === route.path,
        );
        expect(match, `${key(route.method, route.path)} is not a declared management route`).toBeDefined();
        expect(match!.module).toBe(family.module); // verdict lives under the owning module
        expect(match!.mutates).toBe(true);
        expect(match!.go).toBeUndefined(); // a go marker must drop its ledger row
        expect(match!.exempt).toBeUndefined(); // an exemption must drop its ledger row
      }
    }
  });

  test("every deferred family names its owning module and records a non-trivial reason", () => {
    const thin = WRITE_SURFACE_DEFERRED_FAMILIES
      .filter(f => f.why.trim().length < 40)
      .map(f => f.module);
    expect(thin).toEqual([]);
    for (const family of WRITE_SURFACE_DEFERRED_FAMILIES) {
      expect(family.module.length).toBeGreaterThan(0);
      expect(family.routes.length).toBeGreaterThan(0);
    }
  });

  test("the deferral owner doc is a TRACKED repository file (same rule as deferred-verb exemptions)", () => {
    // The doc is deliberately a repository file rather than the goalplan, which is
    // gitignored -- a test reading machine-local state would pass here and find
    // nothing in CI.
    expect(existsSync(join(repoRoot, WRITE_SURFACE_DEFERRAL_OWNER_DOC))).toBe(true);
  });
});
