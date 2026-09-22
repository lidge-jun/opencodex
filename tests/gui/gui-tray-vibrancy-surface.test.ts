import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The tray popup's glass surface spans two languages: the Tauri shell decides whether the
 * window is translucent and writes a dataset flag onto <html>, and the stylesheet decides
 * whether to make the page background transparent by selecting on that flag.
 *
 * Nothing in either toolchain connects them. If the Rust side renames the flag, the CSS keeps
 * compiling and keeps passing every gate, and the popup silently loses its glass on macOS --
 * or worse, keeps a transparent background on a platform whose window is opaque, which paints
 * a hole instead of a panel. This is the union defect this repository keeps rediscovering:
 * two sides each correct alone, wrong together, with no check that reads both.
 */
const popup = readFileSync(repoPath("desktop", "src-tauri", "src", "popup.rs"), "utf8");
const stylesheet = readFileSync(repoPath("gui", "src", "pages", "tray.css"), "utf8");

/** `document.documentElement.dataset.trayVibrancy` -> `data-tray-vibrancy`. */
function datasetAttribute(expression: string): string {
  const property = expression.slice(expression.lastIndexOf(".") + 1);
  return `data-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

describe("tray popup vibrancy hook", () => {
  test("the stylesheet selects the attribute the shell actually writes", () => {
    const written = popup.match(/const TRAY_VIBRANCY_DATASET: &str = "([^"]+)"/);
    expect(written, "popup.rs no longer declares TRAY_VIBRANCY_DATASET").not.toBeNull();
    const attribute = datasetAttribute(written![1]);
    expect(attribute).toBe("data-tray-vibrancy");
    expect(stylesheet).toContain(`[${attribute}='on']`);
  });

  test("the shell writes the same enabled value the stylesheet selects", () => {
    const enabled = popup.match(/if VIBRANT_SURFACE \{ "([^"]+)" \} else \{ "([^"]+)" \}/);
    expect(enabled, "popup.rs no longer derives the flag value from VIBRANT_SURFACE").not.toBeNull();
    const [, on, off] = enabled!;
    const attribute = datasetAttribute(popup.match(/const TRAY_VIBRANCY_DATASET: &str = "([^"]+)"/)![1]);
    expect(stylesheet).toContain(`[${attribute}='${on}']`);
    // The opaque value must never carry styling of its own; the opaque case is the default.
    expect(stylesheet).not.toContain(`[${attribute}='${off}']`);
  });

  test("transparency is opt-in, so the opaque default survives a platform without vibrancy", () => {
    const block = (selector: string) => {
      const start = stylesheet.indexOf(`${selector} {`);
      expect(start, `tray.css no longer declares ${selector}`).toBeGreaterThanOrEqual(0);
      return stylesheet.slice(start, stylesheet.indexOf("}", start));
    };
    expect(block("html.tray-document[data-tray-vibrancy='on']")).toContain("background: transparent;");
    // The base rule is what a platform without vibrancy renders; a transparent root there
    // paints a hole rather than a panel.
    expect(block("html.tray-document")).not.toContain("background: transparent;");
  });
});
