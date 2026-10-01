import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

/**
 * The launcher persistently execs a binary taken from a discovered bundle, so the bundle must be
 * one this user can trust: OpenAI-signed, and not replaceable by another local account. Bundle
 * identifier alone (what discovery checks) is plain text in Info.plist that anyone can copy.
 */
export const OPENAI_TEAM_ID = "2DC432GLL2";

const CODESIGN = "/usr/bin/codesign";
const CODESIGN_TIMEOUT_MS = 30_000;

export interface BundleTrustDeps {
  readonly uid: number;
  stat(path: string): { uid: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null;
  codesign(args: readonly string[]): { status: number | null; output: string };
}

export function defaultBundleTrustDeps(): BundleTrustDeps {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    stat(path) {
      try {
        const s = lstatSync(path);
        return { uid: s.uid, mode: s.mode, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
      } catch {
        return null;
      }
    },
    codesign(args) {
      const result = spawnSync(CODESIGN, [...args], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS });
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
  };
}

function ownedSafely(deps: BundleTrustDeps, path: string, kind: "file" | "directory"): string | null {
  const s = deps.stat(path);
  if (!s) return "is missing";
  if (s.isSymbolicLink) return "is a symbolic link";
  if (kind === "file" ? !s.isFile : !s.isDirectory) return `is not a ${kind}`;
  if (s.uid !== 0 && s.uid !== deps.uid) return "is owned by another user";
  if ((s.mode & 0o022) !== 0) return "is writable by group or others";
  return null;
}

/**
 * Null when the bundle root and the app-server binary inside it may be exec'd by this user;
 * otherwise a short reason. Every directory from the binary up to the bundle root, and the
 * binary itself, must be owned by root or this user and not group/other-writable, and both the
 * bundle and the binary must pass strict code-signature verification under OpenAI's team ID.
 */
export function untrustedChatgptBundleReason(
  bundleRoot: string,
  binary: string,
  deps: BundleTrustDeps = defaultBundleTrustDeps(),
): string | null {
  const inside = relative(bundleRoot, binary);
  if (!inside || inside.startsWith("..") || inside.startsWith(sep)) return "the app-server binary is outside the bundle";
  const fileProblem = ownedSafely(deps, binary, "file");
  if (fileProblem) return `the app-server binary ${fileProblem}`;
  for (let dir = dirname(binary); ; dir = dirname(dir)) {
    const dirProblem = ownedSafely(deps, dir, "directory");
    if (dirProblem) return `${dir} ${dirProblem}`;
    if (dir === bundleRoot || dirname(dir) === dir) break;
  }
  for (const target of [bundleRoot, binary]) {
    if (deps.codesign(["--verify", "--strict", target]).status !== 0) return `${target} failed code-signature verification`;
    const details = deps.codesign(["-dv", "--verbose=2", target]);
    if (details.status !== 0 || !new RegExp(`^TeamIdentifier=${OPENAI_TEAM_ID}$`, "m").test(details.output)) {
      return `${target} is not signed by OpenAI (team ${OPENAI_TEAM_ID})`;
    }
  }
  return null;
}
