import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, reportedBunRuntimeSource, withProcessRuntimeProvenance } from "../src/lib/bun-runtime";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// realpath the temp root: on macOS /var is a symlink to /private/var, so a path built
// from mkdtemp compares unequal to the same path resolved through process.cwd().
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocx-bun-runtime-")));
const previousOverride = process.env.OPENCODEX_BUN_PATH;
const previousRuntimeSource = process.env[BUN_RUNTIME_SOURCE_ENV];
const previousRuntimePath = process.env[BUN_RUNTIME_PATH_ENV];
afterEach(() => {
  if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
  else process.env.OPENCODEX_BUN_PATH = previousOverride;
  if (previousRuntimeSource === undefined) delete process.env[BUN_RUNTIME_SOURCE_ENV];
  else process.env[BUN_RUNTIME_SOURCE_ENV] = previousRuntimeSource;
  if (previousRuntimePath === undefined) delete process.env[BUN_RUNTIME_PATH_ENV];
  else process.env[BUN_RUNTIME_PATH_ENV] = previousRuntimePath;
});
afterAll(() => {
  removeTreeWithRetry(tmp);
});

describe("isRealBunBinary (size gate vs placeholder stub)", () => {
  it("rejects the ~450-byte ASCII placeholder stub", () => {
    const stub = join(tmp, "bun-stub.exe");
    // Mirrors the real stub: a small shell script that errors out.
    writeFileSync(stub, 'echo "Error: Bun\'s postinstall script was not run." >&2\nexit 1\n');
    expect(isRealBunBinary(stub)).toBe(false);
  });

  it("accepts a binary at or above the 1MB threshold", () => {
    const real = join(tmp, "bun-real.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    expect(isRealBunBinary(real)).toBe(true);
  });

  it("rejects a non-existent path", () => {
    expect(isRealBunBinary(join(tmp, "does-not-exist.exe"))).toBe(false);
  });

  it("rejects an empty file", () => {
    const empty = join(tmp, "empty.exe");
    writeFileSync(empty, "");
    expect(isRealBunBinary(empty)).toBe(false);
  });
});

describe("bundledBunPath / durableBunPath", () => {
  it("does not reselect a dotenv Bun override after the runtime has started", () => {
    const real = join(tmp, "override-bun.exe");
    const stub = join(tmp, "override-stub.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    writeFileSync(stub, "stub");

    process.env.OPENCODEX_BUN_PATH = stub;
    expect(durableBunRuntime().source).not.toBe("override");

    process.env.OPENCODEX_BUN_PATH = real;
    delete process.env[BUN_RUNTIME_SOURCE_ENV];
    delete process.env[BUN_RUNTIME_PATH_ENV];
    expect(durableBunRuntime().path).not.toBe(real);
    expect(durableBunRuntime().source).not.toBe("override");
    if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
    else process.env.OPENCODEX_BUN_PATH = previousOverride;
  });

  it("preserves a launcher-selected runtime and ignores a later relative override", () => {
    const launcherCwd = join(tmp, "launcher-cwd");
    const real = join(launcherCwd, "relative-bun.exe");
    const previousCwd = process.cwd();
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    mkdirSync(launcherCwd, { recursive: true });
    writeFileSync(real, Buffer.alloc(1_000_000));

    try {
      process.chdir(launcherCwd);
      process.env.OPENCODEX_BUN_PATH = "  relative-bun.exe  ";
      process.env[BUN_RUNTIME_SOURCE_ENV] = "override";
      process.env[BUN_RUNTIME_PATH_ENV] = process.execPath;
      expect(durableBunRuntime()).toEqual({
        path: process.execPath,
        source: "override",
        overrideEnv: "OPENCODEX_BUN_PATH",
      });
      expect(durableBunPath()).toBe(process.execPath);
    } finally {
      process.chdir(previousCwd);
      if (previousRuntimeSource === undefined) delete process.env[BUN_RUNTIME_SOURCE_ENV];
      else process.env[BUN_RUNTIME_SOURCE_ENV] = previousRuntimeSource;
      if (previousRuntimePath === undefined) delete process.env[BUN_RUNTIME_PATH_ENV];
      else process.env[BUN_RUNTIME_PATH_ENV] = previousRuntimePath;
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });

  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    delete process.env.OPENCODEX_BUN_PATH;
    try {
      const bundled = bundledBunPath();
      const durable = durableBunPath();
      expect(typeof durable).toBe("string");
      expect(durable.length).toBeGreaterThan(0);
      if (bundled) expect(durable).toBe(bundled);
      else expect(durable).toBe(process.execPath);
    } finally {
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });
});

describe("reportedBunRuntimeSource (#848 launch-time provenance)", () => {
  it("reads back each allowlisted marker", () => {
    for (const source of ["override", "bundled", "process"] as const) {
      // The pair contract: source alone reports unknown; source + this
      // executable's path reports the allowlisted origin.
      expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: source })).toBeUndefined();
      expect(reportedBunRuntimeSource({
        [BUN_RUNTIME_SOURCE_ENV]: source,
        [BUN_RUNTIME_PATH_ENV]: process.execPath,
      })).toBe(source);
    }
  });

  it("reports unknown when the recorded path names another executable", () => {
    expect(reportedBunRuntimeSource({
      [BUN_RUNTIME_SOURCE_ENV]: "override",
      [BUN_RUNTIME_PATH_ENV]: "/usr/local/bin/definitely-not-this-bun",
    })).toBeUndefined();
  });

  it("treats an absent marker as unknown rather than guessing from this process", () => {
    // A service installed before provenance existed has no marker. Reporting a
    // confident wrong origin is exactly the #848 failure, so the answer is undefined.
    expect(reportedBunRuntimeSource({})).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "" })).toBeUndefined();
  });

  it("rejects values outside the allowlist instead of passing them through", () => {
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "system" })).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "OVERRIDE" })).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "override; rm -rf /" })).toBeUndefined();
  });

  it("does not fall back to the current environment when the marker is missing", () => {
    const inherited = process.env.OPENCODEX_BUN_PATH;
    const real = join(tmp, "provenance-bun.exe");
    mkdirSync(join(tmp), { recursive: true });
    writeFileSync(real, "x".repeat(2 * 1024 * 1024));
    process.env.OPENCODEX_BUN_PATH = real;
    try {
      // The durable selector ignores this late value, and the reporter must also
      // stay unknown without a source/path pair naming the running executable.
      delete process.env[BUN_RUNTIME_SOURCE_ENV];
      delete process.env[BUN_RUNTIME_PATH_ENV];
      expect(durableBunRuntime().source).not.toBe("override");
      expect(reportedBunRuntimeSource({})).toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inherited;
    }
  });
});

describe("withProcessRuntimeProvenance (execPath relaunch paths)", () => {
  // Under `bun test` the runner may itself BE the bundled binary, in which case
  // `bundled` is the correct answer rather than `process`. Both are legitimate;
  // what matters is that a real origin is always recorded.
  const executingOrigin = bundledBunPath() === process.execPath ? "bundled" : "process";

  it("records the executable's real origin when the relaunching parent carries no marker", () => {
    // `ocx ensure`, GUI start, restart, and update-relaunch all re-exec
    // process.execPath. Without this they would hand the daemon no provenance at
    // all, and doctor would report unknown for an origin the launcher knew.
    expect(withProcessRuntimeProvenance({})[BUN_RUNTIME_SOURCE_ENV]).toBe(executingOrigin);
  });

  it("preserves an inherited marker instead of relabeling the same runtime", () => {
    // Re-execing the current runtime does not change how that runtime was obtained,
    // but the claim is only carried forward when the binary it was minted for is the
    // one about to run. The recorded path is what settles that — re-deriving the
    // selection would demote a service installed with a shell-local override.
    const overrideEnv = {
      [BUN_RUNTIME_SOURCE_ENV]: "override",
      [BUN_RUNTIME_PATH_ENV]: process.execPath,
    };
    expect(withProcessRuntimeProvenance(overrideEnv)[BUN_RUNTIME_SOURCE_ENV]).toBe("override");

    // Crucially this holds with no OPENCODEX_BUN_PATH in the environment at all: an
    // installed service keeps neither the shell that installed it nor its variables.
    expect(overrideEnv).not.toHaveProperty("OPENCODEX_BUN_PATH");

    // The pair is re-stamped for the child, so the next relaunch can do the same check.
    expect(withProcessRuntimeProvenance(overrideEnv)[BUN_RUNTIME_PATH_ENV]).toBe(process.execPath);
  });

  it("drops an inherited marker that no longer describes the running binary", () => {
    // Inheritance travels down a process tree, so a marker can outlive the binary it
    // was minted for: something launched under a marked process but running a
    // different Bun must not relaunch the daemon claiming that other binary's origin.
    const staleOverride = {
      [BUN_RUNTIME_SOURCE_ENV]: "override",
      [BUN_RUNTIME_PATH_ENV]: join(tmp, "some-other-bun.exe"),
    };
    expect(withProcessRuntimeProvenance(staleOverride)[BUN_RUNTIME_SOURCE_ENV]).not.toBe("override");

    // A source with no recorded path cannot be corroborated and is not carried forward.
    expect(withProcessRuntimeProvenance({ [BUN_RUNTIME_SOURCE_ENV]: "override" })[BUN_RUNTIME_SOURCE_ENV]).not.toBe("override");
  });

  it("replaces an unrecognized inherited value rather than forwarding it", () => {
    expect(withProcessRuntimeProvenance({ [BUN_RUNTIME_SOURCE_ENV]: "system" })[BUN_RUNTIME_SOURCE_ENV]).toBe(executingOrigin);
  });

  it("leaves every other variable untouched", () => {
    const result = withProcessRuntimeProvenance({ OCX_SERVICE: "1", PATH: "/usr/bin" });
    expect(result.OCX_SERVICE).toBe("1");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("is applied by every detached proxy launcher that re-execs process.execPath", () => {
    // A launcher added later that copies process.env directly would silently drop
    // provenance again, so the launch sites are pinned here rather than left to review.
    const launchers = [
      "src/cli/index.ts",
      "src/cli/claude.ts",
      "src/cli/opencode.ts",
      "src/server/management/system-restart.ts",
      "src/update/index.ts",
    ];
    for (const relative of launchers) {
      const text = readFileSync(join(import.meta.dir, "..", relative), "utf8");
      const spawnCount = (text.match(/spawn\(process\.execPath/g) ?? []).length;
      const directStampCount = (text.match(/env: withProcessRuntimeProvenance\(/g) ?? []).length;
      const detachedStartStampCount = relative === "src/cli/index.ts"
        ? (text.match(/env: detachedStartEnvironment\(\)/g) ?? []).length
        : 0;
      if (detachedStartStampCount > 0) {
        expect(text).toContain("return withProcessRuntimeProvenance(env)");
      }
      expect(spawnCount).toBeGreaterThan(0);
      expect(directStampCount + detachedStartStampCount).toBe(spawnCount);
    }
  });
});
