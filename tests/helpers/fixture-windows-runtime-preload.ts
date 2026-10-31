import { mock } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as knownFolder from "../../src/codex/windows-local-appdata";
import {
  isTestHomeGuardArmed, protectedRemovalReason,
  protectedHomeForTests, protectedCodexHomeForTests,
  protectedClaudeConfigDirsForTests, protectedLaunchAgentsDirForTests,
} from "../../src/lib/test-home-guard";
import { FIXTURE_NAMESPACE_MARKER } from "./fixture-namespace-owner";

// Match test-home-guard's nearest-existing-ancestor resolution for paths not created yet.
function canonicalize(path: string): string {
  let current = resolve(path);
  const unresolved: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...unresolved.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      unresolved.push(basename(current));
      current = parent;
    }
  }
}

function foldPlatformCase(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(foldPlatformCase(root), foldPlatformCase(target));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

const fixtureHome = process.env.OPENCODEX_HOME;
const fixtureRoot = process.env.OCX_FIXTURE_NAMESPACE_ROOT;
const nonce = process.env.OCX_FIXTURE_NAMESPACE_NONCE;
if (!fixtureHome?.trim() || !isAbsolute(fixtureHome) || !isTestHomeGuardArmed()) {
  throw new Error("Windows runtime fixture requires an absolute guarded OPENCODEX_HOME");
}
if (!fixtureRoot?.trim() || !isAbsolute(fixtureRoot) || !nonce?.trim()) {
  throw new Error("Windows runtime fixture requires an absolute owner root and nonce");
}
const localAppData = join(dirname(fixtureHome), "local-appdata");
// Keep the guard's captured canonical roots AND the original lexical spellings:
// a protected root can itself be a symlink, or have a missing final component.
const realHome = process.env.OCX_REAL_HOME?.trim() || homedir();
const protectedRoots = [
  protectedHomeForTests(), protectedCodexHomeForTests(),
  ...protectedClaudeConfigDirsForTests(), protectedLaunchAgentsDirForTests(),
  join(realHome, ".opencodex"), join(realHome, ".codex"),
  join(realHome, ".claude"), join(realHome, "Library", "LaunchAgents"),
  process.env.OCX_REAL_CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(realHome, ".claude"),
].flatMap(path => [resolve(path), canonicalize(path)]);
for (const target of [fixtureRoot, fixtureHome, localAppData]) {
  const reason = protectedRemovalReason(target);
  if (reason !== null) throw new Error(`refusing Windows runtime fixture in ${reason}`);
  for (const candidate of [resolve(target), canonicalize(target)]) {
    for (const protectedRoot of protectedRoots) {
      // Equality plus containment in either direction, with component-aware traversal
      // and platform case folding. Do not rely on the shared removal guard's prefix test.
      if (foldPlatformCase(protectedRoot) !== foldPlatformCase(candidate)
        && !isStrictlyInside(protectedRoot, candidate) && !isStrictlyInside(candidate, protectedRoot)) continue;
      throw new Error("refusing Windows runtime fixture overlapping a protected tree");
    }
  }
}
for (const target of [fixtureHome, localAppData]) {
  if (!isStrictlyInside(resolve(fixtureRoot), resolve(target))
    || !isStrictlyInside(canonicalize(fixtureRoot), canonicalize(target))) {
    throw new Error("refusing Windows runtime fixture outside its owned root");
  }
}
let marker: string;
try {
  marker = readFileSync(join(fixtureRoot, FIXTURE_NAMESPACE_MARKER), "utf8");
} catch {
  throw new Error("Windows runtime fixture requires an owner marker");
}
if (marker !== nonce) {
  throw new Error("Windows runtime fixture requires a matching owner nonce");
}
mkdirSync(localAppData, { recursive: true });

// The production known-folder API deliberately ignores HOME/LOCALAPPDATA. Give fixture
// children one shared private namespace while retaining the real SID, locks and ACL work.
mock.module("../../src/codex/windows-local-appdata", () => ({
  ...knownFolder,
  resolveWindowsLocalAppData: () => localAppData,
}));
