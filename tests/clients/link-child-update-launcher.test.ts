import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteUpdateApplyArgv, remoteUpdatePlanArgv } from "../../src/link/child-gated-ocx";
import { recordServingRuntime } from "../../src/config/serving-runtimes";

// A4: which program receives which arguments when the Home plans and applies an update on a package-installed Child.
// The real gated script runs under sh against stub bun and node executables; nothing here installs anything.
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const NOT_AFTER = 1_900_000_000_000;
const posix = test.skipIf(process.platform === "win32");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The shipped script with the machine's own install locations swapped for missing paths. */
function isolated(argv: string[]): string[] {
  const copy = [...argv];
  copy[2] = copy[2]!.replace('export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"', 'export PATH="$PATH"')
    .replace('"/Applications/OpenCodex.app/Contents/MacOS/ocx"', '"$HOME/missing-app"').replace('"/usr/bin/ocx"', '"$HOME/missing-system"');
  return copy;
}

function stubNode(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo v22.11.0; exit 0; fi\n"
    + "printf '%s\\n' \"$*\" >> \"$HOME/node.log\"\nprintf '%s\\n' \"${OCX_UPDATE_ORCHESTRATED_CHILD-unset}\" >> \"$HOME/node.env\"\nprintf 'ran\\n'\n", { mode: 0o755 });
}

/**
 * A package install at root, served through the census pair [bun, root/src/cli/index.ts]. The stub bun answers the
 * gate's version probe with version and logs every other call; it is outside root so only the census selects it.
 */
function install(root: string, options: { version?: string; launcherFile?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ocx-launcher-")); dirs.push(home);
  const bin = join(home, "bin"); mkdirSync(bin);
  for (const command of ["sh", "uname", "mktemp", "sleep", "cat", "awk", "dd", "wc", "rm", "date"]) {
    const executable = Bun.which(command);
    if (!executable) throw new Error("Required test tool not found on PATH: " + command);
    symlinkSync(executable, join(bin, command));
  }
  const pkg = join(home, root);
  const entry = join(pkg, "src", "cli", "index.ts");
  mkdirSync(join(pkg, "src", "cli"), { recursive: true });
  writeFileSync(entry, "// entry\n");
  if (options.launcherFile !== false) { mkdirSync(join(pkg, "bin"), { recursive: true }); writeFileSync(join(pkg, "bin", "ocx.mjs"), "// launcher\n"); }
  const bun = join(home, "runtime", "bun");
  mkdirSync(join(home, "runtime"));
  writeFileSync(bun, "#!/bin/sh\nif [ \"$2\" = --version ]; then printf 'opencodex " + (options.version ?? "2.98.0") + "\\n'; exit 0; fi\n"
    + "printf '%s\\n' \"$*\" >> \"$HOME/bun.log\"\nprintf 'ran\\n'\n", { mode: 0o755 });
  recordServingRuntime({ command: [bun, entry], version: options.version ?? "2.98.0", servedAt: "2026-11-09T00:00:00.000Z" }, join(home, "ocx-home"));
  return { home, bin, pkg, entry };
}

function run(fixture: { home: string; bin: string }, argv: string[], extraPath: string[] = [], env: Record<string, string> = {}) {
  const { home, bin } = fixture;
  const proc = Bun.spawnSync(isolated(argv), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home,
    PATH: [...extraPath, bin].join(":"), ...env }, stdout: "pipe", stderr: "pipe" });
  const read = (name: string) => existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : "";
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), bun: read("bun.log"), node: read("node.log"),
    nodeEnv: read("node.env"), remaining: readdirSync(home).filter(name => name.startsWith("ocx-fanout.")) };
}

const plan = () => remoteUpdatePlanArgv("2.100.0", "posix");
const apply = (viaLauncher: boolean) => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: NOT_AFTER, viaLauncher }, "posix");
const APPLY_ARGS = "update --yes --json --version 2.100.0 --expect-plan " + TOKEN + " --not-after " + NOT_AFTER;
const NPM_ROOT = join("prefix", "lib", "node_modules", "@bitkyc08", "opencodex");

describe("A4 launcher route on fake package installs", () => {
  posix("npm global: apply runs <prefix>/bin/node <root>/bin/ocx.mjs", () => {
    const fixture = install(NPM_ROOT);
    stubNode(join(fixture.home, "prefix", "bin", "node"));
    const result = run(fixture, apply(true));
    expect(result.code).toBe(0);
    expect(result.node).toBe(join(fixture.pkg, "bin", "ocx.mjs") + " " + APPLY_ARGS + "\n");
    expect(result.bun).not.toContain("update");
    expect(result.stderr.trimEnd().split("\n")).toEqual(["ocx-fanout:selected:2.98.0", "ocx-fanout:entry:pair", "ocx-fanout:launcher:exec"]);
    expect(result.stdout).toBe("ocx-fanout:stdout-begin\nran\n");
    expect(result.remaining).toEqual([]);
  });

  posix("npm global: plan stays on the pair and reports the launcher", () => {
    const fixture = install(NPM_ROOT);
    stubNode(join(fixture.home, "prefix", "bin", "node"));
    const result = run(fixture, plan());
    expect(result.code).toBe(0);
    expect(result.bun).toBe(fixture.entry + " update --plan --json --version 2.100.0\n");
    expect(result.stderr).toContain("ocx-fanout:launcher:available\n");
    expect(result.node).toBe("");
    expect(result.remaining).toEqual([]);
  });

  posix("the plan never exits on a missing Node", () => {
    const fixture = install(NPM_ROOT);
    const result = run(fixture, plan());
    expect(result.code).toBe(0);
    expect(result.bun).toBe(fixture.entry + " update --plan --json --version 2.100.0\n");
    expect(result.stderr).toContain("ocx-fanout:launcher:unavailable\n");
    expect(result.stderr).not.toContain("child-node-unavailable");
  });

  posix("a Node that does not answer --version counts as missing", () => {
    const fixture = install(NPM_ROOT);
    const broken = join(fixture.home, "prefix", "bin", "node");
    mkdirSync(join(broken, ".."), { recursive: true });
    writeFileSync(broken, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/node.log\"\nexit 3\n", { mode: 0o755 });
    expect(run(fixture, plan()).stderr).toContain("ocx-fanout:launcher:unavailable\n");
    const applied = run(fixture, apply(true));
    expect(applied.code).toBe(121);
    expect(applied.node).toBe("--version\n--version\n");
  });

  posix("F4: a Node that hangs on --version is killed by its own watchdog and the plan still runs", () => {
    const fixture = install(NPM_ROOT);
    const stuck = join(fixture.home, "prefix", "bin", "node");
    mkdirSync(join(stuck, ".."), { recursive: true });
    writeFileSync(stuck, "#!/bin/sh\nif [ \"$1\" = --version ]; then exec sleep 30; fi\nprintf '%s\\n' \"$*\" >> \"$HOME/node.log\"\n", { mode: 0o755 });
    // The kill path is the subject: the shipped 10 s Node budget is pinned, then shortened to 1 s for the run.
    const argv = plan();
    expect(argv[2]!.split("( sleep 10 & ntimer=$!;").length).toBe(2);
    argv[2] = argv[2]!.replace("( sleep 10 & ntimer=$!;", "( sleep 1 & ntimer=$!;");
    const started = Date.now();
    const result = run(fixture, argv);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("ocx-fanout:launcher:unavailable\n");
    expect(result.bun).toBe(fixture.entry + " update --plan --json --version 2.100.0\n");
    expect(result.node).toBe("");
  });

  posix("Bun global: plan and apply stay on the served Bun entry", () => {
    const fixture = install(join(".bun", "install", "global", "node_modules", "@bitkyc08", "opencodex"));
    const nodeDir = join(fixture.home, "path-node");
    stubNode(join(nodeDir, "node"));
    const planned = run(fixture, plan(), [nodeDir]);
    expect(planned.code).toBe(0);
    const applied = run(fixture, apply(false), [nodeDir]);
    expect(applied.code).toBe(0);
    expect(applied.bun).toBe(fixture.entry + " update --plan --json --version 2.100.0\n" + fixture.entry + " " + APPLY_ARGS + "\n");
    expect(applied.node).toBe("");
    expect(applied.stderr).not.toContain("launcher:exec");
    rmSync(join(fixture.home, "bun.log"));
    rmSync(nodeDir, { recursive: true });
    expect(run(fixture, plan()).code).toBe(0);
    const noNode = run(fixture, apply(false));
    expect(noNode.code).toBe(0);
    expect(noNode.bun).toBe(fixture.entry + " update --plan --json --version 2.100.0\n" + fixture.entry + " " + APPLY_ARGS + "\n");
  });

  posix("pnpm layout uses the Node on PATH", () => {
    const fixture = install(join("pnpm", "global", "5", "node_modules", "@bitkyc08", "opencodex"));
    const nodeDir = join(fixture.home, "path-node");
    stubNode(join(nodeDir, "node"));
    const result = run(fixture, apply(true), [nodeDir]);
    expect(result.code).toBe(0);
    expect(result.node).toBe(join(fixture.pkg, "bin", "ocx.mjs") + " " + APPLY_ARGS + "\n");
    expect(result.bun).toBe("");
  });

  posix("apply without Node exits 121 child-node-unavailable and nothing ran", () => {
    const fixture = install(NPM_ROOT);
    const result = run(fixture, apply(true));
    expect(result.code).toBe(121);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe("ocx-fanout:child-node-unavailable");
    expect(result.stdout).toBe("");
    expect(result.bun).toBe("");
    expect(result.node).toBe("");
    expect(result.remaining).toEqual([]);
  });

  posix("OCX_UPDATE_ORCHESTRATED_CHILD is cleared before the launcher runs", () => {
    const fixture = install(NPM_ROOT);
    stubNode(join(fixture.home, "prefix", "bin", "node"));
    const result = run(fixture, apply(true), [], { OCX_UPDATE_ORCHESTRATED_CHILD: "1" });
    expect(result.code).toBe(0);
    expect(result.nodeEnv).toBe("unset\n");
  });

  posix("a 2.96 pair never reaches either entry", () => {
    const fixture = install(NPM_ROOT, { version: "2.96.0" });
    stubNode(join(fixture.home, "prefix", "bin", "node"));
    for (const argv of [plan(), apply(true), apply(false)]) {
      const result = run(fixture, argv);
      expect(result.code).toBe(121);
      expect(result.stderr).toBe("ocx-fanout:child-ocx-lacks-orchestrated-update\n");
      expect(result.bun).toBe("");
      expect(result.node).toBe("");
    }
  });

  posix("a source checkout pair keeps the Bun entry even when the apply asks for the launcher", () => {
    const fixture = install(join("src-checkout", "opencodex"));
    stubNode(join(fixture.home, "path-node", "node"));
    const result = run(fixture, apply(true), [join(fixture.home, "path-node")]);
    expect(result.code).toBe(0);
    expect(result.bun).toBe(fixture.entry + " " + APPLY_ARGS + "\n");
    expect(result.node).toBe("");
  });

  posix("a package root without bin/ocx.mjs keeps the Bun entry", () => {
    const fixture = install(NPM_ROOT, { launcherFile: false });
    stubNode(join(fixture.home, "prefix", "bin", "node"));
    const result = run(fixture, apply(true));
    expect(result.code).toBe(0);
    expect(result.bun).toBe(fixture.entry + " " + APPLY_ARGS + "\n");
    expect(result.node).toBe("");
  });
});
