import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";
import {
  captureCodexCliTransportEnv,
  codexCliInspectionLookupSeeds,
  NODE_LAUNCH_CONTEXT_MAX_CHARS,
} from "../../src/update/codex-cli-update-launch-policy.mjs";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";

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

  test("a near-cap context with dropped lookup seeds still attests selection", () => {
    const proof = "W".repeat(43);
    // Pad mandatory selection fields exactly to the cap. The optional lookup
    // seeds alone overflow it; dropping them must preserve this whole snapshot.
    let path = "/";
    const serialize = (seeds: { home: string | null; nodePath: string | null }) => JSON.stringify({
      version: 1,
      proof,
      anthropicEnvSlots: [],
      codexCliInspectionEnv: {
        codexCliPath: "/x/bin/codex",
        path,
        pathExt: null,
        ...seeds,
        managerRoots: {},
        configDir: "/cfg",
      },
    });
    const emptySeeds = { home: null, nodePath: null };
    path += "d".repeat(NODE_LAUNCH_CONTEXT_MAX_CHARS - serialize(emptySeeds).length);
    const withSeeds = serialize({ home: "/home/u", nodePath: "/a:/b" });
    expect(withSeeds.length).toBeGreaterThan(NODE_LAUNCH_CONTEXT_MAX_CHARS);
    const raw = serialize(codexCliInspectionLookupSeeds("linux", "/home/u", "/a:/b", withSeeds.length));
    expect(raw.length).toBe(NODE_LAUNCH_CONTEXT_MAX_CHARS);
    const trusted = initializeNodeLauncherContext(
      ["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`],
      { [NODE_LAUNCH_CONTEXT_ENV]: raw },
    );
    expect(trusted?.codexCliInspectionEnv?.path).toBe(path);
    expect(trusted?.codexCliInspectionEnv?.home).toBeNull();
    expect(trusted?.codexCliInspectionEnv?.nodePath).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("published check preserves a large mixed-case HOME/NODE_PATH environment", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-context-seeds-"));
    roots.push(root);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (["home", "node_path"].includes(key.toLowerCase())) delete env[key];
    }
    const startedAt = performance.now();
    const result = spawnSync("node", [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "check", "--json"], {
      cwd: repoRoot(), encoding: "utf8", timeout: 15_000, windowsHide: true,
      env: { ...env, Home: "C:\\" + "h".repeat(8 * 1024), Node_Path: "C:\\" + "n".repeat(8 * 1024),
        OPENCODEX_HOME: root, OPENCODEX_BUN_PATH: process.execPath,
        CODEX_CLI_PATH: "C:\\fixture\\codex.exe", OCX_NO_DESKTOP_HANDOFF: "1" },
    });
    const diagnostic = JSON.stringify({ elapsedMs: performance.now() - startedAt, status: result.status,
      signal: result.signal, error: result.error?.message, stdout: result.stdout?.slice(-2_048), stderr: result.stderr?.slice(-2_048) });
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.candidateSource).toBe("environment");
    expect(report.reason).toBe("windows_inspection_deferred");
    expect(report.installContentDigest).toBeNull();
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

  // The published Node launcher snapshot -> provenance inspection -> dry-run plan
  // chain, end to end against a real npm install -g of a synthetic fixture
  // package into an owned temporary prefix. Only the registry answer is stubbed
  // (a fake npm first on the bound PATH); the install itself is real npm's work.
  // Packing, installing, and inspecting this fixture can exceed Bun's default 5s.
  test.skipIf(process.platform === "win32")("plan identity binds the bytes a real npm-global install placed", () => {
    const node = Bun.which("node");
    const npm = Bun.which("npm");
    // The suite runs under Bun, so its own executable is always a usable fallback.
    const bun = Bun.which("bun") ?? process.execPath;
    expect(node).not.toBeNull();
    expect(npm).not.toBeNull();
    expect(typeof bun).toBe("string");

    const BACKING: Record<string, { triple: string; pkg: string }> = {
      "linux:x64": { triple: "x86_64-unknown-linux-musl", pkg: "@openai/codex-linux-x64" },
      "linux:arm64": { triple: "aarch64-unknown-linux-musl", pkg: "@openai/codex-linux-arm64" },
      "darwin:x64": { triple: "x86_64-apple-darwin", pkg: "@openai/codex-darwin-x64" },
      "darwin:arm64": { triple: "aarch64-apple-darwin", pkg: "@openai/codex-darwin-arm64" },
    };
    const selected = BACKING[process.platform + ":" + process.arch];
    expect(selected).toBeDefined();

    const root = mkdtempSync(join(tmpdir(), "ocx-cli-content-e2e-"));
    roots.push(root);
    const fixture = join(root, "fixture");
    const prefix = join(root, "npm-prefix");
    const home = join(root, "home");
    const fakeBin = join(root, "sbin");
    mkdirSync(home, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    // Synthetic package set, explicitly marked: the main package declares the
    // published entrypoint contract (bin/codex.js) and the platform backing
    // package carries a vendor/<triple>/bin/codex binary. npm installs them as
    // two real global packages; the launcher's require.resolve finds the
    // backing as a sibling under the npm root.
    const codexDir = join(fixture, "codex");
    const backingDir = join(fixture, "backing");
    mkdirSync(join(codexDir, "bin"), { recursive: true });
    mkdirSync(join(backingDir, "vendor", selected.triple, "bin"), { recursive: true });
    writeFileSync(join(codexDir, "package.json"), JSON.stringify({
      name: "@openai/codex",
      version: "1.2.3",
      description: "synthetic test fixture package - not a published artifact",
      type: "module",
      bin: { codex: "bin/codex.js" },
    }, null, 2) + "\n");
    writeFileSync(join(codexDir, "bin", "codex.js"), [
      "#!/usr/bin/env node",
      "// synthetic fixture entrypoint implementing the published launcher selection rule",
      'import { createRequire } from "node:module";',
      'import { existsSync } from "node:fs";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const require = createRequire(import.meta.url);",
      "const dir = path.dirname(fileURLToPath(import.meta.url));",
      "const pkg = " + JSON.stringify(selected.pkg) + ";",
      "const triple = " + JSON.stringify(selected.triple) + ";",
      "let vendorRoot;",
      'try { vendorRoot = path.join(path.dirname(require.resolve(pkg + "/package.json")), "vendor"); }',
      'catch { vendorRoot = path.join(dir, "..", "vendor"); }',
      'const exe = path.join(vendorRoot, triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");',
      'if (!existsSync(exe)) throw new Error("missing optional dependency " + pkg);',
      "process.exit(0);",
      "",
    ].join("\n"));
    writeFileSync(join(backingDir, "package.json"), JSON.stringify({
      name: selected.pkg,
      version: "1.2.3",
      description: "synthetic test fixture backing package - not a published artifact",
      os: [process.platform === "linux" ? "linux" : "darwin"],
      cpu: [process.arch],
      files: ["vendor"],
    }, null, 2) + "\n");
    const backingExe = join(backingDir, "vendor", selected.triple, "bin", "codex");
    writeFileSync(backingExe, "#!/bin/sh\n# synthetic native-backing fixture\nexit 0\n");
    chmodSync(backingExe, 0o755);

    // Every real npm call runs against owned cache/config/state paths, so an
    // ambient NPM_CONFIG_*, user npmrc, or Node startup variable can neither
    // steer the fixture install nor write outside this root; lifecycle scripts
    // stay disabled end to end, and the pinned dead registry makes any
    // accidental network resolution a visible failure.
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(join(root, "user-npmrc"), "");
    writeFileSync(join(root, "global-npmrc"), "");
    const npmEnv = {
      PATH: [dirname(node!), "/usr/bin", "/bin"].join(delimiter),
      HOME: home,
      TMPDIR: join(root, "tmp"),
      npm_config_offline: "true",
    };
    const npmConfigArgs = [
      "--cache", join(root, "npm-cache"),
      "--userconfig", join(root, "user-npmrc"),
      "--globalconfig", join(root, "global-npmrc"),
    ];
    const pack = (dir: string) => {
      const packed = spawnSync(npm!, [
        "pack", "--json", "--pack-destination", dir, "--ignore-scripts", ...npmConfigArgs,
      ], {
        cwd: dir, encoding: "utf8", timeout: 30_000, env: npmEnv,
      });
      expect(packed.status).toBe(0);
      const meta = JSON.parse(packed.stdout) as { filename?: string }[];
      const filename = meta[0]?.filename ?? "";
      // The tarball name comes from npm's own report, never a guess at how the
      // scoped package name is flattened.
      expect(filename).toMatch(/^[^/\\]+[.]tgz$/);
      const tarball = resolve(dir, filename);
      expect(dirname(tarball)).toBe(dir);
      return tarball;
    };
    const npmInstall = (tarball: string) => {
      const installed = spawnSync(npm!, [
        "install", "-g", "--prefix", prefix, tarball,
        "--ignore-scripts", "--no-audit", "--no-fund",
        "--registry=http://127.0.0.1:9/",
        ...npmConfigArgs,
      ], {
        cwd: root, encoding: "utf8", timeout: 60_000, env: npmEnv,
      });
      expect(installed.status).toBe(0);
    };
    npmInstall(pack(backingDir));
    npmInstall(pack(codexDir));
    const launcher = join(prefix, "bin", "codex");

    // The bound snapshot PATH: the fake npm first, then the real npm-global bin
    // and node directories. Everything the spawned npm view needs is answered
    // by the script; nothing else on the PATH can shadow it.
    const integrity = "sha512-" + Buffer.alloc(64, 7).toString("base64");
    const backingVersion = "9.9.9-" + selected.pkg.slice("@openai/codex-".length);
    const mainMetadata = JSON.stringify({ name: "@openai/codex", version: "9.9.9",
      optionalDependencies: { [selected.pkg]: "npm:@openai/codex@" + backingVersion },
      dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-9.9.9.tgz" } });
    const backingMetadata = JSON.stringify({ name: "@openai/codex", version: backingVersion,
      dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-" + backingVersion + ".tgz" } });
    writeFileSync(join(fakeBin, "npm"), [
      "#!/bin/sh",
      'case "$*" in',
      `  *codex@${backingVersion}*--json*) printf '%s\\n' '${backingMetadata}'; exit 0 ;;`,
      `  *--json*) printf '%s\\n' '${mainMetadata}'; exit 0 ;;`,
      "esac",
      'case "$*" in',
      '  *dist.integrity*) printf "%s\n" ' + JSON.stringify(integrity) + " ;;",
      '  *dist.tarball*) printf "%s\n" "https://registry.npmjs.org/@openai/codex/-/codex-9.9.9.tgz" ;;',
      '  *) printf "%s\n" "9.9.9" ;;',
      "esac",
      "",
    ].join("\n"));
    chmodSync(join(fakeBin, "npm"), 0o755);
    const boundPath = [fakeBin, join(prefix, "bin"), join(node!, ".."), "/usr/bin", "/bin"].join(":");

    const planEnv = {
      HOME: home,
      PATH: boundPath,
      TMPDIR: join(root, "tmp"),
      OPENCODEX_HOME: join(home, "ocx"),
      CODEX_CLI_PATH: launcher,
      OCX_NO_DESKTOP_HANDOFF: "1",
      OPENCODEX_BUN_PATH: bun!,
    };
    const runPlan = (env: NodeJS.ProcessEnv = planEnv) => spawnSync(node!, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "plan", "--json"], {
      cwd: repoRoot(), encoding: "utf8", timeout: 30_000,
      env,
    });

    // The real process scan sees every Codex session on this host, and the plan
    // rightly refuses while one runs. That refusal still reports the content
    // digest, so the digest is the host-independent binding; plan ids are
    // compared as well whenever both runs found an idle host (as on CI).
    const bound = (result: ReturnType<typeof runPlan>) => {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.managed).toBe(true);
      expect(plan.installContentDigest).toMatch(/^[0-9a-f]{64}$/);
      if (!plan.applicable) {
        expect(plan.refusal).toBe("blocked_active_session");
        expect(plan.session.state).toBe("active");
      }
      return { digest: plan.installContentDigest as string, planId: plan.applicable ? plan.planId as string : null };
    };
    const expectSame = (a: ReturnType<typeof bound>, b: ReturnType<typeof bound>) => {
      expect(b.digest).toBe(a.digest);
      if (a.planId !== null && b.planId !== null) expect(b.planId).toBe(a.planId);
    };
    const expectChanged = (a: ReturnType<typeof bound>, b: ReturnType<typeof bound>) => {
      expect(b.digest).not.toBe(a.digest);
      if (a.planId !== null && b.planId !== null) expect(b.planId).not.toBe(a.planId);
    };
    const first = bound(runPlan());

    // Re-running on untouched bytes reproduces the same plan.
    expectSame(first, bound(runPlan()));

    // An oversized NODE_PATH cannot overflow the serialized launch context:
    // the launcher drops the optional lookup seed instead, so the snapshot
    // still parses, the nested-lane binding (which needs no global lookup) is
    // unaffected, and the same plan is produced — only lanes that would need
    // the dropped seed become unverifiable. 80KiB stays under Linux's
    // per-string MAX_ARG_STRLEN so the spawn itself is not the refusal.
    expectSame(first, bound(runPlan({ ...planEnv, NODE_PATH: "/d".repeat(40 * 1024) })));

    // A same-length byte change to the entrypoint is a different install. The
    // mtime is restored too, so only content can drive the plan-id change.
    const entrypoint = join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
    const mutate = (path: string, from: string, to: string) => {
      const before = readFileSync(path, "utf8");
      const stat = statSync(path);
      expect(before.includes(from)).toBe(true);
      const replaced = before.replace(from, to);
      expect(replaced.length).toBe(before.length);
      writeFileSync(path, replaced);
      utimesSync(path, stat.atime, stat.mtime);
    };
    mutate(entrypoint, "synthetic fixture", "synthetic FIXTURE");
    const entryPlan = bound(runPlan());
    expectChanged(first, entryPlan);

    // A same-length change to the vendored native backing is a different plan too.
    const backingPkgName = selected.pkg.split("/")[1];
    const installedBackingExe = join(
      prefix, "lib", "node_modules", "@openai", backingPkgName,
      "vendor", selected.triple, "bin", "codex",
    );
    mutate(installedBackingExe, "native-backing", "native-BACKING");
    expectChanged(entryPlan, bound(runPlan()));

    // Removing the required backing makes the plan refuse, never silently rebind.
    // This refusal precedes the session scan, so it holds on every host.
    rmSync(join(prefix, "lib", "node_modules", "@openai", backingPkgName), { recursive: true, force: true });
    const removed = runPlan();
    expect(removed.status).toBe(0);
    const removedPlan = JSON.parse(removed.stdout);
    expect(removedPlan.applicable).toBe(false);
    expect(removedPlan.refusal).toBe("install_content_unverified");
  }, 60_000);
});

function inspectionContext(transportEnv?: unknown, extra: Record<string, unknown> = {}) {
  const proof = "T".repeat(43);
  return initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], {
    [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
      codexCliInspectionEnv: { codexCliPath: null, path: "", pathExt: null, managerRoots: {},
        configDir: "/fixture", transportEnv, ...extra },
    }),
  });
}

describe("Codex CLI launcher architecture snapshot", () => {
  // An arch this Bun process is not running, so the forwarded value is
  // distinguishable from the process.arch fallback on every host.
  const foreign = process.arch === "x64" ? "arm64" : "x64";

  test("a known launcher arch is kept and an absent one stays null", () => {
    expect(inspectionContext(undefined, { arch: foreign })?.codexCliInspectionEnv?.arch).toBe(foreign);
    expect(inspectionContext(undefined, {})?.codexCliInspectionEnv?.arch).toBeNull();
  });

  test.each(["x86_64", "", 64, ["x64"]].map(value => ({ value })))("an unknown arch fails the context closed %#", row => {
    expect(inspectionContext(undefined, { arch: row.value })).toBeNull();
  });

  test("inspection selects the backing by the Node launcher's arch, not Bun's", async () => {
    inspectionContext(undefined, { arch: foreign });
    let inspectedArch: string | undefined;
    expect(await handleCodexCliUpdateCommand(["check", "--json"], {
      resolveSelectedRuntime: () => ({ runtime: null, failures: [] }),
      inspectInstall: async deps => {
        inspectedArch = deps.arch;
        return inspectCodexCliInstall(deps);
      },
    })).toBe(0);
    expect(inspectedArch).toBe(foreign);
  });
});

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
      versionEvidence: { kind: "package-manifest" }, installDigest: "a".repeat(64),
      installContentDigest: "b".repeat(64) }),
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    spawnProcess: (_command, args, options) => {
      requireEvidence(equal(captureCodexCliTransportEnv(options.env)), "npm transport mismatch");
      requireEvidence(options.env.PATH === ${JSON.stringify(tools)}, "npm PATH mismatch");
      queries++;
      requireEvidence(args[0] === "view" && args.includes("--json"), "exact artifact metadata query missing");
      const requested = args[1].slice(args[1].lastIndexOf("@") + 1);
      const version = requested === "latest" ? "1.1.0" : requested;
      return { status: 0, stdout: JSON.stringify({ name: "@openai/codex", version,
        optionalDependencies: version === "1.1.0" ? Object.fromEntries(
          ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]
            .map(suffix => ["@openai/codex-" + suffix, "npm:@openai/codex@1.1.0-" + suffix])) : undefined,
        dist: { integrity: "sha512-" + Buffer.alloc(64, 7).toString("base64"),
          tarball: "https://registry.npmjs.org/@openai/codex/-/codex-" + version + ".tgz" } }), stderr: "" };
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
