import { describe, expect, test } from "bun:test";
import { normalizeArgKeys } from "../src/adapters/cursor/arg-normalize";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    command: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  },
};

describe("normalizeArgKeys", () => {
  test("renames a known alias to the schema-declared canonical key", () => {
    expect(normalizeArgKeys({ filepath: "a.txt" }, schema)).toEqual({ path: "a.txt" });
    expect(normalizeArgKeys({ cmd: "ls -la" }, schema)).toEqual({ command: "ls -la" });
    expect(normalizeArgKeys({ oldstring: "x", newstring: "y" }, schema)).toEqual({ old_string: "x", new_string: "y" });
  });

  test("leaves keys already matching the schema untouched", () => {
    const args = { path: "a.txt", command: "ls" };
    expect(normalizeArgKeys(args, schema)).toBe(args);
  });

  test("does not rename when the canonical key is not in the schema", () => {
    // `cmd`->`command` but this schema has no `command` property.
    const narrow = { type: "object", properties: { path: { type: "string" } } };
    expect(normalizeArgKeys({ cmd: "ls" }, narrow)).toEqual({ cmd: "ls" });
  });

  test("canonical key wins over alias regardless of property insertion order", () => {
    expect(normalizeArgKeys({ command: "canonical", cmd: "alias" }, schema)).toEqual({ command: "canonical" });
    expect(normalizeArgKeys({ cmd: "alias", command: "canonical" }, schema)).toEqual({ command: "canonical" });
    expect(normalizeArgKeys({ path: "real.txt", filepath: "alias.txt" }, schema)).toEqual({ path: "real.txt" });
    expect(normalizeArgKeys({ filepath: "alias.txt", path: "real.txt" }, schema)).toEqual({ path: "real.txt" });
  });

  test("alias-only payloads still rewrite to the canonical key", () => {
    expect(normalizeArgKeys({ cmd: "alias" }, schema)).toEqual({ command: "alias" });
    expect(normalizeArgKeys({ filepath: "a.txt" }, schema)).toEqual({ path: "a.txt" });
  });

  test("identical alias and canonical values keep only the canonical key", () => {
    expect(normalizeArgKeys({ command: "same", cmd: "same" }, schema)).toEqual({ command: "same" });
    expect(normalizeArgKeys({ cmd: "same", command: "same" }, schema)).toEqual({ command: "same" });
  });

  test("conflicting alias and canonical values keep only the canonical key", () => {
    expect(normalizeArgKeys({ command: "safe command", cmd: "different command" }, schema)).toEqual({
      command: "safe command",
    });
    expect(normalizeArgKeys({ cmd: "different command", command: "safe command" }, schema)).toEqual({
      command: "safe command",
    });
  });

  test("returns args unchanged when schema has no properties", () => {
    const args = { filepath: "a.txt" };
    expect(normalizeArgKeys(args, undefined)).toBe(args);
    expect(normalizeArgKeys(args, { type: "object" })).toBe(args);
  });

  test("is case-insensitive on the alias key", () => {
    expect(normalizeArgKeys({ FilePath: "a.txt" }, schema)).toEqual({ path: "a.txt" });
  });

  test("preserves unrelated unknown keys", () => {
    expect(normalizeArgKeys({ cmd: "ls", workdir: "C:/repo" }, schema)).toEqual({
      command: "ls",
      workdir: "C:/repo",
    });
  });
});
