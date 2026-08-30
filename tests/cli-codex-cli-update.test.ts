import { describe, expect, test } from "bun:test";
import { handleCodexCliUpdateCommand, parseCodexCliUpdateArgs } from "../src/cli/codex-cli-update";
import {
  initializeNodeLauncherContext,
  NODE_LAUNCH_CONTEXT_ENV,
  NODE_LAUNCH_PROOF_PREFIX,
} from "../src/cli/launcher-context";
import type { CodexCliInstallProvenanceDeps, CodexCliInstallReport } from "../src/codex/cli-install-provenance";

const report: CodexCliInstallReport = {
  schemaVersion: 1,
  candidateAvailable: false,
  candidateVersion: null,
  candidateSource: null,
  selectionAttested: false,
  versionEvidence: { kind: "unavailable" },
  provenance: "unknown", managed: false, reason: "candidate_unavailable", location: null,
  packageVersion: null,
  shim: { status: "not-tracked", backingKind: null }, evidence: [],
};

describe("Codex CLI update CLI", () => {
  test("parses the shared JSON flag spellings within the exact check grammar", () => {
    expect(parseCodexCliUpdateArgs(["check"])).toEqual({ json: false });
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs(["check", flag])).toEqual({ json: true });
    }
    for (const args of [
      ["check", "--channel", "latest"],
      ["dry-run"],
      ["apply"],
      ["check", "--json", "--json"],
      ["check", "-json", "--json=true"],
    ]) expect(() => parseCodexCliUpdateArgs(args)).toThrow();
  });

  /**
   * `--json` is accepted in any argv position CLI-wide, so automation that puts output
   * flags ahead of the subcommand must not get a usage error.
   */
  test("the JSON flag is accepted before the check action", () => {
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs([flag, "check"])).toEqual({ json: true });
    }
    // Duplicate detection and positional validation still hold in that order.
    expect(() => parseCodexCliUpdateArgs(["--json", "check", "--json"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json", "apply"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json", "check", "extra"])).toThrow();
  });

  test("malformed input performs no inspection", async () => {
    let inspectedCalls = 0;
    const code = await handleCodexCliUpdateCommand(["apply"], {
      inspectInstall: async () => { inspectedCalls += 1; return report; },
    });
    expect(code).toBe(2);
    expect(inspectedCalls).toBe(0);
  });

  test("check inspects exactly once", async () => {
    let inspectedCalls = 0;
    expect(await handleCodexCliUpdateCommand(["check", "--json"], {
      inspectInstall: async () => { inspectedCalls += 1; return report; },
    })).toBe(0);
    expect(inspectedCalls).toBe(1);
  });

  test("passes only proof-bound manager roots into production provenance inspection", async () => {
    const proof = "M".repeat(43);
    const env: NodeJS.ProcessEnv = {
      [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({
        version: 1,
        proof,
        anthropicEnvSlots: [],
        codexCliInspectionEnv: {
          codexCliPath: "C:\\managed\\codex.cmd",
          path: "C:\\managed",
          pathExt: ".CMD",
          managerRoots: { FNM_DIR: "C:\\custom-manager" },
          configDir: "C:\\opencodex",
        },
      }),
    };
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], env);
    let received: CodexCliInstallProvenanceDeps | null = null;
    try {
      expect(await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async deps => {
          received = deps;
          return report;
        },
      })).toBe(0);
      expect(received?.env).toEqual({
        FNM_DIR: "C:\\custom-manager",
        CODEX_CLI_PATH: "C:\\managed\\codex.cmd",
        PATH: "C:\\managed",
        PATHEXT: ".CMD",
      });
      expect(received?.configDir).toBe("C:\\opencodex");
    } finally {
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("a launch without proof passes only sealed inspection dependencies", async () => {
    initializeNodeLauncherContext(["bun", "cli"], {});
    let received: CodexCliInstallProvenanceDeps | null = null;
    try {
      expect(await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async deps => {
          received = deps;
          return report;
        },
      })).toBe(0);
      expect(received?.env).toEqual({ PATH: "" });
      expect(received?.configDir).toBe(".");
    } finally {
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("JSON output serializes only the public report once", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      const code = await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async () => report,
      });
      expect(code).toBe(0);
      expect(logs).toHaveLength(1);
      const output = JSON.parse(logs[0]!) as Record<string, unknown>;
      expect(output).toEqual(report);
      expect(output).toMatchObject({
        candidateAvailable: false,
        candidateVersion: null,
        candidateSource: null,
        selectionAttested: false,
      });
      for (const stale of ["selected", "selectedVersion", "selectionSource", "selectionEvidence"]) {
        expect(stale in output).toBe(false);
      }
      expect(logs[0]).not.toContain("authority");
    } finally {
      console.log = oldLog;
    }
  });

  test("human output uses command-specific scalar lines", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["check"], {
        inspectInstall: async () => report,
      })).toBe(0);
      expect(logs.join("\n")).not.toContain("[object Object]");
      expect(logs).toContain("candidate: no");
      expect(logs).toContain("candidate-source: unavailable");
      expect(logs).toContain("selection-attested: no");
      expect(logs).toContain("candidate-version: unavailable");
      expect(logs).toContain("package-version: unavailable");
      expect(logs).toContain("version-evidence: unavailable");
      expect(logs).toContain("location: unavailable");
      expect(logs).toContain("shim: not-tracked");
    } finally {
      console.log = oldLog;
    }
  });

  test("human output keeps mismatched candidate and package versions distinct", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    const mismatchReport: CodexCliInstallReport = {
      ...report,
      candidateAvailable: true,
      candidateVersion: "1.2.3",
      candidateSource: "persisted",
      versionEvidence: { kind: "advisory-runtime" },
      provenance: "npm-global",
      reason: "version_mismatch",
      location: "<path>/codex",
      packageVersion: "1.2.4",
    };
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["check"], {
        inspectInstall: async () => mismatchReport,
      })).toBe(0);
      expect(logs).toContain("candidate-source: persisted");
      expect(logs).toContain("candidate-version: 1.2.3");
      expect(logs).toContain("package-version: 1.2.4");
      expect(logs).toContain("version-evidence: advisory-runtime");
      expect(logs).toContain("location: <path>/codex");
      expect(logs.some(line => line.startsWith("version: "))).toBe(false);
    } finally {
      console.log = oldLog;
    }
  });
});
