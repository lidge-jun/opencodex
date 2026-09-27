export type HostOs = "macos" | "windows" | "linux" | "unknown";

function currentUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

export function desktopShellVersion(ua = currentUserAgent()): string | null {
  return ua.match(/OpenCodexDesktop\/(\S+)/)?.[1] ?? null;
}

export function isDesktopShell(ua = currentUserAgent()): boolean {
  return desktopShellVersion(ua) !== null;
}

const DESKTOP_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function desktopSession(search = typeof location === "undefined" ? "" : location.search): string | null {
  const value = new URLSearchParams(search).get("desktop_session");
  return value && DESKTOP_SESSION.test(value) ? value : null;
}

export function updateBadgeUrl(apiBase: string, ua?: string, search?: string): string {
  const base = apiBase + "/api/update/badge";
  if (!isDesktopShell(ua)) return base;
  const session = desktopSession(search);
  return base + "?surface=desktop" + (session ? "&session=" + encodeURIComponent(session) : "");
}

export function hostOs(ua = currentUserAgent()): HostOs {
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "unknown";
}

export function desktopUpdatePageUrl(ua = currentUserAgent()): string | null {
  if (!isDesktopShell(ua)) return null;
  const os = hostOs(ua);
  if (os === "windows") return "http://tauri.localhost/update.html";
  if (os === "macos" || os === "linux") return "tauri://localhost/update.html";
  return null;
}

export function openDesktopUpdatePage(ua = currentUserAgent()): boolean {
  const url = desktopUpdatePageUrl(ua);
  if (!url) return false;
  window.location.assign(url);
  return true;
}

export function isExternalLink(
  href: string,
  origin = typeof location === "undefined" ? "" : location.origin,
): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== origin;
  } catch {
    return false;
  }
}
