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
 *
 * The Cursor tab polls its status every 15 seconds, so the answer is cached per update host
 * and platform (successes for 30 minutes, failures for 5) and concurrent lookups share one
 * request: a slow or unreachable channel costs at most one bounded wait per failure window.
 */
const DEFAULT_UPDATE_HOST = "https://api2.cursor.sh";

const UPDATE_MANIFEST_TIMEOUT_MS = 4_000;
const CACHE_TTL_OK_MS = 30 * 60_000;
const CACHE_TTL_FAILED_MS = 5 * 60_000;

/** Channel segments for the builds Cursor ships; Windows uses the per-user installer. */
const PLATFORMS = ["win32-x64-user", "win32-arm64-user", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;

export type CursorLocalPlatform = (typeof PLATFORMS)[number];

export interface CursorLocalInstallerHint {
  /** Whether the channel advertised an installer the dashboard can name. */
  available: boolean;
  /** The download URL from the manifest, when one was advertised. */
  url: string | null;
  /** The advertised installer version, when the manifest carried one. */
  version: string | null;
  /**
   * Why nothing was advertised: no regular install, a host Cursor ships no build for,
   * an unreachable manifest, or an unusable answer.
   */
  reason: "no-regular-install" | "unsupported-platform" | "unreachable" | "unusable-response" | null;
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
  /** Clock for the cache; defaults to `Date.now`. */
  now?(): number;
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
 * The channel segment for this host, or null when Cursor ships no build for it. The installer
 * is architecture-specific, so only `x64` and `arm64` map; any other CPU (ia32, arm, riscv64…)
 * or OS gets no link rather than another machine's build.
 */
export function platformForHost(os: string, arch: string): CursorLocalPlatform | null {
  if (arch !== "x64" && arch !== "arm64") return null;
  switch (os) {
    case "win32": return arch === "arm64" ? "win32-arm64-user" : "win32-x64-user";
    case "darwin": return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
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
  const candidate = typeof record.version === "string" ? record.version : typeof record.productVersion === "string" ? record.productVersion : "";
  const version = candidate.trim();
  if (version === "") return null;
  // The Linux channel advertises the AppImage's zsync delta metadata (what the in-app updater
  // consumes); the installer a person downloads is the sibling AppImage at the same path.
  return { version, url: record.url.replace(/\.AppImage\.zsync$/, ".AppImage") };
}

type ResolvedHint = Omit<CursorLocalInstallerHint, "reason"> & { reason: "unreachable" | "unusable-response" | null };

async function resolveInstaller(deps: CursorLocalHintDeps, updateHost: string, platform: CursorLocalPlatform): Promise<ResolvedHint> {
  const manifestUrl = `${updateHost}/updates/api/update/${platform}/cursor-local/0.0.0/manual-check/stable`;
  let raw: unknown;
  try {
    raw = await deps.fetchJson(manifestUrl, UPDATE_MANIFEST_TIMEOUT_MS);
  } catch {
    return { available: false, url: null, version: null, reason: "unreachable" };
  }
  const installer = parseManifest(raw);
  if (!installer) return { available: false, url: null, version: null, reason: "unusable-response" };
  return { available: true, url: installer.url, version: installer.version, reason: null };
}

const cache = new Map<string, { expiresAt: number; value: Promise<ResolvedHint> }>();

export function resetCursorLocalInstallerCacheForTests(): void {
  cache.clear();
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
  const platform = platformForHost(deps.platform, deps.arch);
  if (!platform) return { available: false, url: null, version: null, reason: "unsupported-platform" };
  const now = deps.now ?? Date.now;
  const key = `${updateHost} ${platform}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;
  const value = resolveInstaller(deps, updateHost, platform);
  // The in-flight promise is shared immediately; its lifetime is settled once it answers.
  cache.set(key, { expiresAt: Number.POSITIVE_INFINITY, value });
  const settled = await value;
  cache.set(key, { expiresAt: now() + (settled.available ? CACHE_TTL_OK_MS : CACHE_TTL_FAILED_MS), value });
  return settled;
}
