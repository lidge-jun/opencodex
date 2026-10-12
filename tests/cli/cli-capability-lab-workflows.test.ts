import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAB_CAPABILITIES } from "../../src/cli/capabilities-lab";
import { handleLabCommand } from "../../src/cli/lab";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

let home: string;
let previous: Record<string, string | undefined>;
let output: ReturnType<typeof spyOn<typeof console, "log">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cap-lab-"));
  previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = join(home, "codex");
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});
function leaf(key: string) {
  const result = LAB_CAPABILITIES.find(row => row.command.join(" ") === key);
  expect(result).toBeDefined(); return result!;
}

describe("local Lab discovery contracts", () => {
  test("catalog is a local JSON read with no projection or scheduler writes", async () => {
    expect(leaf("lab catalog").routes).toEqual([]);
    expect(leaf("lab catalog").mutates).toBe(false);
    expect(await handleLabCommand(["catalog", "--json"], { configDir: home })).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0][0]));
    expect(Array.isArray(result.scenarios)).toBe(true);
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(readdirSync(home)).toEqual([]);
  });

  test("invalid public evidence emits the failure summary and a nonzero exit", async () => {
    const path = join(home, "invalid.json");
    writeFileSync(path, "{}");
    expect(leaf("lab public verify").usage).toBe("ocx lab public verify --file <bundle.json> [--json]");
    expect(leaf("lab public verify").mutates).toBe(false);
    expect(await handleLabCommand(["public", "verify", "--file", path, "--json"], { configDir: home })).toBe(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ status: "schema_rejected", locallyVerified: false });
    expect(readdirSync(home)).toEqual(["invalid.json"]);
  });

  test.each([
    { key: "lab public import", args: ["public", "import", "--json"] },
    { key: "lab automation enable", args: ["automation", "enable", "--protocol", "--unsupported", "--json"] },
    { key: "lab automation disable", args: ["automation", "disable", "--unsupported", "--json"] },
    { key: "lab run", args: ["run", "--layer", "live_route_compatibility", "--json"] },
  ])("$key rejects incomplete input before local mutation or probes", async ({ key, args }) => {
    expect(leaf(key).mutates).toBe(true); expect(leaf(key).routes).toEqual([]);
    expect(await handleLabCommand(args, { configDir: home })).toBe(2);
    expect(readdirSync(home)).toEqual([]);
    expect(output.mock.calls).toHaveLength(0);
  });

  test("declarations distinguish actual local export/automation from HTTP", async () => {
    const source = await Bun.file(repoPath("src", "cli", "lab.ts")).text();
    for (const declaration of LAB_CAPABILITIES) expect(declaration.routes).toEqual([]);
    expect(source).not.toMatch(/\bruntimeRequest\s*\(/);
    expect(leaf("lab public preview").mutates).toBe(false);
    expect(leaf("lab public export").mutates).toBe(true);
    expect(source).toContain("exportLocalPublicEvidence({ eventIds }, configDir)");
    expect(source).toContain('takeFlag(automationRest, "--live")');
    expect(source).toContain("saveLabAutomationPolicyConfig(policy, configDir)");
    expect(leaf("lab automation enable").flags.find(flag => flag.name === "--live")?.value).toBe("boolean");
    expect(leaf("lab events").flags.find(flag => flag.name === "--excluded")?.value).toBe("string");
    expect(leaf("lab run").flags.find(flag => flag.name === "--scenario")?.required).toBe(true);
  });
});
