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
import { dirname, join, relative, resolve } from "node:path";
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
