import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubNativeMainAuthTempResidues } from "../src/codex/native-main-auth-temp";
import { resolveNativeProfileContext } from "../src/codex/native-profile-store";
import { NativeProfileError } from "../src/codex/native-profile-types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-auth-temp-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  return {
    codexHome,
    context: resolveNativeProfileContext({ codexHome, configDir: join(root, "config") }),
  };
}

function expectCleanupRequired(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeProfileError);
    expect((error as NativeProfileError).code).toBe("AUTH_TEMP_CLEANUP_REQUIRED");
    return;
  }
  throw new Error("expected native auth temp cleanup to fail closed");
}

describe("native-main auth temp startup scrub", () => {
  test("truncates and removes exact atomic-writer residues without touching near-miss names", () => {
    const f = fixture();
    const authPath = join(f.codexHome, "auth.json");
    const authText = "current-auth-private-value";
    writeFileSync(authPath, authText);
    const exact = ["auth.json.ocx.123.1.tmp", "auth.json.ocx.456.27.tmp"];
    const near = [
      "auth.json.ocx.0.1.tmp",
      "auth.json.ocx.01.1.tmp",
      "auth.json.ocx.1.0.tmp",
      "auth.json.ocx.1.01.tmp",
      "auth.json.ocx.1.1.TMP",
      "auth.json.ocx.1.1.tmp.bak",
    ];
    for (const name of [...exact, ...near]) writeFileSync(join(f.codexHome, name), `private-${name}`);

    expect(scrubNativeMainAuthTempResidues(f.context)).toEqual({ scrubbed: 2 });
    expect(readFileSync(authPath, "utf8")).toBe(authText);
    for (const name of exact) expect(existsSync(join(f.codexHome, name))).toBe(false);
    for (const name of near) expect(readFileSync(join(f.codexHome, name), "utf8")).toBe(`private-${name}`);
  });

  test("fails closed without following an exact-name symlink or truncating its target", () => {
    const f = fixture();
    const target = join(f.codexHome, "near-miss-target");
    const residue = join(f.codexHome, "auth.json.ocx.123.1.tmp");
    writeFileSync(target, "target-private-value");
    try {
      symlinkSync(target, residue, "file");
    } catch (err) {
      // Windows without Developer Mode / elevated privileges cannot create symlinks,
      // and a file symlink is what this case is about. The hard-link case below still
      // covers refusing to truncate a shared target on this machine.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    expectCleanupRequired(() => scrubNativeMainAuthTempResidues(f.context));
    expect(lstatSync(residue).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("target-private-value");
  });

  test("fails closed without truncating a multiply-linked exact-name file", () => {
    const f = fixture();
    const target = join(f.codexHome, "hardlink-target");
    const residue = join(f.codexHome, "auth.json.ocx.123.1.tmp");
    writeFileSync(target, "hardlink-private-value");
    linkSync(target, residue);

    expectCleanupRequired(() => scrubNativeMainAuthTempResidues(f.context));
    expect(readFileSync(target, "utf8")).toBe("hardlink-private-value");
    expect(readFileSync(residue, "utf8")).toBe("hardlink-private-value");
  });

  test("detects replacement between inspection and open without truncating either file", () => {
    const f = fixture();
    const residue = join(f.codexHome, "auth.json.ocx.123.1.tmp");
    const moved = join(f.codexHome, "moved-residue");
    writeFileSync(residue, "original-private-value");

    expectCleanupRequired(() => scrubNativeMainAuthTempResidues(f.context, {
      beforeOpen(path) {
        renameSync(path, moved);
        writeFileSync(path, "replacement-private-value");
      },
    }));
    expect(readFileSync(moved, "utf8")).toBe("original-private-value");
    expect(readFileSync(residue, "utf8")).toBe("replacement-private-value");
  });

  test("fails closed after truncate when removal cannot proceed", () => {
    const f = fixture();
    const residue = join(f.codexHome, "auth.json.ocx.123.1.tmp");
    writeFileSync(residue, "private-value");

    expectCleanupRequired(() => scrubNativeMainAuthTempResidues(f.context, {
      beforeUnlink() { throw new Error("injected unlink failure"); },
    }));
    expect(existsSync(residue)).toBe(true);
    expect(readFileSync(residue)).toHaveLength(0);
  });

  test("fails closed before modifying an excessive exact-residue set", () => {
    const f = fixture();
    for (let sequence = 1; sequence <= 129; sequence += 1) {
      writeFileSync(join(f.codexHome, `auth.json.ocx.123.${sequence}.tmp`), "private-value");
    }

    expectCleanupRequired(() => scrubNativeMainAuthTempResidues(f.context));
    expect(readFileSync(join(f.codexHome, "auth.json.ocx.123.1.tmp"), "utf8")).toBe("private-value");
    expect(readFileSync(join(f.codexHome, "auth.json.ocx.123.129.tmp"), "utf8")).toBe("private-value");
  });
});
