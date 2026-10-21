import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { repoPath } from "./repo-root";

/**
 * Where tests build a real directory that the PATH-Bun trust check
 * (`trustedPosixCandidate` in src/lib/bun-path-runtime.mjs) is supposed to accept.
 *
 * Test-only. Production never imports this file and nothing here relaxes the product
 * check: it only chooses a fixture location whose whole ancestry already satisfies it.
 * A fixed location cannot do that everywhere. The checkout's parent is group-writable on
 * some macOS volumes (#7402), and `/tmp` is 1777 on Linux, so each candidate is walked
 * with the product's rule and the first one that passes is used.
 *
 * A second hazard is provenance: the Node launcher resolves `bun/package.json` upward
 * from the fixture, so an ancestor holding `node_modules/bun` would leak a real runtime
 * into a fixture that is meant to have none.
 */
export const TRUSTED_FIXTURE_DIR_ENV = "OPENCODEX_TEST_TRUSTED_FIXTURE_DIR";

/** Ordered candidates: an explicit override, the per-user temp dir, then the checkout's sibling `.tmp`. */
export function fixtureBaseCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const override = env[TRUSTED_FIXTURE_DIR_ENV];
  if (override && isAbsolute(override)) candidates.push(override);
  candidates.push(join(tmpdir(), "opencodex-path-bun-fixtures"));
  candidates.push(join(dirname(repoPath()), ".tmp", "path-bun-fixtures"));
  return candidates;
}

/**
 * Why `path` cannot host a trusted fixture, or null when it can. The part of `path` that
 * does not exist yet is ignored; {@link trustedFixtureRoot} creates it 0700 and re-checks.
 */
export function untrustedFixtureAncestor(path: string, uid: number | undefined = process.geteuid?.()): string | null {
  if (!Number.isSafeInteger(uid)) return "effective uid unavailable";
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return "no existing ancestor";
    existing = parent;
  }
  let current = "/";
  for (const component of realpathSync.native(existing).split("/").filter(Boolean).concat("")) {
    const info = lstatSync(current);
    if (!info.isDirectory()) return `${current} is not a directory`;
    if (info.uid !== 0 && info.uid !== uid) return `${current} is owned by uid ${info.uid}`;
    if ((info.mode & 0o022) !== 0) return `${current} is group/other-writable (mode ${(info.mode & 0o777).toString(8)})`;
    if (existsSync(join(current, "node_modules", "bun"))) return `${current} contains node_modules/bun`;
    if (component) current = join(current, component);
  }
  return null;
}

/** A fresh private directory under the first trusted candidate. Throws, naming every rejection, when none qualifies. */
export function trustedFixtureRoot(prefix: string, candidates: string[] = fixtureBaseCandidates()): string {
  if (process.platform === "win32") return mkdtempSync(join(tmpdir(), prefix));
  const rejected: string[] = [];
  for (const base of candidates) {
    const before = untrustedFixtureAncestor(base);
    if (before) { rejected.push(`${base}: ${before}`); continue; }
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const after = untrustedFixtureAncestor(base);
    if (after) { rejected.push(`${base}: ${after}`); continue; }
    return realpathSync.native(mkdtempSync(join(base, prefix)));
  }
  throw new Error(
    `No fixture base passes the PATH-Bun trust rule; set ${TRUSTED_FIXTURE_DIR_ENV} to a private directory.\n${rejected.join("\n")}`,
  );
}
