import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFilePreservingTarget } from "../src/lib/atomic-file-preserving-replace";

let directory = "";

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("preserving file replacement", () => {
  test("exchanges a staged credential without removing the canonical target", () => {
    directory = mkdtempSync(join(tmpdir(), "ocx-preserving-replace-"));
    const staged = join(directory, ".refresh.new");
    const canonical = join(directory, "auth.json");
    const backup = join(directory, ".refresh.previous");
    writeFileSync(staged, "replacement");
    writeFileSync(canonical, "external-before");

    replaceFilePreservingTarget(staged, canonical, backup);

    expect(existsSync(canonical)).toBe(true);
    expect(readFileSync(canonical, "utf8")).toBe("replacement");
    expect(readFileSync(process.platform === "win32" ? backup : staged, "utf8")).toBe("external-before");
  });
});
