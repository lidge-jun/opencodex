import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_POLICY_SCHEMA, DEFAULT_CHILD_POLICY, FAIL_CLOSED_CHILD_POLICY, childPolicyPath, readChildPolicy, updateChildPolicy,
  validPolicyPatch } from "../../src/link/child-policy";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function configDir(): string { const dir = mkdtempSync(join(tmpdir(), "ocx-child-policy-")); dirs.push(dir); return dir; }
function writePolicy(dir: string, text: string): string {
  const path = childPolicyPath(dir);
  mkdirSync(join(dir, "link"), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("readChildPolicy", () => {
  test("an absent file reads the defaults with no warning", () => {
    const read = readChildPolicy(childPolicyPath(configDir()));
    expect(read).toEqual({ policy: { catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000 }, warning: null });
    expect(read.policy).toEqual({ ...DEFAULT_CHILD_POLICY });
  });

  test("a valid file is read, with absent keys taken from the defaults", () => {
    const path = writePolicy(configDir(), JSON.stringify({ schema: CHILD_POLICY_SCHEMA, catalogFanout: "manual", idleAfterMs: 60_000 }));
    expect(readChildPolicy(path)).toEqual({ policy: { ...DEFAULT_CHILD_POLICY, catalogFanout: "manual", idleAfterMs: 60_000 }, warning: null });
  });

  const invalid: Array<[string, string]> = [
    ["unknown key", JSON.stringify({ schema: CHILD_POLICY_SCHEMA, catalogFanout: "auto", extra: true })],
    ["bad enum", JSON.stringify({ schema: CHILD_POLICY_SCHEMA, updates: "sometimes" })],
    ["idle below the minimum", JSON.stringify({ schema: CHILD_POLICY_SCHEMA, idleAfterMs: 59_999 })],
    ["idle above the maximum", JSON.stringify({ schema: CHILD_POLICY_SCHEMA, idleAfterMs: 3_600_001 })],
    ["wrong schema", JSON.stringify({ schema: "ocx.link.child-policy/2", catalogFanout: "auto" })],
    ["malformed JSON", "{"],
    ["array", "[]"],
  ];
  for (const [name, text] of invalid) {
    test(`${name} fails closed with a warning and leaves the file untouched`, () => {
      const path = writePolicy(configDir(), text);
      const read = readChildPolicy(path);
      expect(read).toEqual({ policy: { ...FAIL_CLOSED_CHILD_POLICY }, warning: "policy-file-invalid" });
      expect(read.policy.catalogFanout).toBe("manual");
      expect(read.policy.updates).toBe("off");
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }

  test("a read error other than ENOENT fails closed", () => {
    const dir = configDir();
    mkdirSync(childPolicyPath(dir), { recursive: true });       // a directory at the path
    expect(readChildPolicy(childPolicyPath(dir))).toEqual({ policy: { ...FAIL_CLOSED_CHILD_POLICY }, warning: "policy-file-invalid" });
  });
});

describe("validPolicyPatch", () => {
  test("accepts each knob alone and refuses any unknown key or value", () => {
    expect(validPolicyPatch({ updates: "notify" })).toEqual({ updates: "notify" });
    expect(validPolicyPatch({ childCodexRestart: "app-server-when-idle", idleAfterMs: 3_600_000 }))
      .toEqual({ childCodexRestart: "app-server-when-idle", idleAfterMs: 3_600_000 });
    expect(validPolicyPatch({ updates: "notify", schema: CHILD_POLICY_SCHEMA })).toBeNull();
    expect(validPolicyPatch({ idleAfterMs: 60_000.5 })).toBeNull();
    expect(validPolicyPatch({ catalogFanout: "AUTO" })).toBeNull();
  });
});

describe("updateChildPolicy", () => {
  test("merges a subset, writes every key and keeps the file private", () => {
    const dir = configDir();
    const path = childPolicyPath(dir);
    expect(updateChildPolicy({ updates: "notify" }, path)).toEqual({ ...DEFAULT_CHILD_POLICY, updates: "notify" });
    updateChildPolicy({ idleAfterMs: 120_000 }, path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({ schema: CHILD_POLICY_SCHEMA, catalogFanout: "auto", childCodexRestart: "never", updates: "notify", idleAfterMs: 120_000 });
    expect(readChildPolicy(path)).toEqual({ policy: { ...DEFAULT_CHILD_POLICY, updates: "notify", idleAfterMs: 120_000 }, warning: null });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "link")).mode & 0o777).toBe(0o700);
    }
  });

  test("a save over an invalid file merges onto the fail-closed policy and clears the warning", () => {
    const dir = configDir();
    const path = writePolicy(dir, "{");
    expect(updateChildPolicy({ catalogFanout: "auto" }, path)).toEqual({ ...FAIL_CLOSED_CHILD_POLICY, catalogFanout: "auto" });
    expect(readChildPolicy(path)).toEqual({ policy: { ...FAIL_CLOSED_CHILD_POLICY, catalogFanout: "auto" }, warning: null });
  });
});
