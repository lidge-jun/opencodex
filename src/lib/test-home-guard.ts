/**
 * Fail-closed protection for the user's REAL OpenCodex home while tests run.
 *
 * A management-route unit test once passed an in-memory fixture config to a handler
 * that persisted it through the process-global writer, replacing a live 41KB,
 * ten-provider `~/.opencodex/config.json` with an 874-byte fixture on a real machine.
 * Credentials survived only because the store files are separate; the providers were
 * recoverable only because an unrelated backup snapshot happened to exist.
 * (devlog `_plan/260730_codex_rs_upstream_v2_live_handoff/070`.)
 *
 * Two properties matter more than breadth here:
 *
 * 1. It must be INERT in production. Guessing "am I a test?" from ecosystem variables
 *    like NODE_ENV would brick `NODE_ENV=test ocx ...` for a user who did nothing
 *    wrong — worse than the bug it prevents. Arming requires OCX_TEST_HOME_GUARD=1,
 *    which only this repository's test preload sets.
 * 2. It must fail CLOSED for code nobody has written yet. So it denies ONE path — the
 *    captured production home — instead of allow-listing known-good test directories.
 *    An allowlist would have to be opted into, and the test that forgets is exactly
 *    how this incident happened.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

const GUARD_ENV = "OCX_TEST_HOME_GUARD";
/**
 * Set by `scripts/test.ts` to the ORIGINAL home before it hands the child a rewritten
 * HOME. On that path `homedir()` already points at the sandbox by the time this module
 * loads, so the true home is only knowable from this hand-off.
 */
const REAL_HOME_ENV = "OCX_REAL_HOME";

/**
 * Resolve symlinks so two spellings of one location compare equal — macOS hands out
 * `/var/folders/...` whose realpath is `/private/var/folders/...` — and so a path that
 * merely *points* at the protected home cannot slip past a string comparison. A path
 * that does not exist yet canonicalizes through its nearest existing ancestor, which is
 * the common case for a config file about to be created.
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  const unresolved: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...unresolved.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      unresolved.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Captured ONCE at module load, before any harness replaces HOME/USERPROFILE. Reading
 * `homedir()` later would return the sandbox and leave the real home unprotected — the
 * guard would be perfectly inverted while its tests still looked green.
 */
const REAL_HOME = process.env[REAL_HOME_ENV]?.trim() || homedir();
const PROTECTED_HOME = canonicalize(join(REAL_HOME, ".opencodex"));
const PROTECTED_CODEX_HOME = canonicalize(join(REAL_HOME, ".codex"));
/**
 * `~/Library/LaunchAgents` needs its own entry because HOME isolation does not reach it:
 * `os.homedir()` reads the password database, not `$HOME`, so a macOS test that rewrites
 * HOME still resolves `plistPath()` to the developer's real LaunchAgents directory. The
 * launchd install tests were doing exactly that — replacing the live
 * `com.opencodex.proxy.plist` with one whose token file, log path and Bun paths all point
 * into a temp sandbox, for as long as the case ran. launchd holds its own parsed copy, so
 * nothing broke until the job next restarted.
 */
const PROTECTED_LAUNCH_AGENTS = canonicalize(join(REAL_HOME, "Library", "LaunchAgents"));

/** The production home this process protects. Exported for the guard's own tests. */
export function protectedHomeForTests(): string {
  return PROTECTED_HOME;
}

/** The production Codex home this process protects when tests write native credentials. */
export function protectedCodexHomeForTests(): string {
  return PROTECTED_CODEX_HOME;
}

export function isTestHomeGuardArmed(): boolean {
  return process.env[GUARD_ENV] === "1";
}

/**
 * Whether `dir` IS the protected production home, decided with the SAME canonicalization as
 * {@link assertNotRealHomeUnderTest}.
 *
 * For the caller that must FILTER the real home out of a candidate list instead of refusing
 * one write: `serviceStatePaths()` in `src/service.ts` keeps a legacy
 * `~/.opencodex/service-state.json` entry so an install made before OPENCODEX_HOME existed
 * can still be found, and under an armed test process that entry is the developer's live
 * record. Exported so that filter cannot drift onto a weaker comparison — `resolve()` alone
 * calls `/var/folders/...` and `/private/var/folders/...` different paths, which is exactly
 * how a macOS sandbox path slips past a string compare.
 */
export function isProtectedHomeUnderTest(dir: string): boolean {
  if (!isTestHomeGuardArmed()) return false;
  return canonicalize(dir) === PROTECTED_HOME;
}

/**
 * Throw when an armed test process is about to write the real OpenCodex home.
 *
 * Call FIRST inside a writer, before any mkdir/chmod/write, so a rejected write leaves
 * nothing behind. Silent no-op when disarmed (production) or when `dir` is any other
 * location, including a suite's own `mkdtemp` fixture — no registration required, which
 * is what keeps the 54 existing suites that write config working untouched.
 */
export function assertNotRealHomeUnderTest(dir: string): void {
  if (!isTestHomeGuardArmed()) return;
  if (canonicalize(dir) !== PROTECTED_HOME) return;
  throw new Error(
    `refusing to write the real OpenCodex home (${PROTECTED_HOME}) from a test process. `
    + "Point OPENCODEX_HOME at a temp directory for this test, or inject persistence "
    + "instead of calling the global writer (see devlog 260730_codex_rs_upstream_v2_live_handoff/070).",
  );
}

/** The production LaunchAgents directory this process protects. Exported for its tests. */
export function protectedLaunchAgentsDirForTests(): string {
  return PROTECTED_LAUNCH_AGENTS;
}

/**
 * Throw when an armed test process is about to write the real `~/Library/LaunchAgents`.
 *
 * Same contract as {@link assertNotRealHomeUnderTest}: call before any mkdir/write, and
 * pass a DIRECTORY. A launchd test gives `installLaunchd` an explicit plist path inside its
 * own fixture directory instead.
 */
export function assertNotRealLaunchAgentsUnderTest(dir: string): void {
  if (!isTestHomeGuardArmed()) return;
  if (canonicalize(dir) !== PROTECTED_LAUNCH_AGENTS) return;
  throw new Error(
    `refusing to write the real LaunchAgents directory (${PROTECTED_LAUNCH_AGENTS}) from a test `
    + "process: os.homedir() ignores HOME, so rewriting HOME does not move this path. Pass an "
    + "explicit plist path inside the test's own fixture directory instead.",
  );
}

/** Throw when an armed test process is about to write the real native Codex home. */
export function assertNotRealCodexHomeUnderTest(dir: string): void {
  if (!isTestHomeGuardArmed()) return;
  if (canonicalize(dir) !== PROTECTED_CODEX_HOME) return;
  throw new Error(
    `refusing to write the real Codex home (${PROTECTED_CODEX_HOME}) from a test process. `
    + "Point CODEX_HOME at a temp directory for this test before writing native auth.json.",
  );
}

/**
 * The trees a removal must never reach, and the reason each one is named.
 *
 * The writer guard above cannot help here. `rmSync` is plain `node:fs`: it calls no writer of
 * ours, so no assertion of ours runs, and by the time anything could observe the damage the
 * directory is already gone. On 2026-09-15 that is exactly what happened — a test resolved the
 * process-global config directory and removed it, taking every OAuth login, the Codex account
 * store, the service tokens and a 372MB usage ledger with it.
 */
const PROTECTED_TREES: ReadonlyArray<{ path: string; lexical: string; label: string }> = [
  { path: PROTECTED_HOME, lexical: resolve(join(REAL_HOME, ".opencodex")), label: "the real OpenCodex home" },
  { path: PROTECTED_CODEX_HOME, lexical: resolve(join(REAL_HOME, ".codex")), label: "the real Codex home" },
  {
    path: PROTECTED_LAUNCH_AGENTS,
    lexical: resolve(join(REAL_HOME, "Library", "LaunchAgents")),
    label: "the real LaunchAgents directory",
  },
];
const PROTECTED_REAL_HOME = canonicalize(REAL_HOME);
const LEXICAL_REAL_HOME = resolve(REAL_HOME);

/** Canonical paths whose removal is refused. Exported so the guard's tests cannot drift off them. */
export function protectedRemovalTreesForTests(): readonly string[] {
  return [PROTECTED_REAL_HOME, ...PROTECTED_TREES.map(tree => tree.path)];
}

/** Whether `child` sits strictly below `parent`, both already canonicalized. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Why removing `target` is refused, or `null` when it is not a protected location.
 *
 * Three relations are refused, not one. Equality alone would still permit
 * `rmSync(getConfigPath())` against a live `config.json`, and it would permit
 * `rmSync(homedir())`, which takes the protected tree with it. So a target is refused when it
 * IS a protected tree, when it sits INSIDE one, or when it is an ANCESTOR of one.
 *
 * Canonicalization is what makes a symlink useless as a bypass: a temp path that merely points
 * at the real home resolves to the real home before any comparison happens.
 */
export function protectedRemovalReason(target: string): string | null {
  // Both spellings are judged, not just the canonical one. Canonicalization is what defeats a
  // symlink alias, but it also resolves the target away: if `~/.opencodex` is itself a link,
  // the literal path a caller passed is the thing that gets unlinked, and only the lexical
  // form still names it. Upstream Codex makes the same distinction in its writable-root
  // handling, keeping logical and resolved forms side by side rather than collapsing to one.
  for (const candidate of [canonicalize(target), resolve(target)]) {
    if (candidate === PROTECTED_REAL_HOME || candidate === LEXICAL_REAL_HOME) {
      return `the real home directory (${PROTECTED_REAL_HOME})`;
    }
    for (const tree of PROTECTED_TREES) {
      for (const protectedPath of [tree.path, tree.lexical]) {
        if (candidate === protectedPath) return `${tree.label} (${protectedPath})`;
        if (isInside(protectedPath, candidate)) return `a path inside ${tree.label} (${protectedPath})`;
        if (isInside(candidate, protectedPath)) return `an ancestor of ${tree.label} (${protectedPath})`;
      }
    }
  }
  return null;
}

/**
 * Throw before a removal that would reach a protected tree.
 *
 * Deliberately NOT gated on {@link isTestHomeGuardArmed}. Arming happens in `tests/preload.ts`,
 * which Bun loads from the `bunfig.toml` it finds in the CURRENT WORKING DIRECTORY — so a run
 * started outside the repository arms nothing, leaves OPENCODEX_HOME unset, and resolves the
 * developer's real home. That unarmed run is precisely the one that caused the incident, so the
 * refusal has to hold without it. Nothing in production calls this; the callers are test
 * helpers, where the only cost of an unconditional check is a path comparison.
 */
export function assertRemovalOutsideProtectedTrees(target: string): void {
  const reason = protectedRemovalReason(target);
  if (reason === null) return;
  throw new Error(
    `refusing to remove ${reason} from a test process: "${target}" resolves there. `
    + "Create the directory this test owns with createTempHome() from tests/helpers/temp-home "
    + "and remove that handle instead (see devlog 260730_codex_rs_upstream_v2_live_handoff/070).",
  );
}
