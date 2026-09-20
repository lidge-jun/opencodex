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

export function hostOs(ua = currentUserAgent()): HostOs {
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "unknown";
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
