import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateRegularFile } from "../src/lab/public/file-safety";
import { PublicEvidenceValidationError } from "../src/lab/public/validate";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cl10-file-safety-"));
  roots.push(root);
  return root;
}

test("descriptor-bound private reads reject a symlink even when O_NOFOLLOW is unavailable", () => {
  const root = tempRoot();
  const target = join(root, "target.txt");
  const link = join(root, "link.txt");
  writeFileSync(target, "safe-bytes", { mode: 0o600 });
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }

  expect(() => readPrivateRegularFile(link, {
    maxBytes: 1024,
    errorCode: "unsafe_test_file",
    errorMessage: "unsafe test file",
  })).toThrow(PublicEvidenceValidationError);
});

test("descriptor-bound private reads reject a file with an unrelated hard link", () => {
  if (process.platform === "win32") return;
  const root = tempRoot();
  const target = join(root, "target.txt");
  const alias = join(root, "alias.txt");
  writeFileSync(target, "safe-bytes", { mode: 0o600 });
  linkSync(target, alias);

  expect(() => readPrivateRegularFile(target, {
    maxBytes: 1024,
    errorCode: "unsafe_test_file",
    errorMessage: "unsafe test file",
  })).toThrow(PublicEvidenceValidationError);
});
