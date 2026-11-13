/**
 * Git runners for throwaway fixture repositories created by tests.
 */
export type GitRunner = (...args: string[]) => string;

/** Run git in `cwd`, returning stdout and throwing with stderr on a nonzero exit. */
export function fixtureGit(cwd: string): GitRunner {
  return (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString();
  };
}

/** Initialise a fixture repository in `root` and return its runner. */
export function initFixtureRepo(root: string): GitRunner {
  const git = fixtureGit(root);
  git("init", "-q");
  git("config", "user.email", ["a", "b.com"].join("@"));
  git("config", "user.name", "t");
  return git;
}
