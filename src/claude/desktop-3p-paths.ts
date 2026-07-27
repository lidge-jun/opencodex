import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Claude Desktop's own configLibrary location, ported from the shipped app bundle.
 *
 * Desktop assembles the directory name at runtime, which is why searching the
 * bundle for the literal "Claude-3p" finds almost nothing (app.asar, v1.18286.0):
 *
 *   const Bu = "-3p", zW = "Claude", ND = `${zW}${Bu}`;
 *   function GE(){
 *     if (process.env.CLAUDE_USER_DATA_DIR) return app.getPath("userData");
 *     if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, ND);
 *     const t = app.getPath("userData");
 *     return t.endsWith(Bu) ? t : `${t}${Bu}`;
 *   }
 *   function mD(){ return join(GE(), "configLibrary") }
 *
 * So `Claude-3p` is Desktop's correct default, not a mistake to "fix" — but the
 * first two branches were missing here, which is what GitHub #539 actually hit.
 *
 * Resolution is a pure function of (env, platform, home) so tests can exercise the
 * win32 branch on any host: stubbing `process.platform` does NOT propagate to
 * `os.platform()` under Bun, so a platform-sniffing implementation would be
 * untestable in this repo.
 */
const SUFFIX = "-3p";
const APP_DIR = `Claude${SUFFIX}`;

function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts);
}

export interface DesktopPathInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

/** Electron `app.getPath("userData")`: per-platform appData + productName ("Claude"). */
export function resolveElectronUserData(inputs: DesktopPathInputs): string {
  const { env, platform, home } = inputs;
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? win32.join(appData, "Claude") : win32.join(home, "AppData", "Roaming", "Claude");
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? posix.join(xdg, "Claude") : posix.join(home, ".config", "Claude");
}

/** Desktop's userData root, mirroring `GE()` branch for branch. */
export function resolveUserDataDir(inputs: DesktopPathInputs): string {
  const explicit = inputs.env.CLAUDE_USER_DATA_DIR?.trim();
  // Desktop calls app.setPath("userData", CLAUDE_USER_DATA_DIR) at startup, so this
  // path is used verbatim — notably WITHOUT the "-3p" suffix.
  if (explicit) return explicit;

  if (inputs.platform === "win32") {
    const localAppData = inputs.env.LOCALAPPDATA?.trim();
    if (localAppData) return win32.join(localAppData, APP_DIR);
  }

  const root = resolveElectronUserData(inputs);
  // Concatenated, not joined: "Claude-3p" is one path component.
  return root.endsWith(SUFFIX) ? root : `${root}${SUFFIX}`;
}

/**
 * The directory opencodex writes its 3P profile into.
 *
 * OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR wins over every other branch and is returned
 * verbatim (no `join`), because tests point it straight at a temp directory.
 */
export function resolveConfigLibraryDir(inputs: DesktopPathInputs): string {
  const override = inputs.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim();
  if (override) return override;
  return joinForPlatform(inputs.platform, resolveUserDataDir(inputs), "configLibrary");
}

/** Runtime wrapper. Keep it thin: all branching lives in the pure functions above. */
export function claudeDesktopConfigLibraryDir(): string {
  return resolveConfigLibraryDir({ env: process.env, platform: process.platform, home: homedir() });
}
