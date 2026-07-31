import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Local agent/session state must never reach a commit.
 *
 * `.gitignore` alone does not enforce this: `git add -f` overrides it silently,
 * and once a path is tracked the ignore rule stops applying to it entirely. The
 * `.codexclaw/` goalplans and ledgers were committed exactly that way and rode
 * along into `main` and `preview` before anyone noticed.
 *
 * This test closes that gap by asserting against the real index instead of the
 * ignore file, so a forced add fails CI on the commit that introduces it.
 */
const FORBIDDEN_TRACKED_DIRS = [".codexclaw", ".omo", ".claude", "node_modules", ".tmp"];

const FORBIDDEN_TRACKED_FILENAMES = [".DS_Store", "Thumbs.db"];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function trackedEntries(): { mode: string; path: string }[] {
  const result = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files -s failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta?.split(" ")[0] ?? "", path: path ?? "" };
    });
}

describe("repository hygiene", () => {
  test("no local agent or session state is tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      path.split("/").some((segment) => FORBIDDEN_TRACKED_DIRS.includes(segment)),
    );

    expect(offenders).toEqual([]);
  });

  test("no OS metadata files are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      FORBIDDEN_TRACKED_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  test("gitignore still declares the agent-state directories", async () => {
    const ignore = await Bun.file(new URL("../.gitignore", import.meta.url)).text();

    for (const dir of FORBIDDEN_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }
  });
});

/**
 * `devlog/` is a private submodule, and public CI must never need it.
 *
 * The failure mode this locks down is specific and has already happened twice:
 * a `160000` gitlink lands in the index for a path no workflow initializes, and
 * `actions/checkout` fails for every contributor. Keeping the pointer loose —
 * one gitlink, `ignore = dirty`, `update = none`, no `submodules:` in any
 * workflow — is what makes an inaccessible private repository harmless.
 */
describe("devlog submodule stays loose", () => {
  test("devlog is the only gitlink, and no devlog file is tracked here", () => {
    const gitlinks = trackedEntries().filter((entry) => entry.mode === "160000");

    expect(gitlinks.map((entry) => entry.path)).toEqual(["devlog"]);

    const devlogFiles = trackedFiles().filter((path) => path.startsWith("devlog/"));
    expect(devlogFiles).toEqual([]);
  });

  test("gitmodules keeps the submodule non-blocking", async () => {
    const gitmodules = await Bun.file(new URL("../.gitmodules", import.meta.url)).text();

    expect(gitmodules).toContain('[submodule "devlog"]');
    expect(gitmodules).toContain("ignore = dirty");
    expect(gitmodules).toContain("update = none");
  });

  test("no workflow checks out submodules", async () => {
    const listing = Bun.spawnSync(["git", "ls-files", ".github/workflows"], { cwd: repoRoot });
    const workflows = new TextDecoder()
      .decode(listing.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(workflows.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const workflow of workflows) {
      const text = await Bun.file(new URL(`../${workflow}`, import.meta.url)).text();
      // `submodules: false` is fine; anything that opts in is not.
      if (/submodules:\s*(true|recursive)/.test(text)) offenders.push(workflow);
      if (/git submodule update[^\n]*devlog/.test(text)) offenders.push(workflow);
    }

    expect(offenders).toEqual([]);
  });
});
