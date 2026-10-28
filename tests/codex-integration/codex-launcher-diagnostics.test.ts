import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexLaunchEnv, type CodexLaunchEnvDeps } from "../../src/cli/codex-launcher";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";
import { CODEX_TOKEN_REFUSALS, codexTokenWithheldDiagnostic } from "../../src/cli/codex-launch-diagnostics";
import { codexLaunchSystemNamespaceIsSafe } from "../../src/cli/codex-launch-ownership";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { createCodexLaunchFixtureRoot, codexLaunchFixtureHasProtectedAncestors } from "../helpers/codex-launch-private-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const secret = "ocx_fixture_diagnostic_secret", contents = "fixture-key-file-content-never-log";

function capture(base: Record<string, string | undefined>, deps: CodexLaunchEnvDeps) {
  const notes: string[] = [], original = console.error;
  console.error = (...values: unknown[]) => { notes.push(values.join(" ")); };
  try { return { env: buildCodexLaunchEnv(base, deps), notes }; }
  finally { console.error = original; }
}

function diagnostic(notes: string[], reason: string) {
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("automatic service token withheld; " + reason);
  expect(notes[0]).not.toMatch(/[\r\n]/);
  expect(notes[0]).not.toMatch(/powershell|icacls|SetAccessControl|CreateDirectory|Set-Acl|New-Item|\$[a-z]|&\s*\{|[{}]/i);
  for (const forbidden of [secret, contents, "service-api-token", "admin-api-token"]) expect(notes[0]).not.toContain(forbidden);
}

describe("Codex credential withholding diagnostics", () => {
  test("every refusal emits only a value-free explanation without a shell command", () => {
    for (const reason of Object.keys(CODEX_TOKEN_REFUSALS) as (keyof typeof CODEX_TOKEN_REFUSALS)[]) {
      diagnostic([codexTokenWithheldDiagnostic(reason)], CODEX_TOKEN_REFUSALS[reason]);
    }
  });

  for (const [base, deps, reason] of [
    [{}, { args: ["--oss"] }, "arguments are outside the audited allowlist"],
    [{ HTTPS_PROXY: contents }, {}, "environment contains a proxy or unaudited credential control"],
    [{ CODEX_HOME: "" }, {}, "Codex home cannot be resolved unambiguously"],
  ] as const) test(reason, () => {
    let reads = 0;
    const result = capture(base, { routingKind: "opencodex-local", ...deps, serviceToken: () => { reads++; return secret; } });
    diagnostic(result.notes, reason);
    expect(reads).toBe(0);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  });

  test("missing and colliding service credentials have distinct safe reasons", () => {
    for (const [token, extra, reason] of [
      [null, {}, "installation service credential is unavailable or invalid"],
      [secret, { OPENCODEX_ADMIN_AUTH_TOKEN: secret }, "service credential matches a management credential"],
    ] as const) {
      const result = capture({ CODEX_HOME: process.cwd(), ...extra }, { credentialDestination: () => true, serviceToken: () => token });
      diagnostic(result.notes, reason);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    }
  });

  test("explicit credentials and passthrough launches do not warn or read", () => {
    const serviceToken = () => { throw new Error("must not read"); };
    for (const result of [
      capture({ OPENCODEX_API_AUTH_TOKEN: secret }, { args: ["--oss"], serviceToken }),
      capture({}, { routingKind: "native", serviceToken }),
    ]) expect(result.notes).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")("missing or writable Windows namespace always refuses without reading credentials", () => {
    const root = createCodexLaunchFixtureRoot("ocx-namespace-diagnostic-");
    const home = join(root, "codex"), ocx = join(root, "ocx"), machine = join(root, "machine");
    for (const path of [home, ocx, machine]) mkdirSync(path);
    const system = join(machine, "OpenAI", "Codex"), prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
    process.env.OPENCODEX_HOME = ocx;
    process.chdir(root);
    const cfg = { port: 12199, hostname: "0.0.0.0" };
    writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
    writeFileSync(join(home, "config.toml"), 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(cfg.port, cfg)));
    const ps = (script: string) => {
      const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'\n" + script, "utf16le").toString("base64")], {
        env: { ...process.env, OCX_TEST_MACHINE_ROOT: machine, OCX_TEST_NAMESPACE: system }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      expect(result.exitCode).toBe(0);
    };
    const grantCreation = String.raw`$p=$env:OCX_TEST_MACHINE_ROOT
$acl=[System.IO.Directory]::GetAccessControl($p)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::CreateDirectories,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p,$acl)`;
    let reads = 0;
    const launch = () => capture({ CODEX_HOME: home }, {
      credentialDestination: (path, report) => codexCredentialDestinationIsTrusted(path, system, report),
      serviceToken: () => { reads++; return secret; },
    });
    try {
      ps(grantCreation);
      for (const existing of [false, true]) {
        if (existing) ps(String.raw`[System.IO.Directory]::CreateDirectory($env:OCX_TEST_NAMESPACE) | Out-Null
$p=$env:OCX_TEST_NAMESPACE
$acl=[System.IO.Directory]::GetAccessControl($p)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::CreateFiles,[System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.Directory]::SetAccessControl($p,$acl)`);
        let namespaceReason: keyof typeof CODEX_TOKEN_REFUSALS | undefined;
        expect(codexLaunchSystemNamespaceIsSafe(system, reason => { namespaceReason = reason; })).toBe(false);
        expect(namespaceReason).toBe("systemNamespaceWritable");
        // Direct namespace admission exercises this reason even when home
        // admission would stop earlier on an unsafe fixture ancestor.
        const note = codexTokenWithheldDiagnostic(namespaceReason!);
        diagnostic([note], CODEX_TOKEN_REFUSALS.systemNamespaceWritable);
        for (const phrase of ["Default ProgramData creation rights", "must exist", "writable only by Administrators/SYSTEM",
          "opencodex never changes ACLs itself", "OPENCODEX_API_AUTH_TOKEN", "leaves untouched"]) expect(note).toContain(phrase);
        const result = launch();
        diagnostic(result.notes, CODEX_TOKEN_REFUSALS[codexLaunchFixtureHasProtectedAncestors() ? "systemNamespaceWritable" : "ownership"]);
        expect(result.notes[0]).not.toContain(root);
        expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
        expect(reads).toBe(0);
        const explicit = capture({ CODEX_HOME: home, OPENCODEX_API_AUTH_TOKEN: secret }, {
          serviceToken: () => { throw new Error("must not read"); },
        });
        expect(explicit.notes).toEqual([]);
        expect(explicit.env.OPENCODEX_API_AUTH_TOKEN).toBe(secret);
      }
      expect(reads).toBe(0);
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(root);
    }
  });

  test("credential-file missing, malformed and colliding negatives bypass destination ownership", () => {
    const root = createCodexLaunchFixtureRoot("ocx-diagnostic-");
    const home = join(root, "codex"), ocx = join(root, "ocx"), system = join(root, "system");
    for (const path of [home, ocx, system]) mkdirSync(path);
    const cfg = { port: 12199, hostname: "0.0.0.0" }, prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
    process.env.OPENCODEX_HOME = ocx;
    process.chdir(root);
    writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
    try {
      const keyFile = join(ocx, "service-api-token");
      const keyRead = (extra = {}) => capture({ CODEX_HOME: home, ...extra }, { credentialDestination: () => true });
      const missing = keyRead();
      diagnostic(missing.notes, "installation service credential is unavailable or invalid");
      expect(missing.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      writeFileSync(keyFile, contents + "\n" + secret);
      const malformed = keyRead();
      diagnostic(malformed.notes, "installation service credential is unavailable or invalid");
      expect(malformed.notes[0]).not.toContain(keyFile);
      expect(malformed.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      writeFileSync(keyFile, secret + "\n");
      const collision = keyRead({ OPENCODEX_ADMIN_AUTH_TOKEN: secret });
      diagnostic(collision.notes, "service credential matches a management credential");
      expect(collision.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      const loaded = keyRead();
      expect(loaded.notes).toEqual([]);
      expect(loaded.env.OPENCODEX_API_AUTH_TOKEN).toBe(secret);
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(root);
    }
  });

  for (const [name, addition, reason] of [
    ["MCP consumer", (local: string) => local + '\n[mcp_servers.fixture]\ncommand="' + contents + '"\n', "consumers"],
    ["unknown config", (local: string) => 'unknown="' + contents + '"\n' + local, "configShape"],
    ["foreign provider", (local: string) => local.replace("127.0.0.1", "capture.invalid"), "providerTransport"],
    ["malformed config", () => 'broken = "' + contents, "inspection"],
    ["system config", (local: string) => local, "systemConfig"],
  ] as const) test(`${name} mutation always withholds credentials without reading them`, () => {
    const root = createCodexLaunchFixtureRoot("ocx-diagnostic-negative-");
    const home = join(root, "codex"), ocx = join(root, "ocx"), system = join(root, "system");
    for (const path of [home, ocx, system]) mkdirSync(path);
    const cfg = { port: 12199, hostname: "0.0.0.0" }, prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
    process.env.OPENCODEX_HOME = ocx; process.chdir(root);
    const local = 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(cfg.port, cfg));
    writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
    try {
      writeFileSync(join(home, "config.toml"), addition(local));
      if (name === "system config") {
        writeFileSync(join(system, "requirements.toml"), contents);
        let namespaceReason: string | undefined;
        expect(codexLaunchSystemNamespaceIsSafe(system, value => { namespaceReason = value; })).toBe(false);
        expect(namespaceReason).toBe("systemConfig");
      }
      let reads = 0;
      const result = capture({ CODEX_HOME: home }, {
        credentialDestination: (path, report) => codexCredentialDestinationIsTrusted(path, system, report),
        serviceToken: () => { reads++; return secret; },
      });
      // Diagnostic reachability needs protected ancestors; the mutation and
      // no-token/zero-read assertions above and below run on every host.
      diagnostic(result.notes, CODEX_TOKEN_REFUSALS[codexLaunchFixtureHasProtectedAncestors() ? reason : "ownership"]);
      expect(reads).toBe(0);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      expect(result.notes[0]).not.toContain(root);
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(root);
    }
  });
});
