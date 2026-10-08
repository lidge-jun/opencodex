import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_PRODUCT_NAME,
  findGuiDist,
  serveGuiFile,
  standaloneGuiDistCandidates,
} from "../../src/server/gui-static";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const temporaryDirectories: string[] = [];
const previousGuiDist = process.env.OPENCODEX_GUI_DIST;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTreeWithRetry(directory);
  }
  if (previousGuiDist === undefined) delete process.env.OPENCODEX_GUI_DIST;
  else process.env.OPENCODEX_GUI_DIST = previousGuiDist;
});

test("serves the dashboard from OPENCODEX_GUI_DIST when no explicit root is supplied", async () => {
  const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-static-override-"));
  temporaryDirectories.push(guiDist);
  writeFileSync(join(guiDist, "index.html"), "<!doctype html><title>standalone</title>");
  process.env.OPENCODEX_GUI_DIST = guiDist;
  const response = serveGuiFile("/");
  expect(response).not.toBeNull();
  expect(await response!.text()).toContain("standalone");
});

test("#2792 snapshots a static asset before server framing can outlive the file", async () => {
  const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-static-"));
  temporaryDirectories.push(guiDist);
  writeFileSync(join(guiDist, "index.html"), "<!doctype html>");
  const assetPath = join(guiDist, "index.js");
  const originalAsset = "console.log('complete dashboard asset');";
  writeFileSync(assetPath, originalAsset);

  const response = serveGuiFile("/index.js", guiDist);
  expect(response).not.toBeNull();

  // A package update may replace gui/dist after the response is constructed. The response
  // body must retain the same byte snapshot the HTTP server uses for Content-Length.
  writeFileSync(assetPath, "truncated");
  expect(await response!.text()).toBe(originalAsset);
});

test("serves immutable cache header for assets and no-cache for non-hashed static files", async () => {
  const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-static-cache-"));
  temporaryDirectories.push(guiDist);
  writeFileSync(join(guiDist, "index.html"), "<!doctype html>");

  mkdirSync(join(guiDist, "assets", "chunks"), { recursive: true });
  mkdirSync(join(guiDist, "provider-icons"), { recursive: true });

  const hashedAssetPath = join(guiDist, "assets", "index-B5r7LNHN.js");
  writeFileSync(hashedAssetPath, "console.log('hashed asset');");
  const nestedAssetPath = join(guiDist, "assets", "chunks", "vendor-D7A_7j3g.js");
  writeFileSync(nestedAssetPath, "console.log('nested asset');");

  const faviconPath = join(guiDist, "favicon.png");
  writeFileSync(faviconPath, "fake-png-bytes");
  const iconPath = join(guiDist, "provider-icons", "openai.svg");
  writeFileSync(iconPath, "<svg></svg>");
  const unhashedAssetPath = join(guiDist, "assets", "runtime-config.js");
  writeFileSync(unhashedAssetPath, "window.__CONFIG__ = {};");
  const shortSuffixAssetPath = join(guiDist, "assets", "logo-small.png");
  writeFileSync(shortSuffixAssetPath, "fake-png-bytes");

  // Hashed bundle asset under /assets/ should be cached immutably for 1 year
  const assetResponse = serveGuiFile("/assets/index-B5r7LNHN.js", guiDist);
  expect(assetResponse).not.toBeNull();
  expect(assetResponse!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

  // Nested asset under /assets/chunks/ should also be cached immutably
  const nestedResponse = serveGuiFile("/assets/chunks/vendor-D7A_7j3g.js", guiDist);
  expect(nestedResponse).not.toBeNull();
  expect(nestedResponse!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

  // Unhashed asset under /assets/ must NOT be cached immutably (regression check for CodeRabbit finding)
  const unhashedResponse = serveGuiFile("/assets/runtime-config.js", guiDist);
  expect(unhashedResponse).not.toBeNull();
  expect(unhashedResponse!.headers.get("Cache-Control")).toBe("no-cache");

  // Asset with short suffix that doesn't match content-hash pattern must fall back to no-cache
  const shortSuffixResponse = serveGuiFile("/assets/logo-small.png", guiDist);
  expect(shortSuffixResponse).not.toBeNull();
  expect(shortSuffixResponse!.headers.get("Cache-Control")).toBe("no-cache");

  // Non-hashed root asset should revalidate
  const faviconResponse = serveGuiFile("/favicon.png", guiDist);
  expect(faviconResponse).not.toBeNull();
  expect(faviconResponse!.headers.get("Cache-Control")).toBe("no-cache");

  // Non-hashed subdirectory asset should revalidate
  const iconResponse = serveGuiFile("/provider-icons/openai.svg", guiDist);
  expect(iconResponse).not.toBeNull();
  expect(iconResponse!.headers.get("Cache-Control")).toBe("no-cache");

  // HTML must remain no-store with Pragma: no-cache
  const htmlResponse = serveGuiFile("/index.html", guiDist);
  expect(htmlResponse).not.toBeNull();
  expect(htmlResponse!.headers.get("Cache-Control")).toBe("no-store");
  expect(htmlResponse!.headers.get("Pragma")).toBe("no-cache");

  // SPA virtual route fallback (e.g. /models) must return index.html with no-store
  const spaResponse = serveGuiFile("/models", guiDist);
  expect(spaResponse).not.toBeNull();
  expect(spaResponse!.headers.get("Cache-Control")).toBe("no-store");

  // Directory traversal attempt out of /assets/ must not be treated as immutable
  const traversalResponse = serveGuiFile("/assets/../favicon.png", guiDist);
  expect(traversalResponse).not.toBeNull();
  expect(traversalResponse!.headers.get("Cache-Control")).toBe("no-cache");
});

/** Lay out `<root>/<segments>/index.html` and return the directory holding it. */
function writeGuiDist(root: string, ...segments: string[]): string {
  const guiDist = join(root, ...segments);
  mkdirSync(guiDist, { recursive: true });
  writeFileSync(join(guiDist, "index.html"), "<!doctype html>");
  return guiDist;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

test("a standalone ocx in a Linux desktop package finds the dashboard under lib/<productName>", () => {
  // The .deb installs the sidecar as /usr/bin/ocx and its resources under /usr/lib/OpenCodex.
  // `ocx ensure` from the Codex shim starts that binary without OPENCODEX_GUI_DIST.
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-linux-");
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  const bundled = writeGuiDist(root, "usr", "lib", DESKTOP_PRODUCT_NAME, "gui", "dist");
  expect(findGuiDist(join(root, "usr", "bin"), "linux")).toBe(bundled);
});

test("a standalone ocx in a macOS app bundle finds the dashboard under Contents/Resources", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-macos-");
  const macos = join(root, "OpenCodex.app", "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  const bundled = writeGuiDist(root, "OpenCodex.app", "Contents", "Resources", "gui", "dist");
  expect(findGuiDist(macos, "darwin")).toBe(bundled);
});

test("gui/dist beside the binary still wins over a desktop bundle layout", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-beside-");
  const executableDir = join(root, "usr", "bin");
  const beside = writeGuiDist(executableDir, "gui", "dist");
  writeGuiDist(root, "usr", "lib", DESKTOP_PRODUCT_NAME, "gui", "dist");
  expect(findGuiDist(executableDir, "linux")).toBe(beside);
});

test("OPENCODEX_GUI_DIST still overrides a desktop bundle layout", () => {
  const root = temporaryRoot("ocx-gui-static-env-");
  writeGuiDist(root, "usr", "lib", DESKTOP_PRODUCT_NAME, "gui", "dist");
  const override = writeGuiDist(root, "override");
  process.env.OPENCODEX_GUI_DIST = override;
  expect(findGuiDist(join(root, "usr", "bin"), "linux")).toBe(override);
});

test("each platform consults only its own desktop bundle layout", () => {
  const executableDir = join("opt", "ocx", "bin");
  const beside = join(executableDir, "gui", "dist");
  expect(standaloneGuiDistCandidates(executableDir, "win32")).toEqual([beside]);
  expect(standaloneGuiDistCandidates(executableDir, "darwin"))
    .toEqual([beside, join(executableDir, "..", "Resources", "gui", "dist")]);
  expect(standaloneGuiDistCandidates(executableDir, "linux"))
    .toEqual([beside, join(executableDir, "..", "lib", DESKTOP_PRODUCT_NAME, "gui", "dist")]);
});

test("the Linux bundle directory and the resource path follow the desktop Tauri config", () => {
  // Tauri names the Linux resource directory after productName and copies gui/dist under the
  // mapped name; a rename on either side would silently send the dashboard lookup elsewhere.
  const config = JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8")) as {
    productName?: string;
    bundle?: { resources?: Record<string, string> };
  };
  expect(config.productName).toBe(DESKTOP_PRODUCT_NAME);
  expect(Object.values(config.bundle?.resources ?? {})).toContain("gui/dist");
});
