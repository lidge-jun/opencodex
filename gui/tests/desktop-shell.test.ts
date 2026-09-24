import { describe, expect, test } from "bun:test";
import {
  desktopSession,
  desktopUpdatePageUrl,
  desktopShellVersion,
  hostOs,
  isDesktopShell,
  isExternalLink,
  updateBadgeUrl,
} from "../src/lib/desktop-shell";

const tauriMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) OpenCodexDesktop/2.61.0";
const tauriWindows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OpenCodexDesktop/2.61.0";
const tauriLinux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OpenCodexDesktop/2.61.0";

describe("desktop shell user-agent helpers", () => {
  test("detects shell versions across desktop platforms", () => {
    expect(desktopShellVersion(tauriMac)).toBe("2.61.0");
    expect(isDesktopShell(tauriWindows)).toBe(true);
    expect(isDesktopShell("Mozilla/5.0 Chrome/140.0")).toBe(false);
  });

  test("detects host operating systems without treating Android as Linux", () => {
    expect(hostOs(tauriMac)).toBe("macos");
    expect(hostOs(tauriWindows)).toBe("windows");
    expect(hostOs(tauriLinux)).toBe("linux");
    expect(hostOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/140.0")).toBe("macos");
    expect(hostOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0")).toBe("windows");
    expect(hostOs("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0")).toBe("linux");
    expect(hostOs("Mozilla/5.0 (Linux; Android 15) Chrome/140.0")).toBe("unknown");
    expect(hostOs("unknown")).toBe("unknown");
  });

  test("routes bundled updates to each platform's exact app origin", () => {
    expect(desktopUpdatePageUrl(tauriMac)).toBe("tauri://localhost/update.html");
    expect(desktopUpdatePageUrl(tauriLinux)).toBe("tauri://localhost/update.html");
    expect(desktopUpdatePageUrl(tauriWindows)).toBe("http://tauri.localhost/update.html");
    expect(desktopUpdatePageUrl("Mozilla/5.0 Chrome/140.0")).toBeNull();
  });

  test("desktop session selects its badge, ordinary browser keeps package badge", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(desktopSession("?desktop_session=" + id)).toBe(id);
    expect(desktopSession("?desktop_session=not-a-uuid")).toBeNull();
    expect(updateBadgeUrl("", tauriMac, "?desktop_session=" + id))
      .toBe("/api/update/badge?surface=desktop&session=" + id);
    expect(updateBadgeUrl("", tauriMac, ""))
      .toBe("/api/update/badge?surface=desktop");
    expect(updateBadgeUrl("", "Mozilla/5.0 Chrome/140.0", "?desktop_session=" + id))
      .toBe("/api/update/badge");
  });

  test("recognizes only absolute cross-origin HTTP links", () => {
    expect(isExternalLink("https://example.com/a", "http://127.0.0.1:10100")).toBe(true);
    expect(isExternalLink("http://127.0.0.1:10100/a", "http://127.0.0.1:10100")).toBe(false);
    expect(isExternalLink("/#/usage", "http://127.0.0.1:10100")).toBe(false);
    expect(isExternalLink("mailto:hello@example.com", "http://127.0.0.1:10100")).toBe(false);
  });
});
