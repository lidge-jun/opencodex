import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "../helpers/repo-root";

/**
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
    });
    expect(failing.exitCode).toBe(23);

    // A compiler that cannot be spawned is a real failure, not a skip.
    const missing = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "gui/src/App.tsx",
        TYPECHECK_CMD: JSON.stringify(["ocx-gui-typecheck-missing-compiler"]),
      },
    });
    expect(missing.exitCode).toBe(1);

    const skipping = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "scripts/x.ts\nREADME.md",
        TYPECHECK_CMD: stubCompiler,
      },
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
        const run = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv() });
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
        const probe = Bun.spawnSync([process.execPath, join(dir, "scripts", "typecheck-gui-if-changed.ts")], { cwd: dir, env });
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
