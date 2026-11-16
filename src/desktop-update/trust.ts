/**
 * Trust and transport constants for the headless Windows Desktop updater (#8246).
 *
 * The public key and feed are the ones the Desktop GUI updater embeds in
 * `desktop/src-tauri/tauri.conf.json` (`plugins.updater`). They are restated here because a
 * compiled `ocx.exe` cannot read the Tauri configuration at run time;
 * `tests/update/update-desktop-headless-release.test.ts` fails if either copy drifts, so the headless path
 * can never verify with a key the GUI would not use.
 */

/** Base64 of the minisign public-key box; byte-identical to `plugins.updater.pubkey`. */
export const DESKTOP_UPDATER_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFDNzZCMDg0NkVCRUJGODEKUldTQnY3NXVoTEIyckhRUXJMOXJRUDR0aHQ2L3pLVHVweXFSc1lzS24vWDNiSUJ5MXJIZmpyb2sK";

/** The published channel the GUI updater checks; identical to `plugins.updater.endpoints[0]`. */
export const DESKTOP_UPDATE_FEED_URL = "https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json";

/** Every request starts on this exact release source. */
export const DESKTOP_RELEASE_ORIGIN = "https://github.com";
export const DESKTOP_RELEASE_PATH_PREFIX = "/lidge-jun/opencodex/releases/";

/** Redirect targets GitHub uses for release assets. Anything else is refused, never widened. */
export const DESKTOP_REDIRECT_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/** The latest.json platform key the Windows x64 MSI is published under. */
export const DESKTOP_WINDOWS_PLATFORM = "windows-x86_64";

export const DESKTOP_ACQUIRE_LIMITS = Object.freeze({
  maxRedirects: 3,
  /** Implementation maximum for the installer; a Content-Length header is advisory only. */
  maxArtifactBytes: 1024 * 1024 * 1024,
  maxFeedBytes: 256 * 1024,
  connectMs: 10_000,
  idleReadMs: 30_000,
  totalMs: 20 * 60_000,
});

/** Exact asset URL a verified release record must name for this version. */
export function desktopInstallerUrl(version: string): string {
  return `${DESKTOP_RELEASE_ORIGIN}${DESKTOP_RELEASE_PATH_PREFIX}download/v${version}/OpenCodex-${version}-windows-x64.msi`;
}
