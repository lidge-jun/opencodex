import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveGuiFile } from "../../src/server/gui-static";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTreeWithRetry(directory);
  }
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
