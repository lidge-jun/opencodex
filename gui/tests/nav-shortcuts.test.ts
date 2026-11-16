import { expect, test } from "bun:test";
import { numberModifierHeld, searchShortcutLabel, settingsShortcutLabel, shortcutLabel, shortcutStyle } from "../src/lib/nav-shortcuts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

test("the desktop shell uses the command key; a browser keeps Cmd/Ctrl+digit for its tabs", () => {
  expect(shortcutStyle(true, MAC)).toBe("desktop-mac");
  expect(shortcutStyle(true, WIN)).toBe("desktop");
  expect(shortcutStyle(false, MAC)).toBe("browser-mac");
  expect(shortcutStyle(false, WIN)).toBe("browser");

  expect(numberModifierHeld("desktop-mac", key({ metaKey: true }))).toBe(true);
  expect(numberModifierHeld("desktop", key({ ctrlKey: true }))).toBe(true);
  expect(numberModifierHeld("browser", key({ altKey: true }))).toBe(true);
  expect(numberModifierHeld("browser", key({ ctrlKey: true }))).toBe(false);
  expect(numberModifierHeld("desktop-mac", key({ metaKey: true, shiftKey: true }))).toBe(false);
});

test("shortcuts are written the way each platform writes them", () => {
  expect(shortcutLabel("desktop-mac", "1")).toBe("⌘1");
  expect(shortcutLabel("desktop", "1")).toBe("Ctrl+1");
  expect(shortcutLabel("browser-mac", "1")).toBe("⌥1");
  expect(shortcutLabel("browser", "1")).toBe("Alt+1");
  expect(searchShortcutLabel("browser-mac")).toBe("⌘K");
  expect(searchShortcutLabel("desktop")).toBe("Ctrl+K");
  expect(settingsShortcutLabel("desktop-mac")).toBe("⌘,");
});

test("Fine-tuning folds by default and search sits beside the Everyday heading", async () => {
  const nav = await Bun.file(new URL("../src/components/sidebar-nav.tsx", import.meta.url)).text();
  expect(nav).toContain('localStorage.getItem(ADVANCED_OPEN_KEY) === "1"');
  expect(nav).toContain("aria-expanded={advancedOpen}");
  expect(nav).toContain('className="nav-search-open"');
});
