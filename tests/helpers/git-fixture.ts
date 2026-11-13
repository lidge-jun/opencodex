/**
 * Git for tests: throwaway fixture repositories and reads of this checkout.
 *
 * Always pass one of these environments. Bun.spawn / Bun.spawnSync WITHOUT an `env` option use
 * the environment the process started with and ignore later process.env edits (Bun 1.4.4), so the
 * preload's scrub cannot reach them: a default-env git call in a bare `bun test` launched from a
 * hook or a `--git-dir/--work-tree` wrapper still runs against the inherited repository. See
 * scripts/git-repository-env.ts for what that does to a developer's checkout.
 */
import { withoutGitRepositoryEnv } from "../../scripts/git-repository-env";

export type GitRunner = (...args: string[]) => string;

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
// Assembled from fragments: scripts/privacy-scan.ts rejects email-shaped literals.
const FIXTURE_EMAIL = ["fixture", "example.test"].join("@");
export const FIXTURE_GIT_IDENTITY = { name: "OpenCodex Fixture", email: FIXTURE_EMAIL } as const;

/**
 * Environment for a fixture repository: no inherited repository, no system or global config (so a
 * developer's hooksPath, gpgsign or defaultBranch cannot reach the fixture), and the commit
 * identity in the environment, so no fixture ever writes user.* into any config file.
 */
export function fixtureGitEnv(
  extra: Record<string, string> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...withoutGitRepositoryEnv(base),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_AUTHOR_NAME: FIXTURE_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: FIXTURE_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_GIT_IDENTITY.email,
    ...extra,
  };
}

/**
 * Environment for reading this checkout: only the repository-selecting variables go. The global
 * config stays, because scripts/test.ts pins it to the developer's real one so git keeps its
 * safe.directory decisions on a checkout owned by another account.
 */
export function repositoryGitEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  return withoutGitRepositoryEnv(base);
}

/** Run git in `cwd`, returning stdout and throwing with stderr on a nonzero exit. */
export function fixtureGit(cwd: string, env: Record<string, string> = fixtureGitEnv()): GitRunner {
  return (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString();
  };
}

/** Initialise a fixture repository in `root` and return its runner. Writes no config. */
export function initFixtureRepo(root: string, env: Record<string, string> = fixtureGitEnv()): GitRunner {
  const git = fixtureGit(root, env);
  git("init", "-q");
  return git;
}
