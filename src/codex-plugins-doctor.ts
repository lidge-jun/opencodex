import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CODEX_CONFIG_PATH } from "./codex-paths";
import { redactUserPath } from "./redact";

// Mirrors codex-rs core-plugins/src/marketplace.rs MARKETPLACE_MANIFEST_RELATIVE_PATHS.
// A marketplace root "resolves" only when one of these files exists under it.
const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

const OPENAI_BUNDLED_MARKETPLACE_NAME = "openai-bundled";

// Where the Codex desktop app's bundled plugins live, relative to an install
// root. Windows app-package paths embed the app version, so the actual install
// root is discovered by scanning candidate bases (LOCALAPPDATA, etc.) rather
// than hardcoded. The bundled marketplace dir is named after the marketplace.
const BUNDLED_MARKETPLACE_LEAF = join("plugins", "bundled-marketplaces", OPENAI_BUNDLED_MARKETPLACE_NAME);
const CODEX_APP_DIR_SEGMENTS = [join("Programs", "@openai", "codex"), join("Programs", "codex"), join("@openai", "codex"), "codex"] as const;

// Plugins the issue (#43) calls out. Treated as data, not as an authoritative
// allowlist: codex-rs only allowlists chrome/computer-use, but the diagnostic
// just reports presence, so listing browser here is informational only.
const COMMON_BUNDLED_PLUGINS = ["computer-use", "browser", "chrome"] as const;

export type CodexPluginsDiagnostic =
  | { applicable: false; reason: string; summary: string }
  | {
      applicable: true;
      stale: boolean;
      marketplace: {
        name: string;
        present: boolean;
        sourceType: string | null;
        source: string | null;
        resolvesToManifest: boolean;
        currentBundledPath: string | null;
        pathMismatch: boolean;
      };
      bundledPlugins: Array<{ id: string; configured: boolean }>;
      suggestedRepair: string | null;
      summary: string;
    };

/** True when the table at `[marketplaces.<name>]` exists in the config text. */
function readMarketplaceTable(configText: string, name: string): Record<string, string> | null {
  // Split on CRLF or LF: config.toml on Windows (the platform this diagnostic
  // targets) uses CRLF, and a leftover \r would defeat the `$`-anchored regexes.
  const lines = configText.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[marketplaces\\.(?:"${escapeRegExp(name)}"|${escapeRegExp(name)})\\]\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i] ?? "")) { start = i + 1; break; }
  }
  if (start === -1) return null;

  const table: Record<string, string> = {};
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\[/.test(line)) break; // next table starts; stop
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:\\.|[^"])*"|'[^']*'|[^#]+?)\s*(?:#.*)?$/);
    if (!m) continue;
    table[m[1]] = unquoteTomlValue(m[2].trim());
  }
  return table;
}

function unquoteTomlValue(raw: string): string {
  if (raw.startsWith("\"")) {
    try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A directory is a bundled-marketplace root when it holds a supported manifest. */
function dirHasManifest(dir: string): boolean {
  return MARKETPLACE_MANIFEST_RELATIVE_PATHS.some(rel => existsSync(join(dir, rel)));
}

/**
 * Locate the bundled `openai-bundled` marketplace dir under the installed Codex
 * desktop app on Windows. Windows app paths embed the app version, so we scan
 * candidate install bases for a versioned app dir whose
 * `plugins/bundled-marketplaces/openai-bundled` holds a manifest. Returns the
 * newest matching dir (by mtime) or null. Filesystem access is injectable for
 * tests so a Windows layout can be exercised on any OS.
 */
export function locateCurrentBundledMarketplace(
  options: {
    env?: NodeJS.ProcessEnv;
    listDir?: (dir: string) => string[];
    isManifestRoot?: (dir: string) => boolean;
    mtimeOf?: (dir: string) => number;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  const listDir = options.listDir ?? ((dir: string) => {
    try { return readdirSync(dir); } catch { return []; }
  });
  const isManifestRoot = options.isManifestRoot ?? dirHasManifest;
  const mtimeOf = options.mtimeOf ?? ((dir: string) => {
    try { return statSync(dir).mtimeMs; } catch { return 0; }
  });

  const bases = [env.LOCALAPPDATA, env.PROGRAMFILES, env["ProgramFiles(x86)"], env.APPDATA]
    .filter((b): b is string => typeof b === "string" && b.length > 0);

  const candidates: string[] = [];
  for (const base of bases) {
    for (const seg of CODEX_APP_DIR_SEGMENTS) {
      const appRoot = join(base, seg);
      // Direct (unversioned) layout.
      const direct = join(appRoot, BUNDLED_MARKETPLACE_LEAF);
      if (isManifestRoot(direct)) candidates.push(direct);
      // Versioned layout: appRoot/<version>/plugins/bundled-marketplaces/openai-bundled
      for (const child of listDir(appRoot)) {
        const versioned = join(appRoot, child, BUNDLED_MARKETPLACE_LEAF);
        if (isManifestRoot(versioned)) candidates.push(versioned);
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => mtimeOf(b) - mtimeOf(a));
  return candidates[0] ?? null;
}

/** Normalize a path for comparison: lowercase + unify separators (Windows is case-insensitive). */
function normalizePathForCompare(path: string): string {
  return path.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** A local marketplace `source` resolves when it holds a supported manifest. */
function sourceResolvesToManifest(source: string): boolean {
  if (!isAbsolute(source)) return false;
  if (!existsSync(source)) return false;
  return MARKETPLACE_MANIFEST_RELATIVE_PATHS.some(rel => existsSync(join(source, rel)));
}

/**
 * Read-only diagnostic for the Codex `openai-bundled` plugin marketplace.
 *
 * Only meaningful on Windows, where app-package paths embed the app version and
 * go stale after an update. On other platforms it reports "not applicable".
 * NEVER mutates config.toml, never invokes `codex plugin marketplace add`.
 */
export function diagnoseCodexBundledPlugins(
  options: {
    platform?: NodeJS.Platform;
    configPath?: string;
    locateCurrent?: () => string | null;
  } = {},
): CodexPluginsDiagnostic {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      applicable: false,
      reason: "not_windows",
      summary: "not applicable (bundled-marketplace staleness is Windows-specific)",
    };
  }

  const configPath = options.configPath ?? CODEX_CONFIG_PATH;
  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    return {
      applicable: false,
      reason: "config_unreadable",
      summary: "not applicable (Codex config.toml not found or unreadable)",
    };
  }

  const table = readMarketplaceTable(configText, OPENAI_BUNDLED_MARKETPLACE_NAME);
  const present = table !== null;
  const sourceType = table?.source_type ?? null;
  const source = table?.source ?? null;
  const isLocal = sourceType === "local" && !!source;
  const resolvesToManifest = isLocal ? sourceResolvesToManifest(source as string) : false;

  // Locate the bundled marketplace under the currently installed Codex app, so
  // we can tell "registered path differs from the live app path" (the Windows
  // app-update staleness signal) apart from a merely missing manifest.
  const locateCurrent = options.locateCurrent ?? (() => locateCurrentBundledMarketplace());
  const currentBundledPath = locateCurrent();
  const pathMismatch = !!(
    currentBundledPath && source && isLocal &&
    normalizePathForCompare(currentBundledPath) !== normalizePathForCompare(source)
  );

  // Stale = a registered local bundled marketplace whose source no longer
  // resolves to a manifest, OR whose registered path differs from the live
  // app's bundled path (the Windows app-update signal). A missing marketplace
  // is "not stale" but flagged separately by `present: false`.
  const stale = present && isLocal && (!resolvesToManifest || pathMismatch);
  // Present but not a usable local entry (wrong source_type or empty source):
  // not "stale" in the app-update sense, but it must NOT be reported as healthy.
  const malformed = present && !isLocal;

  const bundledPlugins = COMMON_BUNDLED_PLUGINS.map(id => ({
    id,
    configured: new RegExp(`\\[plugins\\.(?:"${escapeRegExp(`${id}@${OPENAI_BUNDLED_MARKETPLACE_NAME}`)}")\\]`).test(configText),
  }));

  const repairTarget = currentBundledPath ?? `<current ${OPENAI_BUNDLED_MARKETPLACE_NAME} path under the installed Codex app>`;
  const suggestedRepair = (stale || pathMismatch)
    ? `codex plugin marketplace add ${currentBundledPath ? redactUserPath(currentBundledPath) : repairTarget}`
    : null;

  const summary = !present
    ? `no [marketplaces.${OPENAI_BUNDLED_MARKETPLACE_NAME}] entry in Codex config`
    : malformed
      ? `[marketplaces.${OPENAI_BUNDLED_MARKETPLACE_NAME}] is present but not a usable local source (source_type/source missing)`
      : !resolvesToManifest
        ? `stale: registered ${OPENAI_BUNDLED_MARKETPLACE_NAME} source no longer resolves to a marketplace manifest`
        : pathMismatch
          ? `stale: registered ${OPENAI_BUNDLED_MARKETPLACE_NAME} path differs from the installed Codex app's bundled path`
          : `ok: ${OPENAI_BUNDLED_MARKETPLACE_NAME} marketplace resolves`;

  return {
    applicable: true,
    stale,
    marketplace: {
      name: OPENAI_BUNDLED_MARKETPLACE_NAME,
      present,
      sourceType,
      source: source ? redactUserPath(source) : null,
      resolvesToManifest,
      currentBundledPath: currentBundledPath ? redactUserPath(currentBundledPath) : null,
      pathMismatch,
    },
    bundledPlugins,
    suggestedRepair,
    summary,
  };
}
