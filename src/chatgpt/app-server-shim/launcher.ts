import { accessSync, chmodSync, constants, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, posix } from "node:path";
import { getConfigDir } from "../../config/paths";
import { selfLaunchArgv } from "../../lib/self-launch-argv";
import { defaultBundleTrustDeps } from "./bundle-trust";
import { untrustedLauncherFilesystemReason, type BundleTrustDeps } from "./bundle-trust-policy";

export const CHATGPT_APP_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/**
 * Where the app-server binary sits inside a ChatGPT bundle, newest layout first. The bundle root
 * is discovered by identity (com.openai.codex), so an install in ~/Applications or on another
 * volume resolves to its own binary instead of the conventional /Applications path.
 */
const BUNDLED_CODEX_LAYOUTS: readonly (readonly string[])[] = [
  ["Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"],
  ["Contents", "Resources", "codex"],
];

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The bundled app-server binary of a verified bundle root, or null when the bundle has none. */
export function resolveChatgptCodexBinary(
  bundleRoot: string,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string | null {
  for (const layout of BUNDLED_CODEX_LAYOUTS) {
    const candidate = posix.join(bundleRoot, ...layout); // macOS bundle paths are POSIX on every host
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function chatgptShimLauncherPath(configDir = getConfigDir()): string {
  return join(configDir, "chatgpt-codex-shim.sh");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A failed filter self-test runs the verified binary with untouched stdout.
 * Executable verification is required on every invocation, including passthrough and respawns.
 * A filter that passes the self-test and then dies mid-session closes the pipe.
 * Expected (not yet validated against the bundled app-server): the server gets SIGPIPE or a
 * write error and Desktop respawns it through the same launcher.
 */
export function buildChatgptShimLauncher(
  argv: readonly string[],
  real = CHATGPT_APP_CODEX_BINARY,
  validator: readonly string[] = [process.execPath, ...selfLaunchArgv(["internal", "codex-exec-target"])],
  bundleRoot = /^(.*?\.app)\/Contents\//i.exec(real)?.[1],
): string {
  return `#!/bin/bash
# opencodex (experimental): ChatGPT app-server stdout passes through the quota-gate filter.
REAL=${shellQuote(real)}
${bundleRoot === undefined ? "" : `BUNDLE_ROOT=${shellQuote(bundleRoot)}\n`}FILTER=(${argv.map(shellQuote).join(" ")})
VALIDATE=(${validator.map(shellQuote).join(" ")})
if [ ! -x "$REAL" ]; then
  echo "opencodex (experimental): the bundled app-server is no longer at $REAL; run 'ocx chatgpt launch' again or 'ocx chatgpt restore'." >&2
  exit 127
fi
validate_real() {
  local target
  if [ ! -x "\${VALIDATE[0]}" ] || ! target=$("\${VALIDATE[@]}" ${bundleRoot === undefined ? "" : '--bundle-root "$BUNDLE_ROOT" '}-- "$REAL") || [ -z "$target" ]; then
    echo "opencodex: app-server execution verification failed; run 'ocx chatgpt launch' again or 'ocx chatgpt restore'." >&2
    return 126
  fi
  REAL="$target"
}
if [ "$(uname -s)" = "Darwin" ] && [ -x "\${FILTER[0]}" ] \\
   && "\${FILTER[@]}" --self-test >/dev/null 2>&1; then
  validate_real || exit 126
  exec "$REAL" "$@" > >(exec "\${FILTER[@]}")
fi
validate_real || exit 126
exec "$REAL" "$@"
`;
}

/**
 * Written to a fresh temp file (exclusive create, never through a link) and renamed over the
 * launcher, so an existing symbolic link is replaced rather than followed and a respawn during
 * the write never runs a half-written script.
 */
export function writeChatgptShimLauncher(
  configDir = getConfigDir(), real = CHATGPT_APP_CODEX_BINARY,
  bundleRoot = /^(.*?\.app)\/Contents\//i.exec(real)?.[1],
  filesystem: Pick<BundleTrustDeps, "uid" | "stat" | "adminGroupId"> | undefined = process.platform === "darwin" ? defaultBundleTrustDeps() : undefined,
): string {
  if (!bundleRoot || !posix.isAbsolute(bundleRoot) || !real.startsWith(bundleRoot + "/Contents/")) {
    throw new Error("the app-server launcher requires its discovered bundle root");
  }
  mkdirSync(configDir, { recursive: true });
  const path = chatgptShimLauncherPath(configDir);
  const argv = [process.execPath, ...selfLaunchArgv(["internal", "chatgpt-app-server-filter"])];
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let created = false;
  const assertFilesystem = (file: string, existing: boolean) => {
    const reason = filesystem && untrustedLauncherFilesystemReason(file, filesystem, existing);
    if (reason) throw new Error(`unsafe app-server launcher: ${reason}`);
  };
  try {
    assertFilesystem(temp, false);
    writeFileSync(temp, buildChatgptShimLauncher(argv, real, undefined, bundleRoot), { mode: 0o755, flag: "wx" });
    created = true;
    chmodSync(temp, 0o755);
    assertFilesystem(temp, true);
    renameSync(temp, path);
  } catch (error) {
    if (created) { try { unlinkSync(temp); } catch { /* preserve the publication error */ } }
    throw error;
  }
  return path;
}
