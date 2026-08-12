import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRestrictedDir } from "../src/lab/paths";

const ROOTS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-lab-paths-"));
  ROOTS.push(root);
  return root;
}

afterEach(() => {
  for (const root of ROOTS.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("restricted Lab paths allow a symlinked infrastructure ancestor above the Lab boundary", () => {
  const root = tempRoot();
  const actualInfrastructure = join(root, "actual-infrastructure");
  const infrastructureAlias = join(root, "infrastructure-alias");
  mkdirSync(actualInfrastructure, { recursive: true });

  try {
    symlinkSync(actualInfrastructure, infrastructureAlias, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }

  const lab = join(infrastructureAlias, "opencodex", "lab");
  expect(() => ensureRestrictedDir(lab, lab)).not.toThrow();
  expect(realpathSync.native(lab)).toBe(realpathSync.native(join(actualInfrastructure, "opencodex", "lab")));
});

test("restricted Lab paths still reject a symlink at the Lab boundary itself", () => {
  const root = tempRoot();
  const actualLab = join(root, "actual-lab");
  const substitutedLab = join(root, "lab");
  mkdirSync(actualLab, { recursive: true });

  try {
    symlinkSync(actualLab, substitutedLab, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }

  expect(() => ensureRestrictedDir(substitutedLab, substitutedLab)).toThrow(/symbolic link|link or reparse-point substitution/);
});
