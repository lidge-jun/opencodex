/**
 * Git environment variables that choose WHICH repository, work tree, index, object store or
 * config source a git command uses.
 *
 * The list is git's own `git rev-parse --local-env-vars` (git 2.53): the variables git itself
 * clears before it runs a command inside another repository. A process that inherits them from a
 * hook, `git rebase --exec`, `git bisect run` or a `--git-dir/--work-tree` wrapper sends every
 * git command it spawns to THAT repository, whatever its cwd says. In a test helper that means
 * `git init` in a temp directory reinitialises the inherited repository (writing core.worktree
 * when GIT_WORK_TREE is set), `git config` writes its .git/config, and add/commit land in it. A
 * shared checkout once gained user.name/user.email from a fixture and a core.worktree pointing at
 * a deleted temp tree exactly this way. `tests/ci-workflows/test-git-isolation.test.ts` keeps the
 * list a superset of what the installed git reports.
 */
export const GIT_REPOSITORY_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_INTERNAL_SUPER_PREFIX",
] as const;

const NAMES = new Set<string>(GIT_REPOSITORY_ENV);
// GIT_CONFIG_COUNT pairs with numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>; drop the pairs too.
const CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/** Windows environment names are case-insensitive, so the match is too. */
export function isGitRepositoryEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return NAMES.has(upper) || CONFIG_PAIR.test(upper);
}

export function gitRepositoryEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(isGitRepositoryEnvName);
}

/** A copy of `env` without the repository-selecting variables (and without undefined values). */
export function withoutGitRepositoryEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isGitRepositoryEnvName(name)) out[name] = value;
  }
  return out;
}
