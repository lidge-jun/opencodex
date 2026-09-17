import { describe, expect, test } from "bun:test";
import { handleCodexCliUpdateCommand, parseCodexCliUpdateArgs } from "../../src/cli/codex-cli-update";
import {
  initializeNodeLauncherContext,
  NODE_LAUNCH_CONTEXT_ENV,
  NODE_LAUNCH_PROOF_PREFIX,
} from "../../src/cli/launcher-context";
import type { CodexCliInstallProvenanceDeps, CodexCliInstallReport } from "../../src/codex/cli-install-provenance";
import type { CodexCliInstallationIdentityInput, CodexCliInstallationIdentityReport } from "../../src/codex/cli-installation-identity";

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

const identityInput: CodexCliInstallationIdentityInput = {
  candidate: "C:\\explicit install\\codex.cmd",
  npmPrefix: "C:\\explicit install",
  npmCli: "C:\\tools\\node_modules\\npm\\bin\\npm-cli.js",
  node: "C:\\tools\\node.exe",
};
const attestArgs = [
  "attest", "--candidate", identityInput.candidate, "--npm-prefix", identityInput.npmPrefix,
  "--npm-cli", identityInput.npmCli, "--node", identityInput.node,
];
const identityReport: CodexCliInstallationIdentityReport = {
  schemaVersion: 1, candidateSource: "explicit-cli", status: "observed", reason: "identity_observed",
  installationIdentityObserved: true, selectionAttested: false, managed: false, applyAllowed: false,
  packageVersion: "1.2.3", npmVersion: "11.0.0", identityDigest: "a".repeat(64),
  proof: "windows-handle-bound", toolchain: "observed-only",
};

describe("Codex CLI update CLI", () => {
  test("bare attest selects the proof-bound candidate and forwards the derived input", async () => {
    expect(parseCodexCliUpdateArgs(["attest"])).toEqual({ json: false, attest: "selected" });
    expect(parseCodexCliUpdateArgs(["attest", "--json"])).toEqual({ json: true, attest: "selected" });
    expect(parseCodexCliUpdateArgs(["--json", "attest"])).toEqual({ json: true, attest: "selected" });
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
          managerRoots: {},
          configDir: "C:\\opencodex",
        },
      }),
    };
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], env);
    const logs: string[] = [];
    const oldLog = console.log;
    let snapshot: unknown;
    let received: unknown;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["attest", "--json"], {
        deriveInstallationInput: input => {
          snapshot = input;
          return { kind: "derived", input: { ...identityInput, candidateSource: "selected" as const } };
        },
        inspectIdentity: async input => { received = input; return identityReport; },
      })).toBe(0);
      expect(snapshot).toEqual({
        codexCliPath: "C:\\managed\\codex.cmd",
        path: "C:\\managed",
        pathExt: ".CMD",
      });
      expect(received).toEqual({ ...identityInput, candidateSource: "selected" });
      expect(JSON.parse(logs[0]!)).toEqual(identityReport);
    } finally {
      console.log = oldLog;
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("bare attest without a launch proof reports an unavailable selected candidate", async () => {
    initializeNodeLauncherContext(["bun", "cli"], {});
    const logs: string[] = [];
    const oldLog = console.log;
    let inspectCalls = 0;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["attest", "--json"], {
        deriveInstallationInput: () => ({ kind: "unavailable", reason: "candidate_unavailable" }),
        inspectIdentity: async () => { inspectCalls += 1; return identityReport; },
      })).toBe(0);
      expect(inspectCalls).toBe(0);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        status: "refused",
        reason: "candidate_unavailable",
        candidateSource: "selected",
        installationIdentityObserved: false,
        selectionAttested: false,
        managed: false,
        applyAllowed: false,
      });
    } finally {
      console.log = oldLog;
    }
  });

  test("attest requires all explicit paths and accepts the shared JSON flag positions", () => {
    expect(parseCodexCliUpdateArgs(attestArgs)).toEqual({ json: false, attest: identityInput });
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs([flag, ...attestArgs])).toEqual({ json: true, attest: identityInput });
      expect(parseCodexCliUpdateArgs([...attestArgs, flag])).toEqual({ json: true, attest: identityInput });
    }
  });

  test("malformed attest paths and options fail before either inspector is called", async () => {
    const invalid = [
      attestArgs.slice(0, -2), attestArgs.slice(0, -1),
      [...attestArgs, "--node", identityInput.node], [...attestArgs, "--unknown", "/hidden"],
      [...attestArgs, "extra"], [...attestArgs, "--json", "--json=true"],
      ...["", " ", "relative/codex", "C:codex.cmd", "\\codex.cmd", "--node", "C:\\bad\npath"].map(
        candidate => ["attest", "--candidate", candidate, ...attestArgs.slice(3)],
      ),
    ];
    const oldError = console.error;
    let calls = 0;
    try {
      console.error = () => {};
      for (const args of invalid) {
        expect(await handleCodexCliUpdateCommand(args, {
          inspectInstall: async () => { calls += 1; return report; },
          inspectIdentity: async () => { calls += 1; return identityReport; },
        })).toBe(2);
      }
      expect(calls).toBe(0);
    } finally { console.error = oldError; }
  });

  test("attest passes only explicit input and publishes a redacted observation, not update authority", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    let received: CodexCliInstallationIdentityInput | undefined;
    let checkCalls = 0;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand([...attestArgs, "--json"], {
        inspectInstall: async () => { checkCalls += 1; return report; },
        inspectIdentity: async input => { received = input; return identityReport; },
      })).toBe(0);
      expect(received).toEqual(identityInput);
      expect(checkCalls).toBe(0);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(identityReport);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        installationIdentityObserved: true, selectionAttested: false, managed: false, applyAllowed: false,
      });
      for (const path of Object.values(identityInput)) expect(logs[0]).not.toContain(path);
    } finally { console.log = oldLog; }
  });

  test("attest text states observation limits and preserves refusal without leaking paths", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(attestArgs, { inspectIdentity: async () => identityReport })).toBe(0);
      expect(logs).toContain("selection-attested: no");
      expect(logs).toContain("managed: no");
      expect(logs).toContain("apply-allowed: no");
      expect(logs).toContain("toolchain: observed-only");
      expect(logs).toContain("scope: installation identity only; runtime selection and update ownership are not attested");
      logs.length = 0;
      const refused: CodexCliInstallationIdentityReport = {
        ...identityReport, status: "refused", reason: "package_mismatch", installationIdentityObserved: false,
        packageVersion: null, npmVersion: null, identityDigest: null, proof: null,
      };
      expect(await handleCodexCliUpdateCommand([...attestArgs, "--json"], { inspectIdentity: async () => refused })).toBe(0);
      expect(JSON.parse(logs[0]!)).toEqual(refused);
    } finally { console.log = oldLog; }
  });

  test("unexpected attest errors do not publish native errors containing explicit paths", async () => {
    const errors: string[] = [];
    const oldError = console.error;
    try {
      console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(attestArgs, {
        inspectIdentity: async () => { throw new Error(`Cannot read ${identityInput.node}`); },
      })).toBe(1);
      expect(errors.join("\n")).toContain("Installation identity inspection failed");
      expect(errors.join("\n")).not.toContain(identityInput.node);
    } finally { console.error = oldError; }
  });

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
