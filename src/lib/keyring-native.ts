import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";
import { isStandaloneBinary, standaloneRoot } from "./standalone";

export interface KeyringBinding {
  Entry: new (service: string, account: string) => unknown;
  AsyncEntry: new (service: string, account: string) => unknown;
}

export interface KeyringNativeAsset {
  packageName: string;
  filename: string;
}

/** Must match Tauri `productName`, which names Linux's usr/lib resource directory. */
export const PACKAGED_DESKTOP_PRODUCT_NAME = "OpenCodex";

const ASSET_BY_TARGET: Readonly<Record<string, KeyringNativeAsset>> = {
  "bun-darwin-arm64": {
    packageName: "@napi-rs/keyring-darwin-arm64",
    filename: "keyring.darwin-arm64.node",
  },
  "bun-darwin-x64": {
    packageName: "@napi-rs/keyring-darwin-x64",
    filename: "keyring.darwin-x64.node",
  },
  "bun-windows-x64": {
    packageName: "@napi-rs/keyring-win32-x64-msvc",
    filename: "keyring.win32-x64-msvc.node",
  },
  "bun-linux-x64": {
    packageName: "@napi-rs/keyring-linux-x64-gnu",
    filename: "keyring.linux-x64-gnu.node",
  },
  "bun-linux-arm64": {
    packageName: "@napi-rs/keyring-linux-arm64-gnu",
    filename: "keyring.linux-arm64-gnu.node",
  },
};

/** Native addon that must accompany a compiled standalone target. */
export function keyringAssetForStandaloneTarget(target: string): KeyringNativeAsset | undefined {
  return ASSET_BY_TARGET[target];
}

function runtimeAsset(platform: NodeJS.Platform, arch: string): KeyringNativeAsset | undefined {
  const target = platform === "darwin"
    ? `bun-darwin-${arch}`
    : platform === "win32"
      ? `bun-windows-${arch}`
      : platform === "linux"
        ? `bun-linux-${arch}`
        : "";
  return keyringAssetForStandaloneTarget(target);
}

/**
 * Deterministic packaged-addon paths. Never search cwd: a desktop command can be launched from an
 * arbitrary directory, and loading a same-named native file from there would turn cwd into code.
 */
export function packagedKeyringCandidates({
  root = isStandaloneBinary() ? standaloneRoot() : undefined,
  platform = process.platform,
  arch = process.arch,
}: {
  /** Test seam; production supplies the canonical compiled-executable directory. */
  root?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): string[] {
  // Source/npm installs must stay inside package resolution. Probing beside a shared Bun/Node
  // executable would expand the native-code trust boundary and contradict the packaging contract.
  if (root === undefined) return [];
  const asset = runtimeAsset(platform, arch);
  if (!asset) return [];
  // Paths follow the target platform's rules rather than the host's, so a candidate list is the
  // same whether it is computed on that platform or simulated from another one.
  const { basename, dirname, join, resolve } = platform === "win32" ? win32 : posix;
  const executableDir = resolve(root);
  const adjacent = join(executableDir, "keyring", asset.filename);
  if (platform === "linux") {
    const usrDir = dirname(executableDir);
    // Tauri installs resources at usr/lib/<productName> while its sidecar is usr/bin/ocx.
    // Restrict that fallback to the exact bundle shape; ordinary standalone archives keep the
    // executable-owned adjacent directory as their only candidate.
    return basename(executableDir) === "bin" && basename(usrDir) === "usr"
      ? [adjacent, join(usrDir, "lib", PACKAGED_DESKTOP_PRODUCT_NAME, "keyring", asset.filename)]
      : [adjacent];
  }
  if (platform !== "darwin") return [adjacent];
  return [
    // Prefer the executable-owned sibling. A standalone layout must not let an unrelated
    // app-shaped ../Resources tree override the addon distributed with that executable.
    adjacent,
    // Tauri resources live in Contents/Resources while its external binary lives in Contents/MacOS.
    join(executableDir, "..", "Resources", "keyring", asset.filename),
  ];
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Load the OS-keyring binding from the immutable packaged location, falling back to normal package
 * resolution for source/npm installs. Bun cannot materialize a N-API binary from `$bunfs`, so a
 * compiled executable must never depend on `@napi-rs/keyring` resolving inside its virtual tree.
 */
export function loadKeyringBinding({
  candidates = packagedKeyringCandidates(),
  fileExists = existsSync,
  load = (specifier: string): unknown => nodeRequire(specifier),
}: {
  candidates?: string[];
  fileExists?: (path: string) => boolean;
  load?: (specifier: string) => unknown;
} = {}): KeyringBinding {
  for (const candidate of candidates) {
    if (fileExists(candidate)) return load(candidate) as KeyringBinding;
  }
  return load("@napi-rs/keyring") as KeyringBinding;
}

/** Load-only package probe: verifies constructors without reading or writing an OS credential. */
export function inspectKeyringBinding(
  load: () => KeyringBinding = loadKeyringBinding,
): { schema: "ocx-keyring-load/1"; available: true } {
  const binding = load();
  if (typeof binding.Entry !== "function" || typeof binding.AsyncEntry !== "function") {
    throw new Error("The keyring native binding does not export Entry and AsyncEntry constructors");
  }
  return { schema: "ocx-keyring-load/1", available: true };
}
