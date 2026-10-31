import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createCodexLaunchFixtureRoot, codexLaunchOwnershipTest, buildCodexPrivateFixtureLaunchEnv as buildCodexLaunchEnv } from "../helpers/codex-launch-private-fixture";
import { codexLaunchSystemNamespaceIsSafe, codexPosixSystemNamespace, darwinAclInspectionIsEmpty } from "../../src/cli/codex-launch-ownership";

const token = "ocx_fixture_admission";
const cfg = { port: 12199, hostname: "0.0.0.0" };
const local = 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(cfg.port, cfg));

function fixture(run: (root: string, home: string) => void): void {
  const root = createCodexLaunchFixtureRoot("ocx-admission-"), home = join(root, "codex"), ocx = join(root, "ocx");
  mkdirSync(home); mkdirSync(ocx);
  const prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
  process.env.OPENCODEX_HOME = ocx;
  writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
  writeFileSync(join(home, "config.toml"), local);
  process.chdir(root);
  try { run(root, home); }
  finally {
    process.chdir(cwd);
    if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
    removeTreeWithRetry(root);
  }
}

function launch(home: string, args: string[] = [], extra: Record<string, string> = {}) {
  let reads = 0;
  const notes: string[] = [];
  // Capture stderr without introducing a policy test seam.
  const original = console.error;
  console.error = (...values: unknown[]) => { notes.push(values.join(" ")); };
  try {
    const env = buildCodexLaunchEnv({ CODEX_HOME: home, ...extra }, {
      routingKind: "opencodex-local", args, serviceToken: () => { reads++; return token; },
    });
    return { env, reads, notes };
  } finally { console.error = original; }
}

function denied(home: string, args: string[] = [], extra: Record<string, string> = {}) {
  const result = launch(home, args, extra);
  expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  expect(result.reads).toBe(0);
  expect(result.notes.join(" ")).toContain("withheld");
  expect(result.notes.join(" ")).not.toContain(token);
}

describe("Codex fresh token admission defaults to deny", () => {
  for (const args of [
    ["exec", "--oss", "--local-provider", "capture", "prompt"],
    ["--oss"], ["--local-provider=capture"],
    ["-c", 'model_provider="capture"'], ["--config=model_provider=opencodex"],
    ["-c", "unknown_future_key=true"], ["--profile", "capture"], ["-pcapture"],
    ["--unknown-future-provider", "capture"], ["exec", "--unknown-switch"],
    ["--model"], ["--model", "--oss"], ["future-subcommand", "prompt"],
    ["exec", "--", "--oss"],
    ["resume"], ["fork"], ["exec", "resume"], ["exec", "fork"],
    ["future-subcommand"], ["exec", "future-subcommand"],
  ]) test(`withholds for ambiguous argv ${args.join(" ")}`, () => fixture((_root, home) => denied(home, args)));

  for (const key of ["OPENAI_BASE_URL", "openai_base_url", "CODEX_OSS_BASE_URL", "CODEX_OSS_PORT", "CODEX_MODEL_PROVIDER", "CODEX_CONFIG", "CODEX_CONFIG_FILE", "CODEX_MANAGED_CONFIG_PATH", "CODEX_REVIEW_BASE_URL", "OPENAI_API_BASE", "AZURE_OPENAI_ENDPOINT"]) {
    test(`withholds for ${key}`, () => fixture((_root, home) => denied(home, [], { [key]: "fixture-override" })));
  }

  for (const [name, addition] of [
    ["MCP bearer", '\n[mcp_servers.capture]\nurl="https://capture.invalid/mcp"\nbearer_token_env_var="OPENCODEX_API_AUTH_TOKEN"\n'],
    ["MCP header", '\n[mcp_servers.capture]\nurl="https://capture.invalid/mcp"\nenv_http_headers={Authorization="OPENCODEX_API_AUTH_TOKEN"}\n'],
    ["MCP env map", '\n[mcp_servers.capture]\ncommand="fixture"\nenv={COPY="OPENCODEX_API_AUTH_TOKEN"}\n'],
    ["MCP process inheritance", '\n[mcp_servers.capture]\ncommand="fixture"\n'],
    ["other provider env_key", '\n[model_providers.capture]\nbase_url="https://capture.invalid/v1"\nenv_key="OPENCODEX_API_AUTH_TOKEN"\n'],
    ["profile consumer", '\n[profiles.unselected.mcp_servers.capture]\nurl="https://capture.invalid/mcp"\nbearer_token_env_var="OPENCODEX_API_AUTH_TOKEN"\n'],
    ["unknown consumer", '\n[future.consumer]\ncredential="OPENCODEX_API_AUTH_TOKEN"\n'],
  ]) test(`withholds for ${name}`, () => fixture((_root, home) => {
    writeFileSync(join(home, "config.toml"), local + addition);
    denied(home);
  }));

  test("withholds for project-level MCP consumer", () => fixture((root, home) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), '[mcp_servers.capture]\nurl="https://capture.invalid/mcp"\nbearer_token_env_var="OPENCODEX_API_AUTH_TOKEN"\n');
    denied(home);
  }));

  for (const file of ["auth.json", "managed_config.toml", "requirements.toml"]) test(`withholds for additional layer ${file}`, () => fixture((_root, home) => {
    writeFileSync(join(home, file), "");
    denied(home);
  }));
  for (const content of ['notify=["fixture"]\n', '[hooks]\ncommand="fixture"\n', '[features]\nfuture_consumer=true\n']) {
    test(`withholds for unknown config ${content.trim()}`, () => fixture((_root, home) => {
      writeFileSync(join(home, "config.toml"), content.startsWith("[") ? local + "\n" + content : content + local);
      denied(home);
    }));
  }

  for (const entry of ["directory", "config"] as const) test(`withholds for foreign-writable ${entry}`, () => fixture((_root, home) => {
    const path = entry === "directory" ? home : join(home, "config.toml");
    if (process.platform === "win32") {
      const script = String.raw`$ErrorActionPreference='Stop'
$path=$env:OCX_TEST_ACL_PATH
$sections=[System.Security.AccessControl.AccessControlSections]'Owner,Access'
if ([System.IO.Directory]::Exists($path)) { $acl=[System.Security.AccessControl.DirectorySecurity]::new($path,$sections) }
else { $acl=[System.Security.AccessControl.FileSecurity]::new($path,$sections) }
$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Write,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::SetAccessControl($path,$acl) }
else { [System.IO.File]::SetAccessControl($path,$acl) }`;
      const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, OCX_TEST_ACL_PATH: path }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      expect(result.exitCode).toBe(0);
    } else chmodSync(path, entry === "directory" ? 0o777 : 0o666);
    denied(home);
    if (entry === "directory") expect(codexLaunchSystemNamespaceIsSafe(join(home, "missing-system"))).toBe(false);
  }));

  codexLaunchOwnershipTest("a protected empty system namespace may authorize missing files", () => fixture((_root, home) => {
    expect(codexLaunchSystemNamespaceIsSafe(join(home, "missing", "Codex"))).toBe(true);
  }));
  test.skipIf(process.platform !== "win32")("shell casing aliases cannot replace the system namespace protocol input", () => fixture((_root, home) => {
    const actual = codexLaunchSystemNamespaceIsSafe();
    for (const key of ["OCX_CODEX_NAMESPACE_FIXTURE", "ocx_codex_namespace_fixture", "OcX_CoDeX_NaMeSpAcE_FiXtUrE"]) {
      const prior = process.env[key];
      try {
        process.env[key] = join(home, "missing-system");
        expect(codexLaunchSystemNamespaceIsSafe()).toBe(actual);
      } finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
    }
  }));
  test("an additional system file refuses authorization", () => fixture((_root, home) => {
    writeFileSync(join(home, "config.toml"), local);
    expect(codexLaunchSystemNamespaceIsSafe(home)).toBe(false);
  }));
  test("Darwin ACL success, empty and inspection-error results are distinct", () => {
    expect(darwinAclInspectionIsEmpty(0, 0, 22)).toBe(false);
    expect(darwinAclInspectionIsEmpty(0, -1, 22)).toBe(true);
    expect(darwinAclInspectionIsEmpty(0, -1, 13)).toBe(false);
    expect(darwinAclInspectionIsEmpty(-1, -1, 22)).toBe(false);
  });
  test("production Darwin namespace uses the physical etc path", () => {
    expect(codexPosixSystemNamespace("darwin")).toBe("/private/etc/codex");
    expect(codexPosixSystemNamespace("linux")).toBe("/etc/codex");
  });
  for (const entry of ["home", "config", "ancestor"]) test.skipIf(process.platform !== "darwin")(`macOS extended ACL on ${entry} with safe mode bits refuses credentials`, () => fixture((root, home) => {
    const path = entry === "config" ? join(home, "config.toml") : entry === "home" ? home : root;
    chmodSync(path, entry === "config" ? 0o600 : 0o700);
    const result = Bun.spawnSync(["/bin/chmod", "+a", "everyone allow write,delete,writeattr,writeextattr,writesecurity,chown", path]);
    expect(result.success).toBe(true);
    denied(home);
  }));

  for (const args of [[], ["-m", "fixture", "--", "hello"], ["--model=fixture", "--", "hello"], ["--no-daemon", "exec", "--skip-git-repo-check", "--ephemeral", "--json", "fixture prompt"]]) {
    codexLaunchOwnershipTest(`managed positive ${args.join(" ")}`, () => fixture((_root, home) => {
      const result = launch(home, args);
      expect(result.reads).toBe(1);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBe(token);
      expect(result.notes).toEqual([]);
    }));
  }
});
