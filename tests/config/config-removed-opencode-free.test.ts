import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { configDiagnosticsFromRaw, readConfigAdmissionSnapshot, readConfigDiagnostics } from "../../src/config/diagnostics";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { buildClaudeReplayConfig } from "../../src/server/claude-messages";
import { parseRequest } from "../../src/responses/parser";
import { planVisionSidecar, shouldResolveOpenAiVisionSidecar } from "../../src/vision/plan";
import { planWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../src/web-search";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";
import { runPassiveRead } from "../../src/lib/passive-read";
import { atomicWriteFileNoFollow } from "../../src/config/atomic-write";
import { join } from "node:path";
import { hardenSecretPath, hardenSecretPathAsync, resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, verifySecretPathAcl } from "../../src/lib/windows-secret-acl";
import { setWindowsOwnerAclRunnerForTests, verifyWindowsPrivateEntries, verifyWindowsPrivateEntriesAsync, windowsPrivateEntriesAclMatches } from "../../src/lib/windows-owner-acl";
import { resetWindowsPrincipalForTests, setWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";

test("retired OpenCode Free entries warn once on load and an unrelated save persists their removal", () => {
  const home = createTempHome("ocx-removed-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const provider = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", keyOptional: true };
    const raw = {
      ...getDefaultConfig(),
      defaultProvider: "opencode-free",
      providers: {
        "opencode-free": provider,
        typed: { ...provider, type: "opencode-free" },
        adapter: { ...provider, adapter: "opencode-free" },
        nestedPreset: { ...provider, preset: { id: "opencode-free" } },
        preset: { ...provider, presetId: "opencode-free" },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "keep", note: "opencode-free" },
      },
      combos: {
        mixed: { targets: [{ provider: "opencode-free", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { targets: [{ provider: "typed", model: "big-pickle" }] },
        dependentJudge: { strategy: "jev", decisionModel: "combo/judge", targets: [{ provider: "healthy", model: "keep" }] },
        judge: { strategy: "jev", decisionModel: "opencode-free/big-pickle", targets: [{ provider: "healthy", model: "keep" }] },
      },
      routingProfiles: {
        mixed: { candidates: [{ provider: "preset", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { candidates: [{ provider: "opencode-free", model: "big-pickle" }] },
      },
      subagentModels: ["opencode-free/big-pickle", "healthy/keep"],
      subagentModelFallback: ["typed/big-pickle", "combo/retired", "policy/retired", "healthy/keep"],
      subagentModelFallbackByModel: { "opencode-free/big-pickle": ["healthy/keep"], "healthy/keep": ["preset/big-pickle", "healthy/keep"], "healthy/empty": ["preset/big-pickle"] },
      claudeCode: { enabled: false, subagentModelForce: "opencode-free/big-pickle", model: "opencode-free/big-pickle", tierModels: { opus: "healthy/keep" } },
      modelPickerOrder: ["opencode-free/big-pickle", "healthy/keep"],
    };
    const bytes = "\uFEFF" + JSON.stringify(raw, null, 2) + "\r\n";
    writeFileSync(getConfigPath(), bytes, "utf8");
    const loaded = loadConfig();
    expect(Object.keys(loaded.providers).sort()).toEqual(["healthy", "openai"]);
    expect(loaded.defaultProvider).toBe("openai");
    expect(loaded.providers.healthy.defaultModel).toBe("keep");
    expect(loaded.providers.healthy.note).toBe("opencode-free");
    expect(loaded.combos).toEqual({ mixed: { targets: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.routingProfiles).toEqual({ mixed: { candidates: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.subagentModels).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallback).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallbackByModel).toEqual({ "healthy/keep": ["healthy/keep"] });
    expect(loaded.claudeCode?.subagentModelForce).toBeUndefined();
    expect(loaded.claudeCode?.model).toBeUndefined();
    expect(loaded.claudeCode?.tierModels).toEqual({ opus: "healthy/keep" });
    expect(loaded.modelPickerOrder).toEqual(["healthy/keep"]);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(() => loadConfig()).not.toThrow();
    expect(readConfigDiagnostics().config.providers).toEqual(loaded.providers);
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes("opencode-free support was removed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain("403");
    expect(warnings[0]![0]).toContain("#7255");
    expect(warnings[0]![0]).toContain("opencode-go");
    expect(warnings[0]![0]).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "opencode-free")).toBe(false);
    const outcome = mutatePersistedConfig(config => {
      config.port = 19876;
      return { changed: true, value: undefined };
    });
    expect(outcome.status).toBe("committed");
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(persisted.port).toBe(19876);
    expect(persisted.providers["opencode-free"]).toBeUndefined();
    expect(Object.keys(persisted.providers).sort()).toEqual(["healthy", "openai"]);
    expect(persisted.providers.healthy).toEqual(loaded.providers.healthy);
    expect(persisted.subagentModels).toEqual(["healthy/keep"]);
    expect(warnings[0]![0]).toContain("next configuration save removes them from config.json");
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    expect(warnings[0]![0]).toContain("the original file was saved to");
    expect(warnings[0]![0]).toContain("config.json.pre-opencode-free-removal.bak");
    expect(warnings[0]![0]).toContain("restore by copying it back over config.json");
    // A later retired config must retain the first recovery point, even after another save.
    writeFileSync(getConfigPath(), bytes + "\n");
    loadConfig();
    expect(mutatePersistedConfig(config => {
      config.port = 10101;
      return { changed: true, value: undefined };
    }).status).toBe("committed");
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
  } finally { warn.mockRestore(); home.remove(); }
});

test.each(["diagnostics", "admission"])("%s disk reads preserve original retired bytes before a mutation", reader => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    const diagnostics = reader === "diagnostics" ? readConfigDiagnostics() : readConfigAdmissionSnapshot().diagnostics;
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.providers["opencode-free"]).toBeUndefined();
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
  });
});

test.skipIf(process.platform === "win32")("retirement backup is owner-only on POSIX", () => {
  withLegacyConfig({}, () => {
    loadConfig();
    expect(statSync(`${getConfigPath()}.pre-opencode-free-removal.bak`).mode & 0o777).toBe(0o600);
  });
});

test("healthy config and imported retired text create no recovery copy", () => {
  const home = createTempHome("ocx-no-retired-backup-");
  try {
    writeFileSync(getConfigPath(), JSON.stringify(getDefaultConfig()));
    configDiagnosticsFromRaw(JSON.stringify({ ...getDefaultConfig(), providers: { "opencode-free": {} } }));
    loadConfig();
    readConfigDiagnostics();
    expect(mutatePersistedConfig(config => {
      config.port = 10101;
      return { changed: true, value: undefined };
    }).status).toBe("committed");
    expect(existsSync(`${getConfigPath()}.pre-opencode-free-removal.bak`)).toBe(false);
  } finally { home.remove(); }
});

test("an occupied backup name never crashes loading or overwrites the occupant", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    mkdirSync(backup);
    expect(loadConfig().providers["opencode-free"]).toBeUndefined();
    expect(readConfigDiagnostics().source).toBe("file");
    expect(statSync(backup).isDirectory()).toBe(true);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
});

test("a failed recovery copy warns without exposing paths or secret bytes", () => {
  const home = createTempHome("ocx-failed-retirement-backup-");
  try {
    const path = getConfigPath();
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const script = `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs }; mock.module('node:fs', () => ({ ...real, linkSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }));
      const { preserveRemovedOpenCodeFree } = await import(${JSON.stringify(module)});
      preserveRemovedOpenCodeFree(${JSON.stringify(path)}, Buffer.from("synthetic-secret-must-not-be-logged"));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    const output = child.stdout.toString() + child.stderr.toString();
    expect(output).toContain("copy config.json now if you need the old entry");
    expect(output).toContain("no recovery copy was made");
    expect(output).not.toContain("the original file was saved to");
    expect(output).not.toContain(path);
    expect(output).not.toContain("synthetic-secret-must-not-be-logged");
  } finally { home.remove(); }
});

function withLegacyConfig(patch: Record<string, unknown>, check: (bytes: string) => void): void {
  const home = createTempHome("ocx-removed-references-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = JSON.stringify({
      ...getDefaultConfig(), defaultProvider: "healthy",
      providers: {
        "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      ...patch,
    });
    writeFileSync(getConfigPath(), bytes);
    check(bytes);
  } finally { warn.mockRestore(); home.remove(); }
}

test.each(["file", "directory"])("an unrelated %s at the recovery name gets an exclusive sibling", kind => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    if (kind === "file") writeFileSync(backup, "unrelated occupant");
    else mkdirSync(backup);
    loadConfig();
    readConfigDiagnostics();
    const siblings = readdirSync(process.env.OPENCODEX_HOME!).filter(name => /\.pre-opencode-free-removal\..+\.bak$/.test(name));
    expect(siblings).toHaveLength(1);
    expect(readFileSync(`${process.env.OPENCODEX_HOME}/${siblings[0]}`)).toEqual(Buffer.from(bytes));
    if (kind === "file") expect(readFileSync(backup, "utf8")).toBe("unrelated occupant");
    else expect(statSync(backup).isDirectory()).toBe(true);
  });
});

test("an identical original recovery copy is reused without another sibling", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    atomicWriteFileNoFollow(backup, bytes, undefined, {}, { exclusive: true });
    const protection = recoveryProtection(backup);
    loadConfig();
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    expect(recoveryProtection(backup)).toEqual(protection);
    expect(readdirSync(process.env.OPENCODEX_HOME!).filter(name => name.endsWith(".bak"))).toHaveLength(1);
  });
});

test.skipIf(process.platform !== "win32")("explicit SYSTEM and Administrators grants survive hardening and permit recovery reuse", async () => {
  const home = createTempHome("ocx-recovery-privileged-");
  const previousVerify = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = JSON.stringify({ ...getDefaultConfig(), providers: { "opencode-free": {} } });
    writeFileSync(getConfigPath(), bytes);
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    atomicWriteFileNoFollow(backup, bytes, undefined, {}, { exclusive: true });
    const icacls = join(process.env.SystemRoot!, "System32", "icacls.exe");
    expect(Bun.spawnSync([icacls, backup, "/grant:r", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"]).exitCode).toBe(0);
    resetHardenedStateForTests();
    expect(hardenSecretPath(backup, { required: true }).ok).toBe(true);
    const before = Bun.spawnSync([icacls, backup]).stdout.toString();
    expect(verifySecretPathAcl(backup)).toBe(true);
    process.env.OPENCODEX_ACL_VERIFY_EXISTING = "1";
    const calls: string[][] = [];
    const probe = (args: string[]) => {
      calls.push(args);
      return { success: true, exitCode: 0, timedOut: false, stdout: before };
    };
    setIcaclsRunnerForTests(probe);
    setAsyncIcaclsRunnerForTests(async args => probe(args));
    resetHardenedStateForTests();
    expect(hardenSecretPath(backup, { required: true }).ok).toBe(true);
    resetHardenedStateForTests();
    expect((await hardenSecretPathAsync(backup, { required: true })).ok).toBe(true);
    expect(calls).toEqual([[backup], [backup]]);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    expect(Bun.spawnSync([icacls, backup]).stdout.toString()).toBe(before);
    loadConfig();
    readConfigDiagnostics();
    expect(readdirSync(home.root).filter(name => name.endsWith(".bak"))).toHaveLength(1);
    expect(Bun.spawnSync([icacls, backup]).stdout.toString()).toBe(before);
    for (const sid of ["S-1-1-0", "S-1-5-32-545"]) {
      expect(Bun.spawnSync([icacls, backup, "/grant:r", `*${sid}:(R)`]).exitCode).toBe(0);
      expect(verifySecretPathAcl(backup)).toBe(false);
      expect(await verifyWindowsPrivateEntriesAsync([{ path: backup, directory: false }], 5_000)).toBe(false);
      expect(Bun.spawnSync([icacls, backup, "/remove:g", `*${sid}`]).exitCode).toBe(0);
    }
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousVerify === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
    else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousVerify;
    resetHardenedStateForTests();
    warn.mockRestore(); home.remove();
  }
});

test.skipIf(process.platform !== "win32")("a single-ACE unprotected recovery is preserved and gets a protected sibling", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    writeFileSync(backup, bytes);
    // A non-inheritable parent ACE keeps the file at exactly one explicit ACE.
    const script = String.raw`
      $ErrorActionPreference='Stop'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      $parent=[Environment]::GetEnvironmentVariable('OCX_TEST_ACL_PARENT')
      $file=[Environment]::GetEnvironmentVariable('OCX_TEST_ACL_FILE')
      $d=[Security.AccessControl.DirectorySecurity]::new()
      $d.SetOwner($sid)
      $d.SetAccessRuleProtection($true,$false)
      $d.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
      [IO.Directory]::SetAccessControl($parent,$d)
      $f=[Security.AccessControl.FileSecurity]::new()
      $f.SetOwner($sid)
      $f.SetAccessRuleProtection($false,$false)
      $f.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
      [IO.File]::SetAccessControl($file,$f)
      $read=[Security.AccessControl.FileSecurity]::new($file,[Security.AccessControl.AccessControlSections]'Owner,Group,Access')
      [Console]::WriteLine(('protected={0};aceCount={1}' -f $read.AreAccessRulesProtected,$read.Access.Count))
    `;
    const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const setup = Bun.spawnSync([ps, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, OCX_TEST_ACL_PARENT: process.env.OPENCODEX_HOME!, OCX_TEST_ACL_FILE: backup },
      timeout: 5_000, windowsHide: true,
    });
    expect(setup.exitCode).toBe(0);
    expect(setup.stdout.toString().trim()).toBe("protected=False;aceCount=1");
    const icacls = join(process.env.SystemRoot!, "System32/icacls.exe");
    const before = Bun.spawnSync([icacls, backup]);
    expect(before.exitCode).toBe(0);
    expect(verifyWindowsPrivateEntries([{ path: backup, directory: false }], 5_000)).toBe(false);
    loadConfig();
    const copies = readdirSync(process.env.OPENCODEX_HOME!).filter(name => name.endsWith(".bak"));
    expect(copies).toHaveLength(2);
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    expect(Bun.spawnSync([icacls, backup]).stdout).toEqual(before.stdout);
    expect(verifySecretPathAcl(backup)).toBe(false);
    expect(verifyWindowsPrivateEntries([{ path: backup, directory: false }], 5_000)).toBe(false);
    const sibling = join(process.env.OPENCODEX_HOME!, copies.find(name => name !== "config.json.pre-opencode-free-removal.bak")!);
    expect(readFileSync(sibling)).toEqual(Buffer.from(bytes));
    expect(verifyWindowsPrivateEntries([{ path: sibling, directory: false }], 5_000)).toBe(true);
  });
});

test.skipIf(process.platform !== "win32")("recovery verifier rejects a disallowed owner behind one user Full Control ACE", () => {
  const user = "S-1-5-21-111-222-333-1001";
  const name = "EXAMPLE\\Owner";
  const target = "synthetic-recovery.bak";
  const entries = [{ path: target, directory: false }];
  resetWindowsPrincipalForTests();
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${user}\n${name}\n` }));
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${target} ${name}:(F)\r\n` }));
  try {
    // The same production parser seam covers owners without requiring Windows elevation in CI.
    for (const owner of ["S-1-5-32-544", "S-1-5-32-545", "S-1-5-21-111-222-333-1002"]) {
      const stdout = `U|${user}|${user}|False\nE|0|${owner}|4100|1\nA|0|0|0|2032127|${user}|False\nEND\n`;
      expect(windowsPrivateEntriesAclMatches(stdout, entries)).toBe(false);
      setWindowsOwnerAclRunnerForTests(() => ({ success: true, timedOut: false, stdout }));
      expect(verifySecretPathAcl(target)).toBe(false);
    }
    const stdout = `U|${user}|${user}|False\nE|0|${user}|4100|1\nA|0|0|0|2032127|${user}|False\nEND\n`;
    setWindowsOwnerAclRunnerForTests(() => ({ success: true, timedOut: false, stdout }));
    expect(verifySecretPathAcl(target)).toBe(true);
  } finally {
    setWindowsOwnerAclRunnerForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
  }
});

function recoveryProtection(path: string): string | number {
  if (process.platform !== "win32") {
    const entry = statSync(path);
    expect(entry.uid).toBe(process.getuid!());
    expect(entry.mode & 0o7777).toBe(0o600);
    return entry.mode & 0o7777;
  }
  const acl = Bun.spawnSync([join(process.env.SystemRoot!, "System32", "icacls.exe"), path]);
  expect(acl.exitCode).toBe(0);
  expect(verifySecretPathAcl(path)).toBe(true);
  return acl.stdout.toString();
}

test("an identical recovery with broad permissions is preserved and gets a protected sibling", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    atomicWriteFileNoFollow(backup, bytes, undefined, {}, { exclusive: true });
    let priorAcl = "";
    const icacls = join(process.env.SystemRoot ?? "", "System32", "icacls.exe");
    if (process.platform === "win32") {
      expect(Bun.spawnSync([icacls, backup, "/grant", "*S-1-1-0:(R)"]).exitCode).toBe(0);
      expect(verifySecretPathAcl(backup)).toBe(false);
      priorAcl = Bun.spawnSync([icacls, backup]).stdout.toString();
    } else chmodSync(backup, 0o644);
    loadConfig();
    readConfigDiagnostics();
    const copies = readdirSync(process.env.OPENCODEX_HOME!).filter(name => name.endsWith(".bak"));
    expect(copies).toHaveLength(2);
    const sibling = copies.find(name => name !== "config.json.pre-opencode-free-removal.bak")!;
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, sibling))).toEqual(Buffer.from(bytes));
    recoveryProtection(join(process.env.OPENCODEX_HOME!, sibling));
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    if (process.platform === "win32") expect(Bun.spawnSync([icacls, backup]).stdout.toString()).toBe(priorAcl);
    else expect(statSync(backup).mode & 0o7777).toBe(0o644);
  });
});

test.each(["compliant", "broad", "unverifiable"])("recovery reuse checks the existing Windows ACL: %s", policy => {
  const home = createTempHome("ocx-recovery-acl-probe-");
  try {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    atomicWriteFileNoFollow(backup, "original", undefined, {}, { exclusive: true });
    const module = (path: string) => pathToFileURL(repoPath(path)).href;
    const script = `import { setPlatformForTests, setIcaclsRunnerForTests } from ${JSON.stringify(module("src/lib/windows-secret-acl.ts"))};
      import { setWindowsOwnerAclRunnerForTests } from ${JSON.stringify(module("src/lib/windows-owner-acl.ts"))};
      import { setWindowsPrincipalRunnerForTests } from ${JSON.stringify(module("src/lib/windows-user-principal.ts"))};
      import { preserveRemovedOpenCodeFree } from ${JSON.stringify(module("src/config/removed-opencode-free-backup.ts"))};
      setPlatformForTests('win32');
      setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: 'S-1-5-21-9-9-9-1001\\r\\nTESTHOST\\\\tester' }));
      const probes = [], commands = [];
      setWindowsOwnerAclRunnerForTests((entries, timeoutMs) => {
        probes.push({ entries, timeoutMs });
        const policy = ${JSON.stringify(policy)};
        const user = 'S-1-5-21-9-9-9-1001';
        const stdout = 'U|' + user + '|' + user + '|False\\nE|0|' + user + '|4100|' + (policy === 'broad' ? 2 : 1)
          + '\\nA|0|0|0|2032127|' + user + '|False\\n' + (policy === 'broad' ? 'A|0|0|0|1179785|S-1-1-0|False\\n' : '') + 'END\\n';
        return { success: policy !== 'unverifiable', timedOut: false, stdout };
      });
      setIcaclsRunnerForTests(args => {
        if (args[0] === ${JSON.stringify(backup)}) commands.push(args);
        return { success: true, exitCode: 0, timedOut: false, stdout: '' };
      });
      preserveRemovedOpenCodeFree(${JSON.stringify(getConfigPath())}, Buffer.from('original'));
      console.log(JSON.stringify({ probes, commands }));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    const { probes, commands } = JSON.parse(child.stdout.toString()) as {
      probes: { entries: { path: string; directory: boolean }[]; timeoutMs: number }[]; commands: string[][];
    };
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(probe => probe.entries.length === 1 && probe.entries[0]!.path === backup && !probe.entries[0]!.directory)).toBe(true);
    expect(probes.every(probe => probe.timeoutMs > 0 && probe.timeoutMs <= 5_000)).toBe(true);
    expect(commands).toEqual([]); // Reuse inspection never hardens the occupied recovery name.
    expect(readdirSync(home.root).filter(name => name.endsWith(".bak"))).toHaveLength(policy === "compliant" ? 1 : 2);
    expect(readFileSync(backup, "utf8")).toBe("original");
  } finally { home.remove(); }
});

test("a recovery that remains multiply linked is never certified", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    atomicWriteFileNoFollow(backup, bytes, undefined, {}, { exclusive: true });
    linkSync(backup, join(process.env.OPENCODEX_HOME!, "foreign-link"));
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {});
    try {
      loadConfig();
      expect(sleep.mock.calls.length).toBeGreaterThan(0);
      expect(sleep.mock.calls.length).toBeLessThanOrEqual(9);
      expect(sleep.mock.calls.every(([delay]) => delay === 10)).toBe(true);
    } finally { sleep.mockRestore(); }
    expect(statSync(backup).nlink).toBe(2);
    const copies = readdirSync(process.env.OPENCODEX_HOME!).filter(name => name.endsWith(".bak"));
    expect(copies).toHaveLength(2);
    const sibling = copies.find(name => name !== "config.json.pre-opencode-free-removal.bak")!;
    recoveryProtection(join(process.env.OPENCODEX_HOME!, sibling));
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, sibling))).toEqual(Buffer.from(bytes));
  });
});

test.each([5, 500])("overlapping loads preserve protected originals with a %i ms publisher delay", async delay => {
  const home = createTempHome("ocx-recovery-overlap-");
  const ready = home.path("publisher-ready");
  const release = home.path("publisher-release");
  const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
  const module = pathToFileURL(repoPath("src/config.ts")).href;
  const bytes = Buffer.from(JSON.stringify({ ...getDefaultConfig(), providers: { "opencode-free": {} } }));
  writeFileSync(getConfigPath(), bytes);
  const firstScript = `import { mock } from 'bun:test'; import * as fs from 'node:fs';
    const real = {...fs}; let paused = false;
    mock.module('node:fs', () => ({...real, linkSync(source, target) {
      real.linkSync(source, target);
      if (!paused && target === ${JSON.stringify(backup)}) {
        paused = true; real.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const until = Date.now() + 20000;
        while (!real.existsSync(${JSON.stringify(release)})) {
          if (Date.now() >= until) throw new Error('publisher release timed out');
          Bun.sleepSync(5);
        }
        Bun.sleepSync(${delay});
      }
    }})); const { loadConfig } = await import(${JSON.stringify(module)});
    if (loadConfig().providers['opencode-free']) throw new Error('retired provider retained');`;
  const first = Bun.spawn([process.execPath, "--eval", firstScript], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const until = Date.now() + 15000;
    while (!existsSync(ready) && Date.now() < until) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    expect(statSync(backup).nlink).toBe(2);
    // Start the finite publisher delay at the first recheck. Keep real bounded
    // sleeps: waiting for unlink here would hide exhaustion of the retry budget.
    const secondScript = `import * as fs from 'node:fs'; const sleep = Bun.sleepSync; let retries = 0;
      Bun.sleepSync = ms => {
        if (ms !== 10 || ++retries > 9) throw new Error('unbounded recovery recheck');
        if (retries === 1) fs.writeFileSync(${JSON.stringify(release)}, 'release');
        sleep(ms);
      }; const { loadConfig } = await import(${JSON.stringify(module)});
      if (loadConfig().providers['opencode-free']) throw new Error('retired provider retained');
      if (retries === 0 || (${delay} === 500 && retries !== 9)) throw new Error('overlap schedule missed');`;
    second = Bun.spawn([process.execPath, "--eval", secondScript], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
    expect(await second.exited).toBe(0);
    writeFileSync(release, "release");
    expect(await first.exited).toBe(0);
    const copies = readdirSync(home.root).filter(name => /^config\.json\.pre-opencode-free-removal(?:\..+)?\.bak$/.test(name));
    if (delay === 5) expect(copies).toHaveLength(1);
    else {
      expect(copies.length).toBeGreaterThanOrEqual(1);
      expect(copies.length).toBeLessThanOrEqual(2);
    }
    expect(readdirSync(home.root).filter(name => name.endsWith(".tmp"))).toEqual([]);
    for (const name of copies) {
      const path = home.path(name);
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path).nlink).toBe(1);
      recoveryProtection(path);
    }
    for (const child of [first, second]) {
      const output = await new Response(child.stderr).text();
      const notices = output.split("\n").filter(line => line.includes("the original file was saved to"));
      expect(notices).toHaveLength(1);
      const name = notices[0]!.match(/config\.json\.pre-opencode-free-removal(?:\.[\w-]+)?\.bak/)?.[0];
      expect(name).toBeDefined();
      expect(copies).toContain(name!);
      expect(existsSync(home.path(name!))).toBe(true);
    }
  } finally {
    writeFileSync(release, "release");
    await first.exited;
    if (second) await second.exited;
    home.remove();
  }
}, 60000);

test.each(["saveConfig", "saveConfigPreservingClaudeCode"])("late retired disk edits are preserved byte for byte by %s", writer => {
  const home = createTempHome("ocx-late-retired-");
  try {
    // A fresh process makes the once-per-process notice independent of earlier tests.
    const module = pathToFileURL(repoPath("src/config.ts")).href;
    const generation = pathToFileURL(repoPath("src/local-credentials/generation.ts")).href;
    const script = `import { strict as assert } from 'node:assert';
      import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
      import { armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig, ${writer} as save } from ${JSON.stringify(module)};
      import { readCredentialGeneration } from ${JSON.stringify(generation)};
      const path = getConfigPath();
      writeFileSync(path, JSON.stringify(getDefaultConfig()));
      const live = loadConfig();
      armClaudeCodeBaseline(live);
      const original = getDefaultConfig();
      original.providers['opencode-free'] = {
        apiKey: 'keychain:synthetic-late-retired-account', baseUrl: 'https://example.test/v1',
        apiKeyPool: [{ key: 'gcp-sa:synthetic-late-retired-pool' }],
        unknownField: 'synthetic-preserved-value',
      };
      const raw = Buffer.from('\\uFEFF' + JSON.stringify(original, null, 2) + '\\r\\n');
      const backup = path + '.pre-opencode-free-removal.bak';
      assert.equal(existsSync(backup), false);
      for (const port of [10101, 10102]) {
        writeFileSync(path, raw);
        live.port = port;
        save(live);
        const persisted = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(persisted.port, port);
        assert.equal(persisted.providers['opencode-free'], undefined);
        assert.deepEqual(persisted.providers, live.providers);
        assert.equal(existsSync(backup), true, 'late retired snapshot needs a recovery copy');
        assert.deepEqual(readFileSync(backup), raw);
        assert.deepEqual(readCredentialGeneration().keyAccounts.sort(),
          ['synthetic-late-retired-account', 'synthetic-late-retired-pool']);
      }
      assert.equal(readdirSync(process.env.OPENCODEX_HOME).filter(name => name.endsWith('.bak')).length, 1);`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env }, timeout: 30_000 });
    expect(child.stderr.toString()).not.toContain("AssertionError");
    expect(child.exitCode).toBe(0);
    const notices = child.stderr.toString().split("\n").filter(line => line.includes("opencode-free support was removed"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("the original file was saved to");
    expect(notices[0]).toContain("restore by copying it back over config.json");
    recoveryProtection(`${getConfigPath()}.pre-opencode-free-removal.bak`);
  } finally { home.remove(); }
}, 60_000);

test.each(["loader", "diagnostics", "admission"])("passive %s projects retired data without files or notices", async reader => {
  const home = createTempHome("ocx-passive-retired-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(), defaultProvider: "openai", providers: { ...getDefaultConfig().providers, "opencode-free": {} } }));
    const before = readdirSync(home.root);
    const metadata = statSync(getConfigPath(), { bigint: true });
    await runPassiveRead(async () => {
      const config = reader === "loader" ? loadConfig() : reader === "diagnostics" ? readConfigDiagnostics().config : readConfigAdmissionSnapshot().diagnostics.config;
      expect(config.providers["opencode-free"]).toBeUndefined();
    });
    expect(readdirSync(home.root)).toEqual(before);
    expect(statSync(getConfigPath(), { bigint: true }).ctimeNs).toBe(metadata.ctimeNs);
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); home.remove(); }
});

test("successful recovery notices redact a secret-shaped home and retain the filename", () => {
  const home = createTempHome("ocx-sk-syntheticOnly7800-");
  try {
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `import { preserveRemovedOpenCodeFree } from ${JSON.stringify(module)};
      preserveRemovedOpenCodeFree(${JSON.stringify(getConfigPath())}, Buffer.from("synthetic-original"));`], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    const output = child.stderr.toString();
    expect(output).toContain("config.json.pre-opencode-free-removal.bak");
    expect(output).not.toContain("sk-syntheticOnly7800");
  } finally { home.remove(); }
});

test("a substituted empty recovery temp never receives original secret bytes", () => {
  const home = createTempHome("ocx-recovery-substitution-");
  try {
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const script = `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs }; let stolen;
      mock.module('node:fs', () => ({ ...real, openSync(path, flags, mode) {
        const fd = real.openSync(path, flags, mode);
        if (!stolen && flags === 'wx') {
          stolen = path + '.stolen'; real.renameSync(path, stolen); real.writeFileSync(path, 'replacement');
        } return fd;
      }}));
      const { preserveRemovedOpenCodeFree } = await import(${JSON.stringify(module)});
      preserveRemovedOpenCodeFree(${JSON.stringify(getConfigPath())}, Buffer.from('SYNTHETIC-7800-SECRET'));
      console.log(JSON.stringify({ swapped: !!stolen, leaked: !!stolen && real.readFileSync(stolen).includes(Buffer.from('SYNTHETIC-7800-SECRET')) }));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ swapped: true, leaked: false });
    expect(child.stderr.toString()).toContain("copy config.json now");
  } finally { home.remove(); }
});

test("retired desktop assignments repair defaults without losing healthy profile state", () => {
  const desktopProfile = {
    version: 1,
    assignments: {
      "opencode-free/opus": { family: "opus", alias: "claude-opus-4-8-20260101" },
      "opencode-free/fable": { family: "fable", alias: "claude-opus-4-8-20260102" },
      "opencode-free/haiku": { family: "haiku", alias: "claude-opus-4-8-20260103" },
      "healthy/z": { family: "opus", alias: "claude-opus-4-8-20260104" },
      "healthy/a": { family: "opus", alias: "claude-opus-4-8-20260105" },
      "healthy/sonnet": { family: "sonnet", alias: "claude-opus-4-8-20260106" },
      "healthy/haiku": { family: "haiku", alias: "claude-opus-4-8-20260107" },
    },
    defaults: { opus: "opencode-free/opus", fable: "opencode-free/fable", sonnet: "healthy/sonnet", haiku: "opencode-free/haiku" },
    appliedFingerprint: "preserved-marker", appliedAt: "2026-10-19T00:00:00Z",
  };
  withLegacyConfig({ claudeCode: { enabled: false, desktopProfile } }, bytes => {
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    const expected = {
      ...desktopProfile,
      assignments: Object.fromEntries(Object.entries(desktopProfile.assignments).filter(([route]) => route.startsWith("healthy/"))),
      defaults: { opus: "healthy/a", fable: null, sonnet: "healthy/sonnet", haiku: "healthy/haiku" },
    };
    expect(diagnostics.config.claudeCode?.desktopProfile).toEqual(expected);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(expected);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
});

test.each([false, true])("unrelated saves cannot resurrect retired Claude routes (healthy disk edit: %s)", diskEdit => {
  withLegacyConfig({ claudeCode: {
    enabled: false, model: "opencode-free/old", subagentModelForce: "retired-alias/old",
    tierModels: { opus: "healthy/keep" },
  } }, bytes => {
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    expect(live.claudeCode?.model).toBeUndefined();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    if (diskEdit) {
      const raw = JSON.parse(bytes);
      raw.claudeCode.tierModels.sonnet = "healthy/edited";
      writeFileSync(getConfigPath(), JSON.stringify(raw));
    }
    for (const fastMode of [true, false]) {
      live.fastMode = fastMode;
      saveConfigPreservingClaudeCode(live);
      expect(live.claudeCode?.model).toBeUndefined();
      expect(live.claudeCode?.subagentModelForce).toBeUndefined();
      expect(live.claudeCode?.tierModels).toEqual({ opus: "healthy/keep", ...(diskEdit ? { sonnet: "healthy/edited" } : {}) });
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted.claudeCode).toEqual(live.claudeCode);
      expect(persisted.fastMode).toBe(fastMode);
      expect(persisted.providers["opencode-free"]).toBeUndefined();
    }
  });
});

test.each([false, true])("retired source allowlists and injection dependencies load without degradation (mixed: %s)", mixed => {
  withLegacyConfig({
    compactionRouting: { model: "healthy/keep", sourceModels: ["opencode-free/*", ...(mixed ? ["healthy/*"] : [])] },
    injectionModel: "opencode-free/old", injectionEffort: "high", syncCodexSubagentDefaults: true,
  }, bytes => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        const loaded = loadConfig();
        expect(loaded.compactionRouting).toEqual(mixed ? { model: "healthy/keep", sourceModels: ["healthy/*"] } : undefined);
        expect(loaded.injectionModel).toBeUndefined();
        expect(loaded.injectionEffort).toBeUndefined();
        expect(loaded.syncCodexSubagentDefaults).toBeUndefined();
        expect(readConfigDiagnostics().source).toBe("file");
      }
      expect(warn.mock.calls.filter(([message]) => /compactionRouting|syncCodexSubagentDefaults/.test(String(message)))).toEqual([]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    } finally { warn.mockRestore(); }
  });
});

test("all routed reference sites and whitespace aliases are pruned while healthy references remain", () => {
  withLegacyConfig({
    providers: {
      "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
      healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "retired-alias/old",
        autoReviewModel: "opencode-free/reviewer", autoReviewModelOverrides: {
          model: "retired-alias/reviewer", "opencode-free/source": "healthy/reviewer", keep: "healthy/reviewer",
        } },
    },
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    codexRoleTiers: { fast: ["retired-alias/old", "healthy/keep"], standard: ["opencode-free/old"], frontier: ["retired-combo"] },
    visionSidecar: { backend: "routed", model: "retired-alias/old" },
    webSearchSidecar: { backend: "openai", model: "opencode-free/old" },
    shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*", "healthy/*"] },
  }, bytes => {
    const loaded = loadConfig();
    expect(readConfigDiagnostics().source).toBe("file");
    expect(loaded.codexRoleTiers).toEqual({ fast: ["healthy/keep"], standard: [], frontier: [] });
    expect(loaded.visionSidecar).toEqual({ backend: "routed", enabled: false });
    expect(loaded.webSearchSidecar).toEqual({ backend: "openai", enabled: false });
    expect(loaded.shadowCallIntercept).toEqual({ enabled: true, model: "healthy/keep", sourceModels: ["healthy/*"] });
    expect(loaded.providers.healthy.defaultModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModelOverrides).toEqual({ keep: "healthy/reviewer" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
  withLegacyConfig({ shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*"] } }, () => {
    expect(loadConfig().shadowCallIntercept).toBeUndefined();
  });
});

test.each([false, true, undefined])("retired sidecar targets stay disabled through load, diagnostics and saves (enabled: %s)", enabled => {
  const routes = {
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
  };
  for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const settings = { ...(enabled === undefined ? {} : { enabled }), model, timeoutMs: 12_345, reasoning: "low" };
    const vision = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
    const search = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
    withLegacyConfig({ ...routes, visionSidecar: vision, webSearchSidecar: search }, bytes => {
      const expectedVision = { backend: "routed", enabled: false, timeoutMs: 12_345, reasoning: "low", maxDescriptionsPerTurn: 2 };
      const expectedSearch = { backend: "openai", enabled: false, timeoutMs: 12_345, reasoning: "low", maxSearchesPerTurn: 3 };
      const live = loadConfig();
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(expectedVision);
        expect(config.webSearchSidecar).toEqual(expectedSearch);
      };
      check(live);
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      check(diagnostics.config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
        expect(loadConfig().fastMode).toBe(fastMode);
      }
    });
  }
}, 60_000);

test.each([false, true, undefined])("healthy sidecar settings keep their activation and targets (enabled: %s)", enabled => {
  const settings = { ...(enabled === undefined ? {} : { enabled }), model: "healthy/keep", reasoning: "low", timeoutMs: 12_345 };
  const visionSidecar = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
  const webSearchSidecar = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
  withLegacyConfig({ visionSidecar, webSearchSidecar }, bytes => {
    const live = loadConfig();
    expect(live.visionSidecar).toEqual(visionSidecar);
    expect(live.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readConfigDiagnostics().config.visionSidecar).toEqual(visionSidecar);
    expect(readConfigDiagnostics().config.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    armClaudeCodeBaseline(live);
    live.fastMode = true;
    saveConfigPreservingClaudeCode(live);
    expect(loadConfig().visionSidecar).toEqual(visionSidecar);
    expect(loadConfig().webSearchSidecar).toEqual(webSearchSidecar);
  });
});

test.each([false, true, undefined])("Claude retired overrides stay disabled without changing healthy globals (enabled: %s)", enabled => {
  const request = parseRequest({ model: "healthy/blind", tools: [{ type: "web_search" }], input: [{ role: "user", content: [
    { type: "input_text", text: "Describe and search." }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ] }] });
  const globalVision = { enabled: true, backend: "routed", model: "healthy/vision", timeoutMs: 12_345 };
  const globalSearch = { enabled: true, backend: "exa", model: "healthy/search", exaApiKey: "fixture-exa-key" };
  for (const globals of [false, true]) for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const activation = enabled === undefined ? {} : { enabled };
    withLegacyConfig({
      ...(globals ? { visionSidecar: globalVision, webSearchSidecar: globalSearch } : {}),
      combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
      routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
      claudeCode: { enabled: true, visionSidecar: { ...activation, backend: "routed", model }, webSearchSidecar: { ...activation, backend: "openai", model } },
    }, bytes => {
      const live = loadConfig();
      live.providers.healthy!.modelInputModalities = { blind: ["text"], vision: ["text", "image"] };
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(globals ? globalVision : undefined);
        expect(config.webSearchSidecar).toEqual(globals ? globalSearch : undefined);
        expect(config.claudeCode?.visionSidecar).toEqual({ enabled: false, backend: "routed" });
        expect(config.claudeCode?.webSearchSidecar).toEqual({ enabled: false, backend: "openai" });
        const effective = buildClaudeReplayConfig(config);
        const provider = { ...config.providers.healthy!, noVisionModels: ["blind"] };
        expect(planVisionSidecar(effective, provider, "blind", request, undefined, { providerName: "healthy" })).toBeUndefined();
        expect(shouldResolveOpenAiVisionSidecar(effective, provider, "blind", request, "healthy")).toBe(false);
        expect(planWebSearch(effective, request, false, provider, "blind")).toBeUndefined();
        expect(shouldResolveOpenAiWebSearchSidecar(effective, request, false)).toBe(false);
      };
      check(live);
      expect(readConfigDiagnostics().source).toBe("file");
      check(readConfigDiagnostics().config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      // The same legitimate global/default config remains usable outside the Claude override.
      const provider = live.providers.healthy!;
      expect(planVisionSidecar(live, provider, "blind", request, undefined, { providerName: "healthy" })?.backend).toBe(globals ? "routed" : undefined);
      expect(planWebSearch(live, request, false, provider, "blind")?.backend).toBe(globals ? "exa" : undefined);
      expect(shouldResolveOpenAiVisionSidecar(live, provider, "blind", request, "healthy")).toBe(!globals);
      expect(shouldResolveOpenAiWebSearchSidecar(live, request, false)).toBe(!globals);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
      }
    });
  }
}, 60_000);

test("unrelated providers and config remain unchanged", () => {
  const home = createTempHome("ocx-retained-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const raw = getDefaultConfig();
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    expect(loadConfig().providers).toEqual(raw.providers);
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); home.remove(); }
});
