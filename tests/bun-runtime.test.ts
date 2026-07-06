import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, overrideBunPath } from "../src/lib/bun-runtime";

const tmp = mkdtempSync(join(tmpdir(), "ocx-bun-runtime-"));
const previousOverride = process.env.OPENCODEX_BUN_PATH;
afterAll(() => {
  if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
  else process.env.OPENCODEX_BUN_PATH = previousOverride;
  rmSync(tmp, { recursive: true, force: true });
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
  it("uses OPENCODEX_BUN_PATH only when it points to a real Bun binary", () => {
    const real = join(tmp, "override-bun.exe");
    const stub = join(tmp, "override-stub.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    writeFileSync(stub, "stub");

    process.env.OPENCODEX_BUN_PATH = stub;
    expect(overrideBunPath()).toBeNull();
    expect(durableBunRuntime().source).not.toBe("override");

    process.env.OPENCODEX_BUN_PATH = real;
    expect(overrideBunPath()).toBe(real);
    expect(durableBunRuntime()).toEqual({
      path: real,
      source: "override",
      overrideEnv: "OPENCODEX_BUN_PATH",
    });
    expect(durableBunPath()).toBe(real);
    if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
    else process.env.OPENCODEX_BUN_PATH = previousOverride;
  });

  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const bundled = bundledBunPath();
    const durable = durableBunPath();
    expect(typeof durable).toBe("string");
    expect(durable.length).toBeGreaterThan(0);
    if (bundled) expect(durable).toBe(bundled);
    else expect(durable).toBe(process.execPath);
  });
});
