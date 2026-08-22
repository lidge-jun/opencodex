import type { CommandRunner } from "./types";

export async function isAncestor(
  runner: CommandRunner,
  commit: string,
  intoRef: string,
): Promise<boolean> {
  const result = await runner([
    "merge-base",
    "--is-ancestor",
    commit,
    intoRef,
  ]);

  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;

  throw new Error(
    result.stderr.trim()
    || `git merge-base --is-ancestor failed with exit code ${result.exitCode}`,
  );
}

export async function uncontained(
  runner: CommandRunner,
  commits: readonly string[],
  intoRef: string,
): Promise<string[]> {
  const missing: string[] = [];

  for (const commit of commits) {
    if (!(await isAncestor(runner, commit, intoRef))) {
      missing.push(commit);
    }
  }

  return missing;
}
