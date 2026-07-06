/**
 * Bundled Bun runtime resolution.
 *
 * opencodex ships the Bun runtime via the `bun` npm dependency (esbuild-style:
 * a tiny main package + platform-specific `@oven/bun-*` optionalDependencies,
 * finalized by the package's own postinstall `node install.js`). The npm `bin`
 * launcher (bin/ocx.mjs) and the durable service/shim integrations both need a
 * stable path to that binary. This module is the single source of truth.
 *
 * In a from-source dev checkout the `bun` dependency may be absent; callers fall
 * back to `process.execPath` (which is itself Bun when run via `bun src/cli.ts`).
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// The `bun` package leaves a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary; reject the stub by size so we
// never bake a non-executable path into durable artifacts.
const REAL_BUN_MIN_BYTES = 1_000_000;
const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";

export type DurableBunRuntime = {
  path: string;
  source: "override" | "bundled" | "process";
  overrideEnv: typeof BUN_OVERRIDE_ENV;
};

/**
 * True only for a real, downloaded Bun binary — not the ~450-byte ASCII
 * placeholder stub left by `--ignore-scripts` / pnpm. A size gate cleanly
 * separates the two on every platform (real binary is tens of MB).
 */
export function isRealBunBinary(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size >= REAL_BUN_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the bundled Bun binary, or null if the `bun` dependency is
 * not installed/resolvable (or only the un-downloaded placeholder is present).
 * The npm `bun` package ships the binary as `bin/bun.exe` on every platform;
 * we also probe `bin/bun` for forward compatibility.
 */
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    for (const name of ["bun.exe", "bun"]) {
      const p = join(bunDir, "bin", name);
      if (isRealBunBinary(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

export function overrideBunPath(): string | null {
  const value = process.env[BUN_OVERRIDE_ENV]?.trim();
  if (!value) return null;
  return isRealBunBinary(value) ? value : null;
}

export function durableBunRuntime(): DurableBunRuntime {
  const override = overrideBunPath();
  if (override) return { path: override, source: "override", overrideEnv: BUN_OVERRIDE_ENV };
  const bundled = bundledBunPath();
  if (bundled) return { path: bundled, source: "bundled", overrideEnv: BUN_OVERRIDE_ENV };
  return { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
}

/**
 * Bun path to bake into durable artifacts (launchd/systemd/Task Scheduler and
 * the Codex auto-start shim). Prefer the bundled binary — it lives under the
 * npm global prefix and survives across `ocx update` — and fall back to the
 * current runtime, which is Bun when launched normally.
 */
export function durableBunPath(): string {
  return durableBunRuntime().path;
}
