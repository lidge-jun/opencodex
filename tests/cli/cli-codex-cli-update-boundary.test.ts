import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { captureCodexCliTransportEnv } from "../../src/update/codex-cli-update-launch-policy.mjs";

const roots: string[] = [];
afterEach(() => {
  initializeNodeLauncherContext(["bun", "cli"], {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex CLI selection inspection boundary", () => {
  (process.platform === "win32" ? test : test.skip)("Windows never resolves a captured remote candidate", async () => {
    const proof = "W".repeat(43);
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], {
      [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
        codexCliInspectionEnv: { codexCliPath: "\\\\fixture.invalid\\share\\codex.exe", path: "", pathExt: ".EXE", managerRoots: {}, configDir: "C:\\fixture" },
      }),
    });
    let resolutions = 0;
    expect(await handleCodexCliUpdateCommand(["check", "--json"], {
      resolveSelectedRuntime: () => { resolutions++; throw new Error("must not resolve on Windows"); },
      inspectInstall: async deps => {
        expect(deps.selectedCommand).toBeNull();
        return inspectCodexCliInstall({ ...deps, exists: () => { throw new Error("must not read a Windows candidate"); } });
      },
    })).toBe(0);
    expect(resolutions).toBe(0);
  });

  (process.platform === "win32" ? test.skip : test).each(["codex-runtime.json", "codex-shim.json"])(
    "published check cannot block on a FIFO %s before bounded provenance inspection", state => {
      const root = mkdtempSync(join(tmpdir(), "ocx-selection-boundary-"));
      roots.push(root);
      const home = join(root, "home");
      mkdirSync(home);
      const candidate = join(root, "codex");
      writeFileSync(candidate, "#!/bin/sh\nexit 91\n");
      chmodSync(candidate, 0o755);
      expect(spawnSync("mkfifo", [join(home, state)]).status).toBe(0);
      const result = spawnSync("node", [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "check", "--json"], {
        cwd: repoRoot(), encoding: "utf8", timeout: 15_000,
        env: { ...process.env, OPENCODEX_HOME: home, CODEX_CLI_PATH: candidate },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).managed).toBe(false);
    },
  );
});

function inspectionContext(transportEnv?: unknown) {
  const proof = "T".repeat(43);
  return initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], {
    [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
      codexCliInspectionEnv: { codexCliPath: null, path: "", pathExt: null, managerRoots: {},
        configDir: "/fixture", transportEnv },
    }),
  });
}

describe("Codex CLI transport snapshot validation", () => {
  test("capture and parser preserve alias precedence, empty values and absence", () => {
    const expected = { HTTPS_PROXY: "http://upper.invalid", https_proxy: "http://lower.invalid",
      NO_PROXY: "", nOdE_ExTrA_cA_cErTs: "/fixture/ca.pem" };
    const captured = captureCodexCliTransportEnv({ ...expected, HTTP_PROXY: undefined, NODE_OPTIONS: "untrusted" });
    expect(captured).toEqual(expected);
    const snapshot = inspectionContext(captured)?.codexCliInspectionEnv?.transportEnv;
    expect(snapshot).toEqual(expected);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test.each([null, [], { NODE_OPTIONS: "untrusted" }, { HTTPS_PROXY: false },
    { HTTPS_PROXY: "x".repeat(32 * 1024 + 1) }].map(value => ({ value })))("invalid transport map fails closed %#", row => {
    expect(inspectionContext(row.value)).toBeNull();
  });

  test("an older snapshot supplies no ambient transport values", () => {
    expect(inspectionContext()?.codexCliInspectionEnv?.transportEnv).toEqual({});
  });
});

/** Copy the launcher's actual relative module graph, without dependencies or a source-tree clone. */
function copyLauncherModule(root: string, source: string, copied = new Set<string>()) {
  if (copied.has(source)) return;
  copied.add(source);
  const target = join(root, relative(repoRoot(), source));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  for (const match of readFileSync(source, "utf8").matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.mjs)["']/g)) {
    copyLauncherModule(root, resolve(dirname(source), match[1]!), copied);
  }
}

describe("published launcher to npm transport binding", () => {
  test.each(["uppercase", "lowercase", "empty", "absent"])(
    "pre-dotenv %s settings reach every npm evidence query without dotenv aliases", mode => {
      const root = mkdtempSync(join(tmpdir(), "ocx-transport-boundary-"));
      roots.push(root);
      copyLauncherModule(root, repoPath("bin", "ocx.mjs"));
      writeFileSync(join(root, "package.json"), '{"type":"module","dependencies":{"bun":"1.4.2"}}');
      const project = join(root, "project");
      const tools = join(root, "tools");
      mkdirSync(project);
      mkdirSync(tools);
      const npm = join(tools, process.platform === "win32" ? "npm.exe" : "npm");
      writeFileSync(npm, "fixture: never executed");
      chmodSync(npm, 0o700);
      const ca = join(root, "early-ca.pem");
      writeFileSync(ca, "");
      const proxy = new URL("http://early-proxy.invalid:8080");
      proxy.username = "snapshot-user";
      proxy.password = "fixture-password";
      const upper = { HTTP_PROXY: proxy.href,
        HTTPS_PROXY: "http://early-https.invalid", ALL_PROXY: "http://early-all.invalid",
        NO_PROXY: "localhost,.early.invalid", NODE_EXTRA_CA_CERTS: ca };
      const expected = mode === "absent" ? {} : Object.fromEntries(Object.entries(upper).map(([key, value]) =>
        [mode === "lowercase" ? key.toLowerCase() : key, mode === "empty" ? "" : value]));
      const dotenv = Object.keys(upper).flatMap(key => [key, key.toLowerCase()])
        .map(key => `${key}=dotenv-${key}`).join("\n");
      writeFileSync(join(project, ".env"), dotenv + "\n");
      const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(repoPath("src", path)).href);
      const probe = `
import { initializeNodeLauncherContext } from ${moduleUrl("cli/launcher-context.ts")};
import { handleCodexCliUpdateCommand } from ${moduleUrl("cli/codex-cli-update.ts")};
import { createCodexCliUpdatePlan } from ${moduleUrl("codex/cli-update-plan.ts")};
import { captureCodexCliTransportEnv } from ${moduleUrl("update/codex-cli-update-launch-policy.mjs")};
try {
const expected = ${JSON.stringify(expected)};
const equal = value => JSON.stringify(Object.entries(value).sort()) === JSON.stringify(Object.entries(expected).sort());
const requireEvidence = (ok, label) => { if (!ok) throw new Error(label); };
const context = initializeNodeLauncherContext();
requireEvidence(equal(context?.codexCliInspectionEnv?.transportEnv ?? null), "launcher snapshot mismatch");
requireEvidence(Object.values(captureCodexCliTransportEnv(process.env)).some(v => v.startsWith("dotenv-")), "dotenv did not load");
let queries = 0;
const result = await handleCodexCliUpdateCommand(process.argv.slice(4), {
  resolveSelectedRuntime: () => ({ runtime: null, failures: [] }),
  createPlan: deps => createCodexCliUpdatePlan({ ...deps, platform: "linux",
    inspect: async () => ({ managed: true, provenance: "npm-global", packageVersion: "1.0.0",
      versionEvidence: { kind: "package-manifest" }, installDigest: "a".repeat(64) }),
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    spawnProcess: (_command, args, options) => {
      requireEvidence(equal(captureCodexCliTransportEnv(options.env)), "npm transport mismatch");
      requireEvidence(options.env.PATH === ${JSON.stringify(tools)}, "npm PATH mismatch");
      queries++;
      return { status: 0, stdout: args.includes("version") ? "1.1.0"
        : args.includes("dist.integrity") ? "sha512-" + Buffer.alloc(64, 7).toString("base64")
        : "https://registry.npmjs.org/@openai/codex/-/codex-1.1.0.tgz", stderr: "" };
    },
  }),
});
requireEvidence(result === 0 && queries === 3, "npm evidence queries incomplete");
console.log(JSON.stringify({ verifiedQueries: queries }));
} catch {
  console.error("launcher transport fixture verification failed");
  process.exitCode = 1;
}
`;
      mkdirSync(join(root, "src", "cli"), { recursive: true });
      writeFileSync(join(root, "src", "cli", "index.ts"), probe);
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (["path", "pathext", ...Object.keys(upper).map(k => k.toLowerCase())].includes(key.toLowerCase())) delete env[key];
      }
      Object.assign(env, expected, { PATH: tools, PATHEXT: ".EXE;.CMD", OPENCODEX_HOME: join(root, "home"),
        OPENCODEX_BUN_PATH: process.execPath, OCX_NO_DESKTOP_HANDOFF: "1" });
      const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true });
      expect(node.status).toBe(0);
      const result = spawnSync(node.stdout.trim(), [join(root, "bin", "ocx.mjs"), "system", "codex-cli-update", "plan", "--json"], {
        cwd: project, env, encoding: "utf8", timeout: 25_000, windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const marker = result.stdout.lastIndexOf('{"verifiedQueries":');
      expect(marker).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout.slice(0, marker))).toMatchObject({ applicable: true, targetVersion: "1.1.0" });
      expect(JSON.parse(result.stdout.slice(marker))).toEqual({ verifiedQueries: 3 });
      for (const secret of ["snapshot-user", "fixture-password", "early-proxy.invalid", ca]) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
    }, 30_000,
  );
});
