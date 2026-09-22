import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-non-object-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

test.each([
  ["number", "123"],
  ["boolean", "true"],
  ["string", JSON.stringify("not-an-object")],
  ["array", "[]"],
  ["null", "null"],
])("backs up a top-level %s instead of repairing it", (_kind, raw) => {
  const configPath = join(testDir, "config.json");
  writeFileSync(configPath, raw);
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(loadConfig()).toEqual(getDefaultConfig());
    const backups = readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(testDir, backups[0]), "utf-8")).toBe(raw);
    expect(readFileSync(configPath, "utf-8")).toBe(raw);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not load opencodex config"));
  } finally {
    errorSpy.mockRestore();
  }
});
