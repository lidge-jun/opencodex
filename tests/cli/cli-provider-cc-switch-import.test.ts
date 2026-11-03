import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cmdProviderCcSwitchImport, type CcSwitchImportCommandDeps } from "../../src/cli/provider-cc-switch-import";

const output: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(val => { output.push(String(val)); });
  errorSpy = spyOn(console, "error").mockImplementation(val => { output.push(String(val)); });
});

afterEach(() => {
  output.length = 0;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function makeDeps(calls: unknown[], invalid = 0, eligible = 1): CcSwitchImportCommandDeps {
  return {
    runImport: async options => {
      calls.push(options);
      if (options.mode === "restore") {
        return {
          mode: "restore",
          restored: 1,
          restoredNames: ["acme"],
          alreadyAbsent: 0,
          retainedEdited: 0,
          retainedNames: [],
        };
      }
      const providers = eligible > 0 ? [{
        name: "acme",
        sourceId: "acme",
        appType: "claude",
        adapter: "anthropic",
        baseUrl: "https://api.acme.example",
        defaultModel: "claude-sonnet-4-6",
      }] : [];
      if (options.mode === "apply" && providers.length > 0) {
        options.onBeforeApplyWrite?.(providers);
      }
      return {
        mode: options.mode,
        discovered: eligible + invalid,
        eligible,
        imported: options.mode === "apply" ? eligible : 0,
        conflicts: 0,
        conflictNames: [],
        invalid,
        invalidReasons: invalid > 0 ? { malformed_entry: invalid } : {},
        providers,
      };
    },
  };
}

describe("ocx provider import-cc-switch CLI", () => {
  test("defaults to preview and supports repeatable --provider and --json", async () => {
    const calls: unknown[] = [];
    expect(
      await cmdProviderCcSwitchImport(
        ["--source", "cc-switch.db", "--provider", "p1", "--provider", "p2", "--json"],
        makeDeps(calls),
      ),
    ).toBe(0);
    expect(calls).toEqual([{
      mode: "preview",
      sourcePath: "cc-switch.db",
      selectedProviders: ["p1", "p2"],
      allowPrivateNetwork: false,
    }]);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "preview", eligible: 1, imported: 0 });
  });

  test("dispatches --apply and --restore and rejects invalid flag combinations", async () => {
    const calls: unknown[] = [];
    expect(await cmdProviderCcSwitchImport(["--source", "cc-switch.db", "--apply"], makeDeps(calls))).toBe(0);
    expect(output.join("\n")).toContain("id=acme (source=acme, claude -> anthropic) model=claude-sonnet-4-6 url=https://api.acme.example");
    expect(output.join("\n")).toContain("Keyless provider entries saved");

    output.length = 0;
    const jsonStdout: string[] = [];
    const jsonStderr: string[] = [];
    logSpy.mockImplementation(val => { output.push(String(val)); jsonStdout.push(String(val)); });
    errorSpy.mockImplementation(val => { output.push(String(val)); jsonStderr.push(String(val)); });
    expect(await cmdProviderCcSwitchImport(["--source", "cc-switch.db", "--apply", "--json"], makeDeps(calls))).toBe(0);
    expect(jsonStderr.join("\n")).toContain("id=acme (source=acme, claude -> anthropic) model=claude-sonnet-4-6 url=https://api.acme.example");
    expect(JSON.parse(jsonStdout[0]!)).toMatchObject({ mode: "apply", imported: 1, trustNotice: expect.stringContaining("trusted CC-Switch source") });
    logSpy.mockImplementation(val => { output.push(String(val)); });
    errorSpy.mockImplementation(val => { output.push(String(val)); });

    output.length = 0;
    expect(await cmdProviderCcSwitchImport(["--source", "cc-switch.db", "--apply"], makeDeps(calls, 0, 0))).toBe(0);
    expect(output.join("\n")).toContain("No eligible non-conflicting providers were imported");
    expect(output.join("\n")).not.toContain("Keyless provider entries saved");

    output.length = 0;
    expect(await cmdProviderCcSwitchImport(["--restore", "--json"], makeDeps(calls))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "restore", restored: 1 });

    for (const bad of [
      [],
      ["--apply"],
      ["--restore", "--source", "cc-switch.db"],
      ["--restore", "--apply"],
      ["--source", "a", "--source", "b"],
      ["--source", "a", "--unknown"],
    ]) {
      const badCalls: unknown[] = [];
      expect(await cmdProviderCcSwitchImport(bad, makeDeps(badCalls))).toBe(1);
      expect(badCalls).toHaveLength(0);
    }
  });

  test("redacts unexpected exceptions in JSON and text modes", async () => {
    const throwing: CcSwitchImportCommandDeps = {
      runImport: async () => {
        throw new Error("internal-secret-path-and-token");
      },
    };
    expect(await cmdProviderCcSwitchImport(["--source", "cc-switch.db", "--json"], throwing)).toBe(1);
    expect(output.join("\n")).not.toContain("internal-secret-path-and-token");
    expect(JSON.parse(output[0]!)).toMatchObject({ error: "cc_switch_import_failed" });
  });
});
