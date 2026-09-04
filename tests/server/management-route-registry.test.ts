import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import { scanRoutes, distinctRoutes } from "../helpers/management-route-scan";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

/**
 * Reconciles the declared route registry against source, in three directions.
 *
 * Why three, and why none of them is sufficient alone -- stated here because the
 * original plan for this gate specified ONE mechanism that could not work, and a future
 * reader is otherwise likely to "simplify" it back:
 *
 * 1. SOURCE -> REGISTRY. Every `(method, path)` pair resolvable from source must be
 *    declared. Catches an added route. Cannot see the 18 routes registered by regex,
 *    `endsWith`, `slice`, prefix decode, or a path constant.
 * 2. REGISTRY -> SOURCE. Every declared literal route's path must appear in its declared
 *    owner file. Catches a typo or a stale declaration. Cannot hold for the 18
 *    non-literal routes, whose paths contain `{param}` placeholders that appear nowhere.
 * 3. PER-MODULE RECONCILIATION. For each module, declared count must equal scanned pairs
 *    plus declared non-literal routes. This is the one that catches an UNDER-declared
 *    registry: a route omitted from the registry AND invisible to check 1 is invisible
 *    to both other checks, and that is precisely where a gate passes vacuously.
 *
 * The reconciliation counts `(method, path)` PAIRS, never `rg` line hits. Line counting
 * cannot balance: one guard registers two routes when it reads `PUT || PATCH`, nineteen
 * path guards decide their method in a preceding sibling guard or a nested one, and two
 * live routes are written `pathname !== "…"` so an equality scan never sees them. One
 * module has one route and zero equality literals.
 *
 * The scanner fails loud: a path guard whose method it cannot resolve comes back with
 * `method: null` and test 4 fails on it. It never assumes GET.
 */
const repoRoot = resolveRepoRoot();

/** Files that carry management routes. Kept explicit: two live outside `management/`. */
function routeCarryingFiles(): string[] {
  const files = [
    "src/server/management-api.ts",
    // Mounted outside the `??` chain (management-api.ts:284, :289), which is why a scan
    // scoped to `src/server/management/` misses 29 route literals entirely.
    "src/codex/auth-api.ts",
    "src/codex/native-profile-api.ts",
  ];
  for (const f of readdirSync(join(repoRoot, "src/server/management")).sort()) {
    // Skip the registry itself: it is a data table whose doc comment quotes route paths,
    // so scanning it would reconcile the declaration against its own prose.
    if (f.endsWith(".ts") && f !== "route-registry.ts") files.push(`src/server/management/${f}`);
  }
  return files;
}

const moduleOf = (file: string): string => file.replace(/^src\//, "").replace(/\.ts$/, "");
const key = (method: string, path: string): string => `${method} ${path}`;

describe("management route registry reconciliation", () => {
  test("every route resolvable from source is declared in the registry", () => {
    const declared = new Set(MANAGEMENT_ROUTES.map(r => key(r.method, r.path)));
    const undeclared: string[] = [];
    for (const file of routeCarryingFiles()) {
      const { pairs } = distinctRoutes(scanRoutes(join(repoRoot, file)));
      for (const pair of pairs) {
        if (!declared.has(pair)) undeclared.push(`${pair}  (${file})`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test("every declared literal route's path appears in its owner module", () => {
    const missing: string[] = [];
    const cache = new Map<string, string>();
    for (const route of MANAGEMENT_ROUTES) {
      // Non-literal routes carry `{param}` placeholders or live behind a constant, so
      // their path is not present as text. Check 3 covers them instead.
      if (route.mechanism) continue;
      const file = `src/${route.module}.ts`;
      let src = cache.get(file);
      if (src === undefined) {
        src = readFileSync(join(repoRoot, file), "utf8");
        cache.set(file, src);
      }
      if (!src.includes(`"${route.path}"`)) missing.push(`${key(route.method, route.path)} not in ${file}`);
    }
    expect(missing).toEqual([]);
  });

  test("per-module counts reconcile: declared == scanned pairs + declared non-literal", () => {
    const mismatches: string[] = [];
    for (const file of routeCarryingFiles()) {
      const mod = moduleOf(file);
      const { pairs } = distinctRoutes(scanRoutes(join(repoRoot, file)));
      const declaredForModule = MANAGEMENT_ROUTES.filter(r => r.module === mod);
      const nonLiteral = declaredForModule.filter(r => r.mechanism);
      // A non-literal route can ALSO be scannable (a negated guard is both), so count
      // the union rather than adding two overlapping sets.
      const expected = new Set<string>(pairs);
      for (const r of nonLiteral) expected.add(key(r.method, r.path));
      const actual = new Set(declaredForModule.map(r => key(r.method, r.path)));
      if (expected.size !== actual.size) {
        const onlyExpected = [...expected].filter(k => !actual.has(k));
        const onlyActual = [...actual].filter(k => !expected.has(k));
        mismatches.push(`${mod}: expected ${expected.size} got ${actual.size}; missing=[${onlyExpected}] extra=[${onlyActual}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("the scanner resolves a method for every route guard it finds", () => {
    // Fail loud, never guess. An unresolvable guard means the scanner needs a new
    // narrowing rule, not a default.
    const unresolved: string[] = [];
    for (const file of routeCarryingFiles()) {
      for (const r of distinctRoutes(scanRoutes(join(repoRoot, file))).unresolved) {
        unresolved.push(`${file}:${r.line} ${r.path}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("the scanner reports an unresolvable method instead of assuming GET", () => {
    // Drives the fail-loud path red on purpose: without this, a scanner that silently
    // defaulted to GET would satisfy every other test in this file while producing a
    // route table nobody could trust.
    const tmp = join(repoRoot, ".tmp-scanner-probe.ts");
    const source = [
      "export async function handleProbe(ctx: any): Promise<Response | null> {",
      "  const { url, req } = ctx;",
      "  const chosen = req.method;",
      '  if (url.pathname === "/api/probe/unknowable") {',
      "    return dispatch(chosen);",
      "  }",
      "  return null;",
      "}",
    ].join("\n");
    require("node:fs").writeFileSync(tmp, source);
    try {
      const { unresolved } = distinctRoutes(scanRoutes(tmp));
      expect(unresolved.map(r => r.path)).toEqual(["/api/probe/unknowable"]);
      expect(unresolved[0]?.method).toBeNull();
    } finally {
      require("node:fs").rmSync(tmp, { force: true });
    }
  });

  test("a multi-method disjunction expands into one route per method", () => {
    // `PUT || PATCH` on one guard is two routes. A count keyed on line hits saw one.
    const poolStrategy = MANAGEMENT_ROUTES.filter(r => r.path === "/api/codex-auth/pool-strategy");
    expect(poolStrategy.map(r => r.method).sort()).toEqual(["PATCH", "PUT"]);
  });

  test("the negated-guard routes are declared, and the dead duplicate is GONE", () => {
    // An equality scan cannot see a `pathname !== x` guard at all, so both of these are
    // declared by hand. `/api/storage` previously had TWO declarations: the live guard and a
    // shadowed copy in logs-usage-routes that could never run, exempted as `dead` with a note
    // saying to delete rather than expose it. wp7 deleted it, so exactly one remains and it is
    // the live one -- an unreachable duplicate is a trap for the next reader.
    const storage = MANAGEMENT_ROUTES.filter(r => r.path === "/api/storage");
    expect(storage).toHaveLength(1);
    expect(storage[0]?.module).toMatch(/storage-log-guard-routes$/);
    expect(storage[0]?.exempt).toBeUndefined();
    // No `dead` exemption should survive anywhere: the vocabulary exists for routes awaiting
    // deletion, so a lingering one means the deletion never happened.
    expect(MANAGEMENT_ROUTES.filter(r => r.exempt?.reason === "dead")).toEqual([]);
    expect(MANAGEMENT_ROUTES.some(r => r.path === "/api/routing-analytics")).toBe(true);
  });
});

describe("route exemptions stay honest", () => {
  test("every exemption carries a non-trivial reason", () => {
    const thin = MANAGEMENT_ROUTES
      .filter(r => r.exempt && r.exempt.why.trim().length < 40)
      .map(r => key(r.method, r.path));
    expect(thin).toEqual([]);
  });

  test("a deferred-verb exemption names an owner phase and a TRACKED doc that exists", () => {
    // The owner doc is a repository file, deliberately NOT the goalplan: `.codexclaw/` is
    // gitignored, so a test reading it would pass locally and find nothing in CI -- the
    // same vacuous pass this suite exists to prevent.
    const deferred = MANAGEMENT_ROUTES.filter(r => r.exempt?.reason === "deferred-verb");
    expect(deferred.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const route of deferred) {
      const { owner, ownerDoc } = route.exempt!;
      if (!owner) problems.push(`${key(route.method, route.path)}: no owner`);
      if (!ownerDoc) { problems.push(`${key(route.method, route.path)}: no ownerDoc`); continue; }
      if (!existsSync(join(repoRoot, ownerDoc))) problems.push(`${key(route.method, route.path)}: ownerDoc ${ownerDoc} missing`);
    }
    expect(problems).toEqual([]);
  });

  test("the user-consent star boundary is exempt and never gains a verb", () => {
    const star = MANAGEMENT_ROUTES.find(r => r.path === "/api/github/star" && r.method === "POST");
    expect(star?.exempt?.reason).toBe("session-only");
  });

  test("every mutating lab route is either verbed or bounded by a deferred-verb owner", () => {
    // The original plan exempted "20 /api/lab/* reads" under local-transport. The family
    // holds 7 mutating routes, and reading local SQLite cannot start an automation run,
    // so local-transport never covered them.
    const mutatingLab = MANAGEMENT_ROUTES.filter(r => r.path.startsWith("/api/lab") && r.mutates);
    expect(mutatingLab).toHaveLength(7);
    for (const route of mutatingLab) {
      expect(route.exempt?.reason, key(route.method, route.path)).toBe("deferred-verb");
    }
  });

  test("no lab route is exempted as local-transport while mutating", () => {
    const wrong = MANAGEMENT_ROUTES
      .filter(r => r.mutates && r.exempt?.reason === "local-transport")
      .map(r => key(r.method, r.path));
    expect(wrong).toEqual([]);
  });
});

describe("the registry is inert data", () => {
  test("route-registry.ts imports nothing at all", () => {
    // It is imported by src/server/management-api.ts, which tests/core-lab-boundary
    // protects. A path string creates no module edge; an import would.
    const src = readFileSync(join(repoRoot, "src/server/management/route-registry.ts"), "utf8");
    const imports = src.match(/^\s*(import|export)\s+[^;]*from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
    // Check the import graph, not prose: this file's own header explains why it must not
    // import Lab, so a naive substring search flags the explanation as the violation.
    expect(/from\s+["'][^"']*lab[^"']*["']/.test(src)).toBe(false);
    expect(/\bimport\s*\(/.test(src)).toBe(false);
  });
});
