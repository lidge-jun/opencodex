import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Every spawnSync below is bounded by the shared spawned-child deadline: Bun's test
 * timeout cannot interrupt a synchronous wait, so an unbounded child that wedges on
 * a lock or a runner stall pins its whole batch until the shard deadline cuts it
 * (Linux test 1/4, run 37730984813). A bounded child fails this one test instead.
 *
 * Local push validation ("bun run prepush") typechecks the root project only:
 * tsconfig.json has no project references, so "bun x tsc --noEmit" never parses
 * gui/. A gui compile error therefore ships silently and first surfaces in CI's
 * gates "GUI build" step — which a fork pull request never runs (no repository
 * CI on forks), so it reached ready-for-review as #6471 before any maintainer
 * build. lint/doctor already gate local pushes with the same if-changed shape,
 * so the gui type gate reuses it and the tests below pin the checked-in files
 * rather than copies of them.
 */
const rootPkg = readFileSync(repoPath("package.json"), "utf8");
const prepush = rootPkg.match(/"prepush": "([^"]+)"/)![1]!;
const typecheckGuiIfChangedScript = fileURLToPath(new URL("../../scripts/typecheck-gui-if-changed.ts", import.meta.url));

describe("gui typecheck if-changed gate", () => {
  test("root exposes the gui typecheck gate script", () => {
    expect(rootPkg).toContain('"typecheck:gui:if-changed": "bun scripts/typecheck-gui-if-changed.ts"');
  });

  test("prepush runs the gui typecheck gate after the root typecheck", () => {
    expect(prepush).toContain("bun run typecheck:gui:if-changed");
    expect(prepush.indexOf("bun run typecheck")).toBeLessThan(prepush.indexOf("bun run typecheck:gui:if-changed"));
  });

  test("the if-changed gate runs on gui/ changes, skips otherwise, and fails the push on a compile error", () => {
    const dryRun = (files: string): string => {
      const probe = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
        env: { ...process.env, TYPECHECK_DRY_RUN: "1", TYPECHECK_FILES: files },
        timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL",
      });
      return probe.stdout.toString().trim();
    };
    expect(dryRun("gui/src/App.tsx\nscripts/x.ts")).toBe("typecheck:run");
    expect(dryRun("scripts/x.ts\nREADME.md")).toBe("typecheck:skip");

    // A Bun stub stands in for the compiler so the failure path is deterministic on every
    // platform (native Windows has no `false`). A distinctive code proves the compiler's exit
    // status propagates unchanged rather than the gate always returning 1.
    const stubCompiler = JSON.stringify([process.execPath, "-e", "process.exit(23)"]);
    const failing = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "gui/src/App.tsx",
        TYPECHECK_CMD: stubCompiler,
      },
      timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL",
    });
    expect(failing.exitCode).toBe(23);

    // A compiler that cannot be spawned is a real failure, not a skip.
    const missing = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "gui/src/App.tsx",
        TYPECHECK_CMD: JSON.stringify(["ocx-gui-typecheck-missing-compiler"]),
      },
      timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL",
    });
    expect(missing.exitCode).toBe(1);

    const skipping = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "scripts/x.ts\nREADME.md",
        TYPECHECK_CMD: stubCompiler,
      },
      timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL",
    });
    expect(skipping.exitCode).toBe(0);
  });

  describe("base selection against a real repository", () => {
    // The script finds its repository from its own location, so each fixture is a fresh git repo
    // holding a copy of the checked-in script. Only the run/skip decision is observed.
    const fixtures: string[] = [];
    afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    const gitEnv = (): Record<string, string> => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
      }
      return { ...env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_NOSYSTEM: "1" };
    };
    const repo = (): { dir: string; git: (...args: string[]) => void; commit: (path: string) => void; decide: () => string } => {
      const dir = mkdtempSync(join(tmpdir(), "ocx-gui-typecheck-"));
      fixtures.push(dir);
      const git = (...args: string[]): void => {
        const run = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv(), timeout: INTERNAL_DEADLINE_MS });
        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
      };
      const commit = (path: string): void => {
        mkdirSync(join(dir, dirname(path)), { recursive: true });
        writeFileSync(join(dir, path), `${path}\n`);
        git("add", "--", path);
        git("commit", "-q", "-m", path);
      };
      git("init", "-q", "-b", "dev");
      // git's default; pinned so a global core.quotePath=false cannot hide the quoting case.
      git("config", "core.quotePath", "true");
      mkdirSync(join(dir, "scripts"));
      copyFileSync(typecheckGuiIfChangedScript, join(dir, "scripts", "typecheck-gui-if-changed.ts"));
      commit("README.md");
      const decide = (): string => {
        const env = { ...gitEnv(), TYPECHECK_DRY_RUN: "1" };
        delete env.TYPECHECK_FILES;
        const probe = Bun.spawnSync([process.execPath, join(dir, "scripts", "typecheck-gui-if-changed.ts")], { cwd: dir, env, timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL" });
        return probe.stdout.toString().trim();
      };
      return { dir, git, commit, decide };
    };

    test("a branch that touches only non-gui files skips, and one gui commit runs", () => {
      const fixture = repo();
      fixture.git("checkout", "-q", "-b", "feature");
      fixture.commit("scripts/other.ts");
      expect(fixture.decide()).toBe("typecheck:skip");
      fixture.commit("gui/src/App.tsx");
      expect(fixture.decide()).toBe("typecheck:run");
    });

    test("moving a file out of gui/ still counts as a gui change", () => {
      // git's rename detection would report only the destination (config/...), hiding that gui/ lost a file.
      const fixture = repo();
      fixture.commit("gui/tsconfig.node.json");
      fixture.git("checkout", "-q", "-b", "feature");
      mkdirSync(join(fixture.dir, "config"));
      fixture.git("mv", "gui/tsconfig.node.json", "config/tsconfig.node.json");
      fixture.git("commit", "-q", "-m", "move");
      expect(fixture.decide()).toBe("typecheck:run");
    });

    test("a non-ASCII gui path still counts as a gui change", () => {
      // Without -z, git quotes this name ("gui/src/\303\274ber.tsx") and the gui/ prefix check misses it.
      const fixture = repo();
      fixture.git("checkout", "-q", "-b", "feature");
      fixture.git("branch", "-q", "--set-upstream-to=dev");
      fixture.commit("gui/src/über.tsx");
      expect(fixture.decide()).toBe("typecheck:run");
    });

    test("a gui change already on the tracking branch still runs", () => {
      // The tracking branch holds the gui commit; comparing against @{u} would see nothing to check.
      const fixture = repo();
      fixture.git("checkout", "-q", "-b", "feature");
      fixture.commit("gui/src/App.tsx");
      fixture.git("branch", "-q", "tracked");
      fixture.git("branch", "-q", "--set-upstream-to=tracked");
      expect(fixture.decide()).toBe("typecheck:run");
    });

    test("a diff that git cannot compute runs the check instead of skipping", () => {
      // dev and HEAD share no history, so "dev...HEAD" has no merge base and git diff fails.
      const fixture = repo();
      fixture.git("checkout", "-q", "--orphan", "unrelated");
      fixture.git("rm", "-rq", "--cached", "README.md");
      fixture.commit("scripts/other.ts");
      fixture.git("branch", "-q", "--set-upstream-to=dev");
      expect(fixture.decide()).toBe("typecheck:run");
    });
  });

  test("ci gates keeps the GUI build step under the gui path filter", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ name?: string; if?: string; run?: string }> }>;
    };
    const gatesSteps = workflow.jobs.gates?.steps ?? [];
    const guiBuild = gatesSteps.find(step => step.name === "GUI build");
    expect(guiBuild).toBeDefined();
    expect(guiBuild!.if).toBe("needs.changes.outputs.gui == 'true'");
    expect((guiBuild!.run ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)).toEqual(["cd gui", "bun run build"]);
  });
});

const scripts = JSON.parse(readFileSync(repoPath("package.json"), "utf8")).scripts as Record<string, string>;
const config = readFileSync(repoPath("tsconfig.json"), "utf8");
const roots: string[] = [];
const compilerLinks: string[] = [];
afterEach(() => {
  for (const path of compilerLinks.splice(0)) unlinkSync(path);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function nativeTypecheckFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-typecheck-"));
  roots.push(root);
  writeFileSync(join(root, "tsconfig.json"), config);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: { typecheck: scripts.typecheck, "typecheck:tsc": scripts["typecheck:tsc"], check: "bun check-trap.ts" },
  }));
  writeFileSync(join(root, "check-trap.ts"), "process.exit(23);\n");
  // Package scripts must select the installed runtime, even on the older test-runner Bun.
  symlinkSync(repoPath("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const files = {
    "src/config.json": '{"port":8080}',
    "src/marker.d.mts": "export interface Marker { id: string }\n",
    "src/main.ts": [
      'import { z } from "zod";',
      'import defaults from "./config.json";',
      'import type { Marker } from "./marker.mjs";',
      'const Schema = z.object({ port: z.number(), kind: z.literal("port") });',
      'export const parsed: z.infer<typeof Schema> = { port: defaults.port, kind: "port" };',
      'export const marker: Marker = { id: "marker" };',
      'export const pending: Promise<string> = Bun.file("fixture.txt").text();',
    ].join("\n"),
    "gui/ignored.ts": 'export const intentionallyExcluded: number = "bad";\n',
  };
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

function runTypecheck(root: string, script: string) {
  const result = Bun.spawnSync([process.execPath, "run", script], {
    cwd: root, timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL", stdin: "ignore",
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("native and reference typecheck honor root scope and declarations without running a check script or emitting files", () => {
  const root = nativeTypecheckFixture();
  for (const script of ["typecheck", "typecheck:tsc"]) {
    const result = runTypecheck(root, script);
    expect(result.exitCode, result.output).toBe(0);
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(existsSync(join(root, "src", "main.js"))).toBe(false);
  }
}, SPAWN_BUDGET_MS);

test("native and reference typecheck reject strict errors in an unimported source file", () => {
  const root = nativeTypecheckFixture();
  writeFileSync(join(root, "src", "broken.ts"), [
    "export function untyped(value) { return value; }",
    'export const count: number = "text";',
    "const candidate: { port: number } | undefined = Math.random() ? { port: 1 } : undefined;",
    "export const port: number = candidate.port;",
    'export const labels: Record<"ready" | "missing", string> = { ready: "Ready" };',
    "// @ts-expect-error",
    "export const okay: number = 42;",
  ].join("\n"));
  for (const script of ["typecheck", "typecheck:tsc"]) {
    const result = runTypecheck(root, script);
    expect(result.exitCode, result.output).not.toBe(0);
    const codes = [...new Set([...result.output.matchAll(/\bTS(\d+)\b/g)].map(match => Number(match[1])))];
    expect(codes.sort((left, right) => left - right), result.output).toEqual([2322, 2578, 2741, 7006, 18048]);
    expect(existsSync(join(root, "dist"))).toBe(false);
  }
}, SPAWN_BUDGET_MS);

function prepublishFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-prepublish-typecheck-"));
  roots.push(root);
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  const compiler = join(root, "node_modules", "typescript");
  symlinkSync(repoPath("node_modules", "typescript"), compiler, process.platform === "win32" ? "junction" : "dir");
  compilerLinks.push(compiler);
  if (process.platform === "win32") {
    for (const name of ["tsc.exe", "tsc.bunx"]) {
      copyFileSync(repoPath("node_modules", ".bin", name), join(root, "node_modules", ".bin", name));
    }
  } else {
    const shim = join(root, "node_modules", ".bin", "tsc");
    symlinkSync(repoPath("node_modules", "typescript", "bin", "tsc"), shim);
    compilerLinks.push(shim);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
    // Exercise the real hook and compiler; only audit/build side effects are replaced.
    prepublishOnly: scripts.prepublishOnly,
    "typecheck:tsc": `${scripts["typecheck:tsc"]} && bun phase.ts compiler`,
    typecheck: `${scripts.typecheck} && bun phase.ts native`,
    "audit:high": "bun phase.ts audit",
    "build:gui": "bun phase.ts build",
  } }));
  writeFileSync(join(root, "phase.ts"), [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync("phases.log", process.argv[2] + "\\n");',
    'if (process.env.FAIL_PHASE === process.argv[2]) process.exit(29);',
  ].join("\n"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, types: [], outDir: "dist" }, files: ["main.ts"],
  }));
  writeFileSync(join(root, "main.ts"), "export const count: number = 1;\n");
  return root;
}

function runPrepublish(root: string, failPhase?: string) {
  // Reuse the caller runtime, without the repository's installed Bun shadowing it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  const result = Bun.spawnSync([process.execPath, "run", "prepublishOnly"], {
    cwd: root, timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL", stdin: "ignore",
    env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, FAIL_PHASE: failPhase ?? "" },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    phases: readFileSync(join(root, "phases.log"), "utf8").trim().split(/\r?\n/),
  };
}

test("prepublishOnly runs the reference compiler between audit and build without emitting files", () => {
  const root = prepublishFixture();
  const result = runPrepublish(root);
  expect(result.exitCode, result.output).toBe(0);
  expect(result.phases).toEqual(["audit", "compiler", "build"]);
  expect(existsSync(join(root, "dist"))).toBe(false);
  expect(existsSync(join(root, "main.js"))).toBe(false);
}, SPAWN_BUDGET_MS);

test("prepublishOnly stops before typecheck and build when audit fails", () => {
  const result = runPrepublish(prepublishFixture(), "audit");
  expect(result.exitCode, result.output).toBe(29);
  expect(result.phases).toEqual(["audit"]);
}, SPAWN_BUDGET_MS);

test("prepublishOnly stops before build when the reference compiler rejects strict errors", () => {
  const root = prepublishFixture();
  writeFileSync(join(root, "main.ts"), 'export const count: number = "bad";\n');
  const result = runPrepublish(root);
  expect(result.exitCode, result.output).not.toBe(0);
  expect(result.output).toContain("TS2322");
  expect(result.phases).toEqual(["audit"]);
}, SPAWN_BUDGET_MS);
