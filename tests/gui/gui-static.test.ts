import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_PRODUCT_NAME,
  findGuiDist,
  rootFallbackPayload,
  serveGuiFile,
  standaloneGuiDistCandidates,
  type GuiDistLookup,
} from "../../src/server/gui-static";
import type { GuiSessionBootstrap } from "../../src/server/gui-session";
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
  writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head><title>fixture</title></head><body></body></html>");
  return guiDist;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

/**
 * Discovery inputs rooted in a synthetic tree. The module directory points at a source checkout
 * inside the same tree, so this repository's own gui/dist never leaks into a fixture.
 */
function lookupIn(root: string, standaloneDir: string | null, platform: NodeJS.Platform): GuiDistLookup {
  return { standaloneDir, platform, moduleDir: join(root, "checkout", "src", "server") };
}

interface PackagedLayout {
  platform: NodeJS.Platform;
  /** Directory holding the `ocx` sidecar, relative to the fixture root. */
  executable: string[];
  /** Where the package installs the dashboard, relative to the fixture root. */
  guiDist: string[];
}

const linuxLib = (...prefix: string[]) => [...prefix, "lib", DESKTOP_PRODUCT_NAME, "gui", "dist"];

/** Every layout a packaged `ocx` runs from; Tauri's resource_dir rules decide the dashboard path. */
const PACKAGED_LAYOUTS: [string, PackagedLayout][] = [
  ["Linux .deb (/usr/bin -> /usr/lib/OpenCodex)", { platform: "linux", executable: ["usr", "bin"], guiDist: linuxLib("usr") }],
  ["Linux AppImage mount ($APPDIR/usr/bin -> $APPDIR/usr/lib/OpenCodex)", {
    platform: "linux",
    executable: [".mount_OpenCo1a2b3c", "usr", "bin"],
    guiDist: linuxLib(".mount_OpenCo1a2b3c", "usr"),
  }],
  ["Linux /usr/local prefix", { platform: "linux", executable: ["usr", "local", "bin"], guiDist: linuxLib("usr", "local") }],
  ["Linux custom /opt prefix", { platform: "linux", executable: ["opt", "opencodex", "bin"], guiDist: linuxLib("opt", "opencodex") }],
  ["macOS app bundle (Contents/MacOS -> Contents/Resources)", {
    platform: "darwin",
    executable: ["OpenCodex.app", "Contents", "MacOS"],
    guiDist: ["OpenCodex.app", "Contents", "Resources", "gui", "dist"],
  }],
  ["Windows install (resources beside ocx.exe)", { platform: "win32", executable: ["OpenCodex"], guiDist: ["OpenCodex", "gui", "dist"] }],
];

test.each(PACKAGED_LAYOUTS)("a standalone ocx finds the packaged dashboard: %s", (_name, layout) => {
  // The desktop shell passes OPENCODEX_GUI_DIST only to the sidecar it starts; `ocx ensure` from
  // the Codex shim and the login service start the same binary without it.
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-layout-");
  const executableDir = join(root, ...layout.executable);
  mkdirSync(executableDir, { recursive: true });
  const bundled = writeGuiDist(root, ...layout.guiDist);
  expect(findGuiDist(lookupIn(root, executableDir, layout.platform))).toBe(bundled);
});

test("a Windows install consults neither the Linux nor the macOS bundle directory", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-windows-");
  const executableDir = join(root, "OpenCodex");
  mkdirSync(executableDir, { recursive: true });
  const linuxBundle = writeGuiDist(root, ...linuxLib());
  writeGuiDist(root, "Resources", "gui", "dist");
  expect(findGuiDist(lookupIn(root, executableDir, "win32"))).toBeNull();
  // The same tree is a Linux package to a Linux binary, so the fixture itself is reachable.
  expect(findGuiDist(lookupIn(root, executableDir, "linux"))).toBe(linuxBundle);
});

test("gui/dist beside the binary still wins over a desktop bundle layout", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-beside-");
  const executableDir = join(root, "usr", "bin");
  const beside = writeGuiDist(executableDir, "gui", "dist");
  writeGuiDist(root, ...linuxLib("usr"));
  expect(findGuiDist(lookupIn(root, executableDir, "linux"))).toBe(beside);
});

test("OPENCODEX_GUI_DIST overrides every packaged layout", () => {
  const root = temporaryRoot("ocx-gui-static-env-");
  const override = writeGuiDist(root, "override");
  process.env.OPENCODEX_GUI_DIST = override;
  for (const [name, layout] of PACKAGED_LAYOUTS) {
    const executableDir = join(root, ...layout.executable);
    mkdirSync(executableDir, { recursive: true });
    writeGuiDist(root, ...layout.guiDist);
    expect([name, findGuiDist(lookupIn(root, executableDir, layout.platform))]).toEqual([name, override]);
  }
});

test("a source checkout serves its own gui/dist and never consults a bundle layout", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-source-");
  writeGuiDist(root, ...linuxLib("usr"));
  const checkout = writeGuiDist(root, "checkout", "gui", "dist");
  expect(findGuiDist(lookupIn(root, null, "linux"))).toBe(checkout);
});

test("a packaged layout comes before the source-checkout fallback", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-order-");
  const executableDir = join(root, "usr", "bin");
  mkdirSync(executableDir, { recursive: true });
  const bundled = writeGuiDist(root, ...linuxLib("usr"));
  writeGuiDist(root, "checkout", "gui", "dist");
  expect(findGuiDist(lookupIn(root, executableDir, "linux"))).toBe(bundled);
});

test("absent resources leave GET / to the JSON fallback", () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-absent-");
  for (const [name, layout] of PACKAGED_LAYOUTS) {
    const executableDir = join(root, ...layout.executable);
    mkdirSync(executableDir, { recursive: true });
    expect([name, findGuiDist(lookupIn(root, executableDir, layout.platform))]).toEqual([name, null]);
  }
  expect(findGuiDist(lookupIn(root, null, "linux"))).toBeNull();
  expect(serveGuiFile("/", findGuiDist(lookupIn(root, join(root, "usr", "bin"), "linux")))).toBeNull();
  expect(rootFallbackPayload().dashboard.available).toBe(false);
});

test("a discovered bundle serves index.html with the session bootstrap", async () => {
  delete process.env.OPENCODEX_GUI_DIST;
  const root = temporaryRoot("ocx-gui-static-session-");
  const executableDir = join(root, "usr", "bin");
  mkdirSync(executableDir, { recursive: true });
  writeGuiDist(root, ...linuxLib("usr"));
  const session: GuiSessionBootstrap = {
    token: "fixture-token",
    csrfToken: "fixture-csrf",
    serverOrigin: "http://127.0.0.1:10100",
    browserOrigin: "http://127.0.0.1:10100",
    expiresAt: Date.now() + 60_000,
    issuance: "loopback",
  };
  const guiDist = findGuiDist(lookupIn(root, executableDir, "linux"));
  for (const pathname of ["/", "/models"]) {
    const response = serveGuiFile(pathname, guiDist, session);
    expect(response).not.toBeNull();
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
    const html = await response!.text();
    expect(html).toContain('<meta name="opencodex-session-token" content="fixture-token">');
    expect(html.indexOf("opencodex-session-csrf")).toBeLessThan(html.indexOf("</head>"));
  }
});

test("discovery only reads: it creates no files and leaves the environment alone", () => {
  const root = temporaryRoot("ocx-gui-static-readonly-");
  for (const [, layout] of PACKAGED_LAYOUTS) {
    mkdirSync(join(root, ...layout.executable), { recursive: true });
  }
  writeGuiDist(root, ...linuxLib("usr"));
  const listing = () => readdirSync(root, { recursive: true }).map(String).sort();
  const treeBefore = listing();
  const environmentBefore = { ...process.env };
  for (const [, layout] of PACKAGED_LAYOUTS) {
    findGuiDist(lookupIn(root, join(root, ...layout.executable), layout.platform));
  }
  findGuiDist(lookupIn(root, null, "linux"));
  expect(listing()).toEqual(treeBefore);
  expect({ ...process.env }).toEqual(environmentBefore);
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
