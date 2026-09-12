import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cmdOrcaImport, type OrcaImportCommandDeps } from "../../src/cli/account-orca-import";

const output: string[] = [];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
  error = spyOn(console, "error").mockImplementation((value) => { output.push(String(value)); });
});
afterEach(() => { output.length = 0; log.mockRestore(); error.mockRestore(); });

function deps(calls: unknown[], invalid = 0): OrcaImportCommandDeps {
  return { importAccounts: ((options) => {
    calls.push(options);
    return { mode: options.apply ? "apply" : "preview", discovered: 2, eligible: 1, imported: options.apply ? 1 : 0, duplicates: 1, invalid };
  }) as NonNullable<OrcaImportCommandDeps["importAccounts"]> };
}

describe("Orca import command", () => {
  test("defaults to preview and emits only counts in JSON", async () => {
    const calls: unknown[] = [];
    expect(await cmdOrcaImport(["--source", "private-source", "--registry", "private-registry", "--json"], deps(calls))).toBe(0);
    expect(calls).toEqual([{ sourceDir: "private-source", registryPath: "private-registry", apply: false }]);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "preview", imported: 0 });
    expect(output.join()).not.toContain("private-source");
  });
  test("only explicit apply commits and explains validation", async () => {
    const calls: unknown[] = [];
    expect(await cmdOrcaImport(["--source", "source", "--registry", "registry", "--apply"], deps(calls))).toBe(0);
    expect(calls).toEqual([{ sourceDir: "source", registryPath: "registry", apply: true }]);
    expect(output.join()).toContain("validate new accounts");
  });
  test.each([
    { args: [] }, { args: ["--source"] }, { args: ["--source", "--apply"] },
    { args: ["--source", "source", "--apply", "--apply"] },
    { args: ["--source", "source", "--source", "other"] }, { args: ["--source", "source", "secret-extra"] },
    { args: ["--source", "source"] },
    { args: ["--source", "source", "--registry"] },
    { args: ["--source", "source", "--registry", "registry", "--registry", "other"] },
  ])("rejects invalid arguments before reading credentials: %j", async ({ args }) => {
    const calls: unknown[] = [];
    expect(await cmdOrcaImport(args, deps(calls))).toBe(1);
    expect(calls).toHaveLength(0);
    expect(output.join()).not.toContain("secret-extra");
  });
  test("invalid entries produce a nonzero result", async () => {
    expect(await cmdOrcaImport(["--source", "source", "--registry", "registry", "--json"], deps([], 1))).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ invalid: 1 });
  });
  test("never echoes filesystem or parser exceptions", async () => {
    const throwing: OrcaImportCommandDeps = { importAccounts: () => { throw Error("secret-token private-path"); } };
    expect(await cmdOrcaImport(["--source", "source", "--registry", "registry", "--json"], throwing)).toBe(1);
    expect(output).toEqual(['{"error":"orca_import_failed"}']);
  });
  test("does not serialize extra private metadata from an importer result", async () => {
    const withPrivateMetadata: OrcaImportCommandDeps = { importAccounts: () => ({
      mode: "preview", discovered: 0, eligible: 0, imported: 0, duplicates: 0, invalid: 0,
      sourcePath: "private-path", accessToken: "secret-token",
    }) };
    expect(await cmdOrcaImport(["--source", "source", "--registry", "registry", "--json"], withPrivateMetadata)).toBe(0);
    expect(Object.keys(JSON.parse(output[0]!))).toEqual(["mode", "discovered", "eligible", "imported", "duplicates", "invalid"]);
  });
});
