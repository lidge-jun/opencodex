/**
 * The one place a test gets a home directory it is allowed to destroy.
 *
 * Every destructive fixture in this suite used to open-code the same four steps: save the
 * previous OPENCODEX_HOME, mkdtemp a directory, point the environment at it, and remove it
 * again in `afterEach`. Open-coding is how the step that matters goes missing — a test that
 * skipped the pin resolved the developer's real `~/.opencodex` and removed it, taking every
 * OAuth login, the Codex account store, the service tokens and a 372MB usage ledger
 * (devlog `_fin/260730_codex_rs_upstream_v2_live_handoff/070`).
 *
 * So the handle this returns carries OWNERSHIP, not just a path. {@link removeOwnedTree}
 * refuses anything this module did not hand out, which makes "delete only what you created"
 * a checkable property rather than a convention each fixture re-implements.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertRemovalOutsideProtectedTrees } from "../../src/lib/test-home-guard";
import { removeTreeWithRetry } from "./remove-tree";

/** Canonical roots this module created and has not yet released. */
const ownedRoots = new Set<string>();

export type TempHome = Readonly<{
  /** The directory this fixture created. The only tree it is allowed to remove. */
  root: string;
  /** The value OPENCODEX_HOME was pinned to. Identical to {@link TempHome.root}. */
  configDir: string;
  /** The value CODEX_HOME was pinned to, for tests that touch native Codex state. */
  codexHome: string;
  /** An owned path under the fixture root, for files a test wants to create and remove. */
  path: (...segments: string[]) => string;
  /** Remove the owned tree and restore both environment variables. Idempotent. */
  remove: () => void;
}>;

/** The live owned roots, so the guard's own tests can assert registration rather than infer it. */
export function ownedTempRootsForTests(): readonly string[] {
  return [...ownedRoots];
}

/**
 * Remove a path this module handed out.
 *
 * The ownership check is the point. A bare `rmSync(someDirectory)` is correct or catastrophic
 * depending only on where `someDirectory` came from, and nothing at the call site records that.
 * Routing removals through here makes the provenance explicit: an unowned path is refused
 * before any filesystem call, and a protected tree is refused twice over.
 */
export function removeOwnedTree(target: string): void {
  assertRemovalOutsideProtectedTrees(target);
  const canonical = canonicalizeExisting(target);
  const owner = [...ownedRoots].find(root => root === canonical || isInside(root, canonical));
  if (owner === undefined) {
    throw new Error(
      `refusing to remove "${target}": no temp home owns it. Create the directory with `
      + "createTempHome() from tests/helpers/temp-home and remove the handle it returns.",
    );
  }
  removeTreeWithRetry(target);
}

/**
 * Create a temp home, pin OPENCODEX_HOME and CODEX_HOME at it, and return an owned handle.
 *
 * Both variables are pinned, not one. A test that pins only OPENCODEX_HOME still resolves
 * `~/.codex` for native credential paths, and the writer guard would then be the only thing
 * standing between that test and the user's real Codex home.
 */
export function createTempHome(prefix = "ocx-temp-home-"): TempHome {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  // Refuse before anything is registered: a `TMPDIR` pointed inside the real home would
  // otherwise produce an "owned" root whose removal walks into protected state.
  assertRemovalOutsideProtectedTrees(root);
  ownedRoots.add(root);

  const previousConfigHome = process.env["OPENCODEX_HOME"];
  const previousCodexHome = process.env["CODEX_HOME"];
  const codexHome = join(root, ".codex");
  process.env["OPENCODEX_HOME"] = root;
  process.env["CODEX_HOME"] = codexHome;

  let removed = false;
  return {
    root,
    configDir: root,
    codexHome,
    path: (...segments: string[]) => join(root, ...segments),
    remove: () => {
      if (removed) return;
      removed = true;
      try {
        removeTreeWithRetry(root);
      } finally {
        ownedRoots.delete(root);
        restore("OPENCODEX_HOME", previousConfigHome);
        restore("CODEX_HOME", previousCodexHome);
      }
    },
  };
}

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/** Resolve symlinks through the nearest existing ancestor, matching the removal guard. */
function canonicalizeExisting(target: string): string {
  const absolute = resolve(target);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = resolve(absolute, "..");
    if (parent === absolute) return absolute;
    return join(canonicalizeExisting(parent), absolute.slice(parent.length + 1));
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
