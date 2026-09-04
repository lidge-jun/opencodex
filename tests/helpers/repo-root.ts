import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@bitkyc08/opencodex";
let cached: string | null = null;

/**
 * Repository root, found by walking up from this helper to the package.json that names
 * opencodex. Tests use this instead of `import.meta.dir + "/.."`, which is only correct while
 * the test sits directly under tests/ and silently reads the wrong tree once it moves into a
 * domain directory (devlog 260905_test_modularization_and_windows/030).
 */
export function repoRoot(): string {
  if (cached) return cached;
  let dir = import.meta.dir;
  for (let hops = 0; hops < 8; hops += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
      if (parsed.name === PACKAGE_NAME) {
        cached = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`tests/helpers/repo-root: package.json for ${PACKAGE_NAME} not found above ${import.meta.dir}`);
}

/** Absolute path under the repository, for source-oracle reads. */
export function repoPath(...segments: string[]): string {
  return join(repoRoot(), ...segments);
}

/** Absolute path of a file under tests/helpers, for child-process spawns. */
export function helperPath(name: string): string {
  return join(repoRoot(), "tests", "helpers", name);
}
