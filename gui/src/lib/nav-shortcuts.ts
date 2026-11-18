/**
 * Keyboard shortcuts for the sidebar (components/sidebar-nav.tsx): which modifier the
 * number shortcuts use on this surface, and how a shortcut is written for people.
 */

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null);
}

export type ShortcutStyle = "desktop-mac" | "desktop" | "browser-mac" | "browser";

/**
 * Number shortcuts use the platform's command key inside the desktop shell. A browser keeps
 * Cmd/Ctrl+digit for switching its own tabs (a page cannot take it back), so there the
 * dashboard listens on Option/Alt+digit instead.
 */
export function shortcutStyle(desktopShell: boolean, userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): ShortcutStyle {
  const mac = /Mac OS X|Macintosh/i.test(userAgent);
  if (desktopShell) return mac ? "desktop-mac" : "desktop";
  return mac ? "browser-mac" : "browser";
}

export function shortcutLabel(style: ShortcutStyle, key: string): string {
  switch (style) {
    case "desktop-mac": return `⌘${key}`;
    case "desktop": return `Ctrl+${key}`;
    case "browser-mac": return `⌥${key}`;
    default: return `Alt+${key}`;
  }
}

/** Menu search: Cmd+K on a Mac, Ctrl+K elsewhere, in the shell and the browser alike. */
export function searchShortcutLabel(style: ShortcutStyle): string {
  return style === "desktop-mac" || style === "browser-mac" ? "⌘K" : "Ctrl+K";
}

export function numberModifierHeld(style: ShortcutStyle, event: KeyboardEvent): boolean {
  if (event.shiftKey) return false;
  switch (style) {
    case "desktop-mac": return event.metaKey && !event.ctrlKey && !event.altKey;
    case "desktop": return event.ctrlKey && !event.metaKey && !event.altKey;
    default: return event.altKey && !event.metaKey && !event.ctrlKey;
  }
}

/** All settings: the platform's settings shortcut, desktop shell only. */
export function settingsShortcutLabel(style: ShortcutStyle): string {
  return style === "desktop-mac" ? "⌘," : "Ctrl+,";
}
