/**
 * The `cursor-local` update channel is how Cursor now distributes Private Inference: a
 * same-version installer advertised through the regular install's own update endpoint
 * (Cursor 3.21.18+). Regular Cursor users were previously told "not found" with no path
 * forward; the channel manifest is the path forward, surfaced read-only.
 *
 * This module never downloads, launches, or installs anything: it formats one URL the
 * dashboard shows the user. The manifest request is a plain GET of a public endpoint and
 * its failure degrades to `available: false` with the reason recorded — the update
 * endpoint is undocumented and can change shape or vanish without notice.
 */
const DEFAULT_UPDATE_HOST = "https://api2.cursor.sh";

const UPDATE_MANIFEST_TIMEOUT_MS = 4_000;

/** Windows platform segments observed in the wild; each maps to its installer kind. */
const WINDOWS_PLATFORMS = ["win32-x64-user", "win32-arm64-user", "win32-x64"] as const;

const DARWIN_PLATFORMS = ["darwin-arm64", "darwin-x64", "darwin-universal"] as const;

const LINUX_PLATFORMS = ["linux-x64", "linux-arm64"] as const;

const PLATFORM_ORDER = [...WINDOWS_PLATFORMS, ...DARWIN_PLATFORMS, ...LINUX_PLATFORMS] as const;

export type CursorLocalPlatform = (typeof PLATFORM_ORDER)[number];

export interface CursorLocalInstallerHint {
  /** Whether the channel advertised an installer the dashboard can name. */
  available: boolean;
  /** The download URL from the manifest, when one was advertised. */
  url: string | null;
  /** The advertised installer version, when the manifest carried one. */
  version: string | null;
  /** Why nothing was advertised: no install, unreachable manifest, or unusable shape. */
  reason: "no-regular-install" | "unreachable" | "unusable-response" | null;
}

interface CursorLocalManifest {
  version?: unknown;
  url?: unknown;
  productVersion?: unknown;
}

interface CursorLocalHintDeps {
  platform: string;
  /** `process.arch` values; the installer is architecture-specific. */
  arch: string;
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
}

export function realCursorLocalHintDeps(): CursorLocalHintDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    fetchJson: async (url, timeoutMs) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  };
}

/**
 * The channel segment for this host. The installer is architecture-specific, so an Intel Mac,
 * an arm64 Linux box or a Windows on Arm machine must not be handed the other architecture's
 * build. Windows uses the per-user installer, which is what the reported manifest serves.
 */
export function platformForHost(os: string, arch: string): CursorLocalPlatform | null {
  switch (os) {
    case "win32": return arch === "arm64" ? "win32-arm64-user" : "win32-x64-user";
    case "darwin": return arch === "x64" ? "darwin-x64" : "darwin-arm64";
    case "linux": return arch === "arm64" ? "linux-arm64" : "linux-x64";
    default: return null;
  }
}

function parseManifest(raw: unknown): { version: string; url: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as CursorLocalManifest;
  if (typeof record.url !== "string" || !/^https:\/\/downloads\.cursor\.com\/local-mode\//.test(record.url)) {
    return null;
  }
  const version = typeof record.version === "string" ? record.version : typeof record.productVersion === "string" ? record.productVersion : null;
  if (version === null) return null;
  // The Linux channel advertises the AppImage's zsync delta metadata (what the in-app updater
  // consumes); the installer a person downloads is the sibling AppImage at the same path.
  return { version, url: record.url.replace(/\.AppImage\.zsync$/, ".AppImage") };
}

/**
 * Resolve the installer URL Cursor's own update channel advertises for this host. On an
 * unknown host OS the first manifest that answers wins: the channel exists on every
 * platform Cursor ships, and the URL is only ever shown, not executed. A thrown fetch
 * failure propagates as "unreachable"; a manifest that answers with an unusable shape
 * resolves to null ("unusable-response"), because the endpoint answered but said nothing.
 */
async function resolveInstaller(
  deps: CursorLocalHintDeps,
  updateHost: string,
): Promise<{ version: string; url: string } | null> {
  const hostPlatform = platformForHost(deps.platform, deps.arch);
  const platforms = hostPlatform ? [hostPlatform] : PLATFORM_ORDER;
  let lastFailure: unknown = null;
  for (const platform of platforms) {
    const manifestUrl = `${updateHost}/updates/api/update/${platform}/cursor-local/0.0.0/manual-check/stable`;
    try {
      const parsed = parseManifest(await deps.fetchJson(manifestUrl, UPDATE_MANIFEST_TIMEOUT_MS));
      if (parsed) return parsed;
    } catch (error) {
      // The update endpoint is undocumented; a refused or odd platform answer is not
      // evidence the channel is gone. Fall through to the next platform.
      lastFailure = error;
    }
  }
  if (lastFailure !== null) throw lastFailure;
  return null;
}

/**
 * Build the installer hint for the dashboard's Cursor card. The hint is only resolved
 * when a regular install exists but Private Inference does not — the exact "not found"
 * state the card could previously do nothing about.
 */
export async function buildCursorLocalInstallerHint(
  installs: { regularInstalled: boolean; privateInferenceInstalled: boolean },
  deps: CursorLocalHintDeps = realCursorLocalHintDeps(),
  updateHost: string = DEFAULT_UPDATE_HOST,
): Promise<CursorLocalInstallerHint> {
  if (installs.privateInferenceInstalled || !installs.regularInstalled) {
    return { available: false, url: null, version: null, reason: installs.privateInferenceInstalled ? null : "no-regular-install" };
  }
  try {
    const installer = await resolveInstaller(deps, updateHost);
    if (!installer) return { available: false, url: null, version: null, reason: "unusable-response" };
    return { available: true, url: installer.url, version: installer.version, reason: null };
  } catch {
    return { available: false, url: null, version: null, reason: "unreachable" };
  }
}
