import { posix } from "node:path";

import type { CodexCliInstallProvenanceDeps } from "../../src/codex/cli-install-provenance";

/**
 * Minimal POSIX virtual filesystem for npm-global Codex install fixtures.
 *
 * Every path is absolute and lexical; only regular files and final-component
 * symlinks exist (directories are implied by path prefixes, which is all the
 * provenance inspection ever stats). stat follows the whole link chain, lstat
 * reports the final component as written. Observations honor the bigint option;
 * tests can mutate inode and timestamp fields between calls.
 */
export interface VirtualFileSpec {
  readonly data?: string | Buffer;
  readonly link?: string;
  readonly mode?: number;
  readonly ino?: number;
  readonly mtimeMs?: number;
}

interface VirtualFileEntry {
  kind: "file";
  bytes: Buffer;
  mode: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface VirtualSymlinkEntry {
  kind: "symlink";
  target: string;
}

type VirtualEntry = VirtualFileEntry | VirtualSymlinkEntry;

const enoent = (): never => {
  throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
};

export interface VirtualPosixFs {
  readonly exists: (path: string) => boolean;
  readonly lstat: (path: string, options?: { bigint?: boolean }) => unknown;
  readonly stat: (path: string, options?: { bigint?: boolean }) => unknown;
  readonly readFile: (path: string) => Buffer;
  readonly realpath: (path: string) => string;
  /** Replace a regular file's bytes in place, keeping inode and timestamps. */
  readonly setBytes: (path: string, data: string | Buffer) => void;
  /** Change a file's recorded inode: simulates replacement between two stats. */
  readonly bumpIdentity: (path: string) => void;
  /** Remove an entry entirely (next lookup is ENOENT). */
  readonly remove: (path: string) => void;
  /** Repoint a path at another path: simulates an out-of-prefix redirect. */
  readonly redirect: (path: string, target: string) => void;
  /** Materialize a new entry: simulates a package appearing mid-observation. */
  readonly create: (path: string, spec: VirtualFileSpec) => void;
}

export function virtualPosixFs(initial: Record<string, VirtualFileSpec>): VirtualPosixFs {
  const entries = new Map<string, VirtualEntry>();
  let nextIno = 1;
  const norm = (path: string): string => posix.normalize(path);
  const put = (path: string, spec: VirtualFileSpec) => {
    entries.set(norm(path), spec.link !== undefined
      ? { kind: "symlink", target: spec.link }
      : {
        kind: "file",
        bytes: Buffer.from(spec.data ?? ""),
        mode: spec.mode ?? 0o644,
        ino: spec.ino ?? nextIno++,
        mtimeMs: spec.mtimeMs ?? 1_700_000_000_000,
        ctimeMs: spec.mtimeMs ?? 1_700_000_000_000,
      });
  };
  for (const [path, spec] of Object.entries(initial)) put(path, spec);

  const resolvePath = (path: string): string => {
    let current = norm(path);
    const seen = new Set<string>();
    for (;;) {
      const entry = entries.get(current);
      if (entry?.kind !== "symlink") return current;
      if (seen.has(current)) {
        throw Object.assign(new Error("ELOOP: too many levels of symbolic links"), { code: "ELOOP" });
      }
      seen.add(current);
      current = norm(posix.isAbsolute(entry.target)
        ? entry.target
        : posix.join(posix.dirname(current), entry.target));
    }
  };

  // Fractional milliseconds to nanoseconds without requiring an integral value.
  const nanoseconds = (ms: number): bigint => BigInt(Math.trunc(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6));
  // Same field types as node:fs Stats and BigIntStats: bigint observations carry bigint mode,
  // truncated bigint *Ms and exact *Ns; numeric observations carry no *Ns fields.
  const statLike = (entry: VirtualEntry, options?: { bigint?: boolean }) => {
    const mode = entry.kind === "file" ? entry.mode : 0o777;
    const size = entry.kind === "file" ? entry.bytes.length : entry.target.length;
    const ino = entry.kind === "file" ? entry.ino : 0;
    const mtimeMs = entry.kind === "file" ? entry.mtimeMs : 0;
    const ctimeMs = entry.kind === "file" ? entry.ctimeMs : 0;
    const kind = {
      isFile: () => entry.kind === "file",
      isSymbolicLink: () => entry.kind === "symlink",
      isDirectory: () => false,
    };
    if (!options?.bigint) return { ...kind, mode, size, dev: 42, ino, mtimeMs, ctimeMs };
    return {
      ...kind, mode: BigInt(mode), size: BigInt(size), dev: 42n, ino: BigInt(ino),
      mtimeMs: BigInt(Math.trunc(mtimeMs)), ctimeMs: BigInt(Math.trunc(ctimeMs)),
      mtimeNs: nanoseconds(mtimeMs), ctimeNs: nanoseconds(ctimeMs),
    };
  };

  const fileAt = (path: string): VirtualFileEntry => {
    const resolved = entries.get(resolvePath(path));
    if (!resolved || resolved.kind !== "file") enoent();
    return resolved as VirtualFileEntry;
  };

  return {
    exists: path => entries.get(resolvePath(path))?.kind === "file",
    lstat: (path, options) => {
      const entry = entries.get(norm(path));
      if (!entry) enoent();
      return statLike(entry, options);
    },
    stat: (path, options) => statLike(fileAt(path), options),
    readFile: path => fileAt(path).bytes,
    realpath: path => {
      const resolved = resolvePath(path);
      // Directories are implied by path prefixes rather than stored entries, so
      // an existing path is either an entry or an ancestor of one.
      if (!entries.has(resolved) && ![...entries.keys()].some(key => key.startsWith(resolved + "/"))) {
        enoent();
      }
      return resolved;
    },
    setBytes: (path, data) => {
      const entry = entries.get(norm(path));
      if (!entry || entry.kind !== "file") enoent();
      entry.bytes = Buffer.from(data);
    },
    bumpIdentity: path => {
      const entry = entries.get(norm(path));
      if (!entry || entry.kind !== "file") enoent();
      entry.ino = nextIno++;
    },
    remove: path => {
      entries.delete(norm(path));
    },
    redirect: (path, target) => {
      entries.set(norm(path), { kind: "symlink", target });
    },
    create: (path, spec) => {
      put(path, spec);
    },
  };
}

export const VIRTUAL_NPM_PREFIX = "/virtual-npm";
export const VIRTUAL_PACKAGE_ROOT = VIRTUAL_NPM_PREFIX + "/lib/node_modules/@openai/codex";
export const VIRTUAL_LAUNCHER = VIRTUAL_NPM_PREFIX + "/bin/codex";
export const VIRTUAL_ENTRYPOINT = VIRTUAL_PACKAGE_ROOT + "/bin/codex.js";
export const VIRTUAL_MANIFEST = VIRTUAL_PACKAGE_ROOT + "/package.json";
const VIRTUAL_BACKING_PACKAGE = VIRTUAL_PACKAGE_ROOT + "/node_modules/@openai/codex-linux-x64";
export const VIRTUAL_BACKING_MANIFEST = VIRTUAL_BACKING_PACKAGE + "/package.json";
export const VIRTUAL_BACKING_BINARY = VIRTUAL_BACKING_PACKAGE + "/vendor/x86_64-unknown-linux-musl/bin/codex";
export const VIRTUAL_VENDOR_BINARY = VIRTUAL_PACKAGE_ROOT + "/vendor/x86_64-unknown-linux-musl/bin/codex";

export const VIRTUAL_MANIFEST_TEXT = JSON.stringify({
  name: "@openai/codex",
  version: "1.2.3",
  description: "synthetic fixture for content-binding tests",
  bin: { codex: "bin/codex.js" },
}, null, 2) + "\n";
export const VIRTUAL_ENTRYPOINT_TEXT = "#!/usr/bin/env node\n// synthetic fixture entrypoint\n";
export const VIRTUAL_BACKING_TEXT = "synthetic-native-backing-v1\n";

/**
 * A managed-layout virtual install: launcher symlink to the package entrypoint,
 * with the nested optional-package backing exactly where npm install -g puts it.
 */
export function virtualManagedNpmGlobal(
  overrides: Record<string, VirtualFileSpec> = {},
): VirtualPosixFs {
  return virtualPosixFs({
    [VIRTUAL_LAUNCHER]: { link: VIRTUAL_ENTRYPOINT },
    [VIRTUAL_MANIFEST]: { data: VIRTUAL_MANIFEST_TEXT },
    [VIRTUAL_ENTRYPOINT]: { data: VIRTUAL_ENTRYPOINT_TEXT, mode: 0o755 },
    [VIRTUAL_BACKING_MANIFEST]: {
      data: JSON.stringify({ name: "@openai/codex-linux-x64", version: "1.2.3" }) + "\n",
    },
    [VIRTUAL_BACKING_BINARY]: { data: VIRTUAL_BACKING_TEXT, mode: 0o755 },
    ...overrides,
  });
}

/** Deps for the injected-test bounded-read seam against a virtual install. */
export function virtualInspectionDeps(
  fs: VirtualPosixFs,
  overrides: Partial<CodexCliInstallProvenanceDeps> = {},
): CodexCliInstallProvenanceDeps {
  return {
    platform: "linux",
    arch: "x64",
    configDir: "/virtual-opencodex",
    env: { CODEX_CLI_PATH: VIRTUAL_LAUNCHER, PATH: "" },
    exists: fs.exists,
    lstat: fs.lstat as CodexCliInstallProvenanceDeps["lstat"],
    stat: fs.stat as CodexCliInstallProvenanceDeps["stat"],
    readFile: fs.readFile,
    realpath: fs.realpath,
    boundedFileReadMode: "injected-test",
    selectionAttested: true,
    selectedCommand: VIRTUAL_LAUNCHER,
    inspectShim: () => ({ status: "not-tracked" }),
    ...overrides,
  };
}
