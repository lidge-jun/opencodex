import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, parse } from "node:path";
import { spawnSync } from "node:child_process";
import { codexCommandCanBypass } from "../../src/cli/codex-launch-command";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";
import { resolveCodexLaunchCommand } from "../../src/cli/codex-launcher";
import { commandInvocation } from "../../src/lib/win-exec";
import { classifyCodexRouting } from "../../src/codex/inject/routing-classify";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { buildWindowsCodexShim, WINDOWS_SHIM_REVISION_MARKER } from "../../src/codex/shim-templates";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { createCodexLaunchFixtureRoot, codexLaunchOwnershipTest, codexLaunchProjectRefusalTest, buildCodexPrivateFixtureLaunchEnv as buildCodexLaunchEnv } from "../helpers/codex-launch-private-fixture";

const fixtureToken = "ocx_fixture_launcher_security";
const installation = { port: 12199, hostname: "0.0.0.0" };
const local = 'model_provider = "opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(12199, installation));

function fixture(run: (home: string, codexHome: string, ocxHome: string) => void): void {
  const home = createCodexLaunchFixtureRoot("ocx-launch-security-");
  const cwd = process.cwd();
  const saved = { CODEX_HOME: process.env.CODEX_HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME };
  const codexHome = join(home, "codex-home"), ocxHome = join(home, "ocx-home");
  mkdirSync(codexHome); mkdirSync(ocxHome);
  process.env.CODEX_HOME = codexHome; process.env.OPENCODEX_HOME = ocxHome;
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify(installation));
  writeFileSync(join(ocxHome, "service-api-token"), fixtureToken);
  process.chdir(home);
  try { run(home, codexHome, ocxHome); }
  finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeTreeWithRetry(home);
  }
}

describe("codex launcher credential destination", () => {
  // Keep the shared positive control separate so unsafe hosts still execute all negatives.
  codexLaunchOwnershipTest("the managed starting configuration reads the service token exactly once", () => fixture((_home, codexHome) => {
    writeFileSync(join(codexHome, "config.toml"), local);
    let reads = 0;
    const env = buildCodexLaunchEnv({ CODEX_HOME: codexHome }, { routingKind: "opencodex-local", serviceToken: () => { reads++; return fixtureToken; } });
    expect(reads).toBe(1);
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBe(fixtureToken);
  }));
  for (const [name, content] of [
    ["remote reserved provider", local.replace("http://127.0.0.1:12199/v1", "https://gateway.invalid/v1")],
    ["remote root URL retaining injection comment", '# Auto-injected by opencodex\nopenai_base_url = "https://gateway.invalid/v1"\n'],
    ["wrong local port", local.replace(":12199/", ":12200/")],
    ["default profile redirects provider", 'profile = "foreign"\n' + local + '\n[profiles.foreign]\nmodel_provider = "foreign"\n'],
    ["extra credential header", local + '\n[model_providers.opencodex.env_http_headers]\nx-key = "OPENCODEX_API_AUTH_TOKEN"\n'],
    ["malformed TOML", local + '\nmodel_provider = [\n'],
  ]) {
    test(`does not load a token for ${name}`, () => fixture((_home, codexHome) => {
      writeFileSync(join(codexHome, "config.toml"), content!);
      let reads = 0;
      const env = buildCodexLaunchEnv({ CODEX_HOME: codexHome }, { routingKind: classifyCodexRouting(content!), serviceToken: () => { reads++; return fixtureToken; } });
      expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      expect(reads).toBe(0);
    }));
  }
  codexLaunchOwnershipTest("loads the service token for the managed provider on this installation's local listener", () => fixture((home, codexHome) => {
    writeFileSync(join(codexHome, "config.toml"), local);
    // This isolated Codex home must not inherit project configs beside the real user's
    // home/worktree. The filesystem root has no caller ancestor configuration layers.
    const originalDirectory = process.cwd();
    try {
      process.chdir(parse(home).root);
      expect(buildCodexLaunchEnv({ CODEX_HOME: codexHome }, { routingKind: "opencodex-local" }).OPENCODEX_API_AUTH_TOKEN).toBe(fixtureToken);
    } finally { process.chdir(originalDirectory); }
  }));
  test("directory and remote overrides never read a service token", () => fixture((_home, codexHome) => {
    writeFileSync(join(codexHome, "config.toml"), local);
    for (const args of [["-C", "other"], ["-Cother"], ["--cd=other"], ["--cd", "other"], ["--remote", "remote"], ["--remote=remote"]]) {
      let reads = 0;
      expect(buildCodexLaunchEnv({ CODEX_HOME: codexHome }, { routingKind: "opencodex-local", args, serviceToken: () => { reads++; return fixtureToken; } })).toEqual({ CODEX_HOME: codexHome });
      expect(reads).toBe(0);
    }
  }));
  test("project configuration and environment destination overrides suppress loading", () => fixture((home, codexHome) => {
    writeFileSync(join(codexHome, "config.toml"), local);
    expect(buildCodexLaunchEnv({ CODEX_HOME: codexHome, OPENAI_BASE_URL: "https://gateway.invalid/v1" }, { routingKind: "opencodex-local" }).OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    const project = join(home, "project"); mkdirSync(project);
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".git"), "gitdir: fixture\n");
    writeFileSync(join(project, ".codex", "config.toml"), 'model_provider = "foreign"\n');
    const originalDirectory = process.cwd();
    try {
      process.chdir(project);
      let reads = 0;
      expect(buildCodexLaunchEnv({ CODEX_HOME: codexHome }, { routingKind: "opencodex-local", serviceToken: () => { reads++; return fixtureToken; } })).toEqual({ CODEX_HOME: codexHome });
      expect(reads).toBe(0);
    } finally { process.chdir(originalDirectory); }
  }));
  codexLaunchProjectRefusalTest("custom project roots cannot hide an outer override behind a nested .git", (expectedReason) => fixture((home, codexHome) => {
    writeFileSync(join(codexHome, "config.toml"), local);
    const workspace = join(home, "workspace"), nested = join(workspace, "nested"), cwd = join(nested, "src");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(workspace, ".codex"));
    writeFileSync(join(workspace, ".workspace-root"), "");
    writeFileSync(join(nested, ".git"), "gitdir: fixture\n");
    writeFileSync(join(workspace, ".codex", "config.toml"), '[model_providers.opencodex]\nbase_url = "https://gateway.invalid/v1"\n');
    writeFileSync(join(codexHome, "config.toml"), local);
    const originalDirectory = process.cwd();
    try {
      process.chdir(cwd);
      let reads = 0, reason: string | undefined;
      const env = buildCodexLaunchEnv({ CODEX_HOME: codexHome }, {
        routingKind: "opencodex-local", serviceToken: () => { reads++; return fixtureToken; },
        credentialDestination: (home, report) => codexCredentialDestinationIsTrusted(home, join(home, "system-namespace-fixture"), r => { reason = r; report?.(r); }),
      });
      expect(reads).toBe(0);
      expect(reason).toBe(expectedReason);
      expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    } finally { process.chdir(originalDirectory); }
  }));
});

describe.skipIf(process.platform !== "win32")("codex launcher installed Windows shim handoff", () => {
  for (const args of [["--help"], ["resume"], ["-c", "model_provider=foreign", "resume"]]) {
    for (const managementCollision of [false, true]) for (const obsolete of [true, false]) {
      test(`${obsolete ? "obsolete shim fails closed" : "current shim bypasses token loading"}: ${args.join(" ")} collision=${managementCollision}`, () => fixture((home, codexHome, ocxHome) => {
        const bin = join(home, "bin"); mkdirSync(bin);
        const probe = join(home, "probe.mjs");
        writeFileSync(probe, 'console.log(JSON.stringify({token:process.env.OPENCODEX_API_AUTH_TOKEN??null}));process.exit(23);\n');
        const backing = join(bin, "backing.cmd");
        writeFileSync(backing, `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`);
        const config = args.includes("-c")
          ? 'model_provider = "foreign"\n[model_providers.foreign]\nbase_url = "https://gateway.invalid/v1"\n'
          : 'model = "native-fixture"\n';
        writeFileSync(join(codexHome, "config.toml"), config);
        if (managementCollision) writeFileSync(join(ocxHome, "admin-api-token"), fixtureToken);
        const current = buildWindowsCodexShim(backing, process.execPath, repoPath("src", "cli", "index.ts"), "process");
        const lines = current.split("\n").filter(line => !line.includes(WINDOWS_SHIM_REVISION_MARKER));
        const bypass = lines.findIndex(line => line.includes('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex'));
        const load = lines.findIndex(line => line.includes("set /p OPENCODEX_API_AUTH_TOKEN="));
        expect(bypass).toBeGreaterThan(0); expect(load).toBeGreaterThan(bypass);
        [lines[bypass], lines[load]] = [lines[load]!, lines[bypass]!];
        const legacy = lines.join("\n");
        const installed = obsolete ? legacy : current;
        const wrapper = join(bin, "codex.cmd"); writeFileSync(wrapper, installed);
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PATHEXT: ".EXE;.CMD" };
        for (const key of ["OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN", "OCX_API_TOKEN_FILE", "OCX_SHIM_BYPASS"]) delete env[key];
        const resolveWithThrowingInspector = () => resolveCodexLaunchCommand(env, {
          findOnPath: () => wrapper,
          inspectShim: () => { throw new Error("fixture inspection failure"); },
        });
        if (obsolete) expect(resolveWithThrowingInspector).toThrow("cannot verify Codex shim bypass");
        else {
          const launch = resolveWithThrowingInspector();
          expect(launch.command).toBe(wrapper);
          expect(launch.env.OCX_SHIM_BYPASS).toBe("1");
          const invocation = commandInvocation(launch.command, args);
          const bypassed = spawnSync(invocation.file, invocation.args, { ...invocation.options,
            env: launch.env as NodeJS.ProcessEnv, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, windowsHide: true });
          expect(bypassed.status).toBe(23);
          expect(JSON.parse(bypassed.stdout.trim())).toEqual({ token: null });
        }
        const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "codex", ...args], {
          cwd: repoRoot(), env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.stdout).not.toContain(fixtureToken);
        expect(result.status).toBe(obsolete ? 1 : 23);
        if (obsolete) expect(result.stderr).toContain("shim");
        else expect(JSON.parse(result.stdout.trim())).toEqual({ token: null });
        expect(readFileSync(wrapper, "utf8")).toBe(installed);
        expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
      }), SPAWN_BUDGET_MS);
    }
  }
  test("a revision marker cannot bless inserted commands, duplicate labels or trailing code", () => fixture((home) => {
    const wrapper = join(home, "codex.cmd");
    const current = buildWindowsCodexShim(join(home, "backing.cmd"), process.execPath, repoPath("src", "cli", "index.ts"), "process");
    for (const text of [
      current.replace("setlocal", "echo inserted\r\nsetlocal"),
      current.replace(":run_codex", ":run_codex\r\necho inserted\r\n:run_codex"),
      current + "echo trailing\r\n",
      current.replace('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex', "rem bypass disabled"),
    ]) {
      writeFileSync(wrapper, text);
      expect(codexCommandCanBypass(wrapper, process.env)).toBe(false);
    }
  }));
});
