import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";
import { codexLaunchHomeIsOwned } from "../../src/cli/codex-launch-ownership";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { createCodexLaunchFixtureRoot, codexLaunchOwnershipTest, codexLaunchProjectRefusalTest, buildCodexPrivateFixtureLaunchEnv as buildCodexLaunchEnv } from "../helpers/codex-launch-private-fixture";

const token = "ocx_fixture_launch_env";
const installation = { port: 12199, hostname: "0.0.0.0" };
const local = 'model_provider = "opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(12199, installation));
const foreign = local.replace("http://127.0.0.1:12199/v1", "https://foreign.invalid/v1");
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "Http_Proxy", "All_Proxy"];

async function fixture(run: (root: string, home: string) => void | Promise<void>): Promise<void> {
  // Avoid the real user's ancestor .codex layer, which deliberately denies injection.
  const root = createCodexLaunchFixtureRoot("ocx-launch-env-");
  const saved = { ...process.env }, cwd = process.cwd();
  const user = join(root, "user"), home = join(root, "codex-home"), ocx = join(root, "ocx");
  for (const path of [user, home, ocx]) mkdirSync(path);
  process.env.HOME = user; process.env.USERPROFILE = user;
  process.env.CODEX_HOME = home; process.env.OPENCODEX_HOME = ocx;
  for (const key of Object.keys(process.env)) {
    if ((key !== "CODEX_HOME" && /^(?:CODEX_|OPENAI_|AZURE_OPENAI_)/i.test(key))
      || /^(?:(?:https?|all|no)_proxy|OPENCODEX_API_AUTH_TOKEN|OPENCODEX_ADMIN_AUTH_TOKEN|OCX_API_TOKEN_FILE)$/i.test(key)) delete process.env[key];
  }
  writeFileSync(join(ocx, "config.json"), JSON.stringify(installation));
  writeFileSync(join(home, "config.toml"), local);
  process.chdir(root);
  try { await run(root, home); }
  finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    removeTreeWithRetry(root);
  }
}

function launch(base = { ...process.env }) {
  let reads = 0, reason: string | undefined;
  const env = buildCodexLaunchEnv(base, {
    routingKind: "opencodex-local", serviceToken: () => { reads++; return token; },
    credentialDestination: (home, report) => codexCredentialDestinationIsTrusted(home, join(home, "system-namespace-fixture"), r => { reason = r; report?.(r); }),
  });
  return { env, reads, reason };
}

function canCreateDirectorySymlink(): boolean {
  const root = mkdtempSync(join(tmpdir(), "ocx-symlink-probe-"));
  try { symlinkSync(root, join(root, "link"), "dir"); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally { removeTreeWithRetry(root); }
}

describe("Codex launcher native home and proxy environment", () => {
  (canCreateDirectorySymlink() ? codexLaunchOwnershipTest : test.skip)("a symlinked user .codex is the home config, not a project layer", () => fixture((root, home) => {
    const user = join(root, "user"), cwd = join(user, "project");
    mkdirSync(cwd);
    symlinkSync(join("..", "codex-home"), join(user, ".codex"), "dir");
    process.chdir(cwd);
    const base = { ...process.env }; delete base.CODEX_HOME;
    const result = launch(base);
    expect(result.reads).toBe(1);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBe(token);
    expect(result.env.CODEX_HOME).toBe(realpathSync(home));
  }));

  for (const entry of ["parent", "ancestor", "redirect"] as const) {
    (canCreateDirectorySymlink() ? codexLaunchProjectRefusalTest : test.skip)(`a writable project alias ${entry} refuses before token read`, (expectedReason) => fixture((root, home) => {
      const shared = join(root, "shared"), project = join(shared, "project");
      mkdirSync(project, { recursive: true });
      if (entry === "redirect") {
        const bridge = join(project, "bridge");
        symlinkSync(home, bridge, "dir");
        symlinkSync(bridge, join(root, ".codex"), "dir");
      } else {
        symlinkSync(home, join(project, ".codex"), "dir");
        process.chdir(project);
      }
      const writable = entry === "ancestor" ? shared : project;
      if (process.platform === "win32") {
        const result = spawnSync("icacls.exe", [writable, "/grant", "*S-1-1-0:(F)"], { encoding: "utf8", windowsHide: true });
        expect(result.status).toBe(0);
      } else chmodSync(writable, 0o707);
      try {
        const result = launch();
        expect(result.reads).toBe(0);
        expect(result.reason).toBe(expectedReason);
        expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      } finally { if (process.platform !== "win32") chmodSync(writable, 0o700); }
    }));
  }

  (canCreateDirectorySymlink() ? codexLaunchProjectRefusalTest : test.skip)("project alias inspection failure refuses before token read", (expectedReason) => fixture((root, home) => {
    symlinkSync(home, join(root, ".codex"), "dir");
    const inspect = spyOn(fs, "readlinkSync").mockImplementation(() => { throw new Error("fixture inspection unavailable"); });
    try {
      const result = launch();
      expect(result.reads).toBe(0);
      expect(result.reason).toBe(expectedReason);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    } finally { inspect.mockRestore(); }
  }));

  (process.platform === "win32" && canCreateDirectorySymlink() ? codexLaunchProjectRefusalTest : test.skip)("a writable Windows alias entry refuses while its target stays protected", (expectedReason) => fixture((root, home) => {
    const link = join(root, ".codex");
    symlinkSync(home, link, "dir");
    const grant = spawnSync("icacls.exe", [link, "/L", "/grant", "*S-1-1-0:(F)"], { encoding: "utf8", windowsHide: true });
    expect(grant.status).toBe(0);
    expect(codexLaunchHomeIsOwned(home)).toBe(expectedReason === "project");
    const result = launch();
    expect(result.reads).toBe(0);
    expect(result.reason).toBe(expectedReason);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  }));

  test("literal tilde home cannot borrow authority from the expanded user home", () => fixture((root) => {
    const expanded = join(root, "user", "trusted"), literal = join(root, "~", "trusted");
    mkdirSync(expanded); mkdirSync(literal, { recursive: true });
    writeFileSync(join(expanded, "config.toml"), local);
    writeFileSync(join(literal, "config.toml"), foreign);
    process.env.CODEX_HOME = join("~", "trusted");
    const result = launch();
    expect(result.reads).toBe(0);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  }));

  test("whitespace in a native literal home is not trimmed for authorization", () => fixture((root) => {
    for (const name of ["trusted", " trusted"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "trusted", "config.toml"), local);
    writeFileSync(join(root, " trusted", "config.toml"), foreign);
    process.env.CODEX_HOME = " trusted";
    expect(launch().reads).toBe(0);
  }));

  test("the actual child env home, rather than the parent home, owns authorization", () => fixture((root) => {
    const other = join(root, "other"); mkdirSync(other);
    writeFileSync(join(other, "config.toml"), foreign);
    expect(launch({ ...process.env, CODEX_HOME: other }).reads).toBe(0);
  }));

  test.skipIf(process.platform !== "win32")("ambiguous Windows home casing withholds credentials", () => fixture((_root, home) => {
    const base = { ...process.env, CODEX_HOME: home, codex_home: "unverified-home" };
    const result = launch(base);
    expect(result.reads).toBe(0);
    expect(result.env).toEqual(base);
  }));

  codexLaunchOwnershipTest("relative and literal tilde local homes are bound to the verified absolute directory", () => fixture((root) => {
    const literal = join(root, "~", "local"); mkdirSync(literal, { recursive: true });
    writeFileSync(join(literal, "config.toml"), local);
    for (const raw of ["codex-home", join("~", "local")]) {
      process.env.CODEX_HOME = raw;
      const result = launch();
      expect(result.reads).toBe(1);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBe(token);
      // Native-semantics fixture: the child opens CODEX_HOME literally under cwd.
      expect(result.env.CODEX_HOME).toBe(realpathSync(join(root, raw)));
      const child = spawnSync(process.execPath, [fixturePath("codex-launch-native-env.ts")], {
        cwd: root, env: result.env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, windowsHide: true,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ home: result.env.CODEX_HOME, baseUrl: "http://127.0.0.1:12199/v1", hasToken: true });
    }
  }));

  codexLaunchOwnershipTest("an implicit home is resolved from the child environment and bound explicitly", () => fixture((root) => {
    const implicit = join(root, "user", ".codex"); mkdirSync(implicit);
    writeFileSync(join(implicit, "config.toml"), local);
    const base = { ...process.env }; delete base.CODEX_HOME;
    const result = launch(base);
    expect(result.reads).toBe(1);
    expect(result.env.CODEX_HOME).toBe(realpathSync(implicit));
  }));

  test("missing and non-directory homes withhold credentials", () => fixture((root) => {
    const file = join(root, "file"); writeFileSync(file, "fixture");
    for (const raw of [join(root, "absent"), file, " "]) {
      process.env.CODEX_HOME = raw;
      expect(launch().reads).toBe(0);
    }
  }));

  codexLaunchOwnershipTest("junction or symlink homes bind to the physical verified directory", () => fixture((root, home) => {
    const link = join(root, "linked"); symlinkSync(home, link, process.platform === "win32" ? "junction" : "dir");
    process.env.CODEX_HOME = link;
    const result = launch();
    expect(result.reads).toBe(1);
    expect(result.env.CODEX_HOME).toBe(realpathSync(home));
  }));

  test("junction or symlink homes with a foreign destination withhold credentials", () => fixture((root, home) => {
    const link = join(root, "linked"); symlinkSync(home, link, process.platform === "win32" ? "junction" : "dir");
    process.env.CODEX_HOME = link;
    writeFileSync(join(home, "config.toml"), foreign);
    const result = launch();
    expect(result.reads).toBe(0);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  }));

  for (const key of proxyKeys) for (const bypass of [undefined, "", "localhost", "*"]) {
    test(`${key} with NO_PROXY=${String(bypass)} withholds new credentials`, () => fixture(() => {
      const base = { ...process.env, [key]: "http://127.0.0.1:19999", NO_PROXY: bypass, no_proxy: "127.0.0.1" };
      const result = launch(base);
      expect(result.reads).toBe(0);
      expect(result.env).toEqual(base);
    }));
  }

  codexLaunchOwnershipTest("empty proxy variables preserve normal local credential delivery", () => fixture((_root, home) => {
    const result = launch({ ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" });
    expect(result.reads).toBe(1);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBe(token);
    expect(result.env.CODEX_HOME).toBe(realpathSync(home));
    expect(result.env.NO_PROXY).toContain("127.0.0.1");
    expect(result.env.no_proxy).toContain("::1");
  }));

  test("system proxy opt-in without proxy env withholds credentials", () => fixture((_root, home) => {
    writeFileSync(join(home, "config.toml"), local + "\n[features]\nrespect_system_proxy = true\nsystem_proxy_fallback = true\n");
    expect(launch().reads).toBe(0);
  }));

  test("feature argv cannot enable a bypass-ignoring system proxy", () => fixture(() => {
    for (const args of [["--enable", "respect_system_proxy"], ["--enable=respect_system_proxy"]]) {
      let reads = 0;
      buildCodexLaunchEnv(process.env, { routingKind: "opencodex-local", args, serviceToken: () => { reads++; return token; } });
      expect(reads).toBe(0);
    }
  }));

  codexLaunchOwnershipTest("default transport gets identical loopback bypasses and preserves existing entries", () => fixture((_root, home) => {
    writeFileSync(join(home, "config.toml"), local + "\n[features]\nrespect_system_proxy = false\nsystem_proxy_fallback = true\n");
    const result = launch({ ...process.env, NO_PROXY: "example.invalid", no_proxy: "other.invalid", No_Proxy: "third.invalid" });
    expect(result.reads).toBe(1);
    expect(result.env.NO_PROXY).toBe(result.env.no_proxy);
    for (const entry of ["127.0.0.1", "::1", "example.invalid", "other.invalid", "third.invalid"]) expect(result.env.NO_PROXY!.split(",")).toContain(entry);
    expect(result.env.No_Proxy).toBeUndefined();
  }));

  test("an observing proxy receives no freshly loaded credential", () => fixture(async (root) => {
    const received: boolean[] = [];
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      received.push(request.headers.has("authorization"));
      return new Response("fixture refusal", { status: 401 });
    } });
    try {
      const result = launch({ ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "", OCX_FIXTURE_REQUEST: "1" });
      expect(result.reads).toBe(0);
      const child = Bun.spawn([process.execPath, fixturePath("codex-launch-native-env.ts")], { cwd: root, env: result.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(""); expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ hasToken: false, status: 401 });
      expect(received).toEqual([false]);
    } finally { await proxy.stop(true); }
  }), SPAWN_BUDGET_MS);

  test("a user-exported token and proxy settings remain untouched", () => fixture(() => {
    const base = { ...process.env, OPENCODEX_API_AUTH_TOKEN: token, HTTP_PROXY: "http://127.0.0.1:19999" };
    const result = launch(base);
    expect(result.reads).toBe(0);
    expect(result.env).toEqual(base);
  }));
});
