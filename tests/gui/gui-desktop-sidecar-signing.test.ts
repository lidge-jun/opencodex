import { expect, test } from "bun:test";
import {
  CODESIGN_PATH,
  adHocSignArgv,
  adHocSignSidecar,
  shouldAdHocSignSidecar,
} from "../../desktop/scripts/sidecar-signing";
import { repoPath } from "../helpers/repo-root";

test("only a macOS host preparing a darwin target signs the sidecar", () => {
  expect(shouldAdHocSignSidecar("darwin", "bun-darwin-arm64")).toBe(true);
  expect(shouldAdHocSignSidecar("darwin", "bun-darwin-x64")).toBe(true);
  for (const target of ["bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"]) {
    expect(shouldAdHocSignSidecar("darwin", target)).toBe(false);
  }
  for (const host of ["linux", "win32"]) {
    expect(shouldAdHocSignSidecar(host, "bun-darwin-arm64")).toBe(false);
  }
});

test("signing runs the absolute codesign with an ad-hoc forced signature", () => {
  const calls: string[][] = [];
  const code = adHocSignSidecar("/tmp/binaries/ocx-aarch64-apple-darwin", (argv) => {
    calls.push(argv);
    return { exitCode: 0 };
  });
  expect(code).toBe(0);
  expect(calls).toEqual([[CODESIGN_PATH, "-s", "-", "-f", "/tmp/binaries/ocx-aarch64-apple-darwin"]]);
  expect(adHocSignArgv("x")[0]).toBe("/usr/bin/codesign");
});

test("a failed or unlaunchable codesign stops preparation with a nonzero code", () => {
  expect(adHocSignSidecar("x", () => ({ exitCode: 3 }))).toBe(3);
  expect(adHocSignSidecar("x", () => ({ exitCode: null }))).toBe(1);
});

test("prepare-sidecar signs through the guarded helper right after copying", async () => {
  const script = await Bun.file(repoPath("desktop", "scripts", "prepare-sidecar.ts")).text();
  const copy = script.indexOf("copyFileSync(executable, destination);");
  const guard = script.indexOf("if (shouldAdHocSignSidecar(process.platform, target))");
  const resources = script.indexOf("cpSync(join(repoRoot, \"gui\", \"dist\")");
  expect(copy).toBeGreaterThan(-1);
  expect(guard).toBeGreaterThan(copy);
  expect(resources).toBeGreaterThan(guard);
  expect(script).not.toContain("codesign\", \"-s\"");
});
