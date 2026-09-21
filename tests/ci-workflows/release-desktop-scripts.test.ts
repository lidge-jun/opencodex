import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleaseAssets } from "../../desktop/scripts/collect-release-assets";
import { buildUpdaterManifest, writeUpdaterManifest } from "../../desktop/scripts/updater-manifest";
import { repoPath } from "../helpers/repo-root";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "opencodex-release-"));
}

describe("desktop release scripts", () => {
  test("renames macOS DMG and updater archive and copies signatures", () => {
    const root = temporaryDirectory();
    try {
      const bundleRoot = join(
        root,
        "desktop",
        "src-tauri",
        "target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
      );
      const dmg = join(bundleRoot, "dmg");
      const macos = join(bundleRoot, "macos");
      mkdirSync(dmg, { recursive: true });
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(dmg, "OpenCodex_2.61.0_aarch64.dmg"), "dmg");
      writeFileSync(join(macos, "OpenCodex.app.tar.gz"), "archive");
      writeFileSync(join(macos, "OpenCodex.app.tar.gz.sig"), "archive-signature");

      const out = join(root, "release");
      const files = collectReleaseAssets({
        version: "2.61.0",
        target: "aarch64-apple-darwin",
        out,
        repoRoot: root,
      });

      expect(files.map(path => path.split("/").at(-1))).toEqual([
        "OpenCodex-2.61.0-macos.dmg",
        "OpenCodex-2.61.0-macos.dmg.sha256",
        "OpenCodex-2.61.0-macos.app.tar.gz",
        "OpenCodex-2.61.0-macos.app.tar.gz.sig",
        "OpenCodex-2.61.0-macos.app.tar.gz.sha256",
      ]);
      expect(readFileSync(join(out, "OpenCodex-2.61.0-macos.app.tar.gz.sha256"), "utf8")).toMatch(
        /^[0-9a-f]{64}  OpenCodex-2\.61\.0-macos\.app\.tar\.gz\n$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renames desktop bundles and writes checksums", () => {
    const root = temporaryDirectory();
    try {
      const bundle = join(
        root,
        "desktop",
        "src-tauri",
        "target",
        "x86_64-pc-windows-msvc",
        "release",
        "bundle",
        "msi",
      );
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "OpenCodex_2.61.0_x64_en-US.msi"), "bundle");
      writeFileSync(join(bundle, "OpenCodex_2.61.0_x64_en-US.msi.sig"), "signed");

      const out = join(root, "release");
      const files = collectReleaseAssets({
        version: "2.61.0",
        target: "x86_64-pc-windows-msvc",
        out,
        repoRoot: root,
      });

      expect(files.map(path => path.split("/").at(-1))).toEqual([
        "OpenCodex-2.61.0-windows-x64.msi",
        "OpenCodex-2.61.0-windows-x64.msi.sig",
        "OpenCodex-2.61.0-windows-x64.msi.sha256",
      ]);
      expect(readFileSync(join(out, "OpenCodex-2.61.0-windows-x64.msi.sha256"), "utf8")).toMatch(
        /^[0-9a-f]{64}  OpenCodex-2\.61\.0-windows-x64\.msi\n$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects ambiguous bundle matches", () => {
    const root = temporaryDirectory();
    try {
      const bundleRoot = join(
        root,
        "desktop",
        "src-tauri",
        "target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
      );
      const dmg = join(bundleRoot, "dmg");
      const macos = join(bundleRoot, "macos");
      mkdirSync(dmg, { recursive: true });
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(dmg, "OpenCodex_2.61.0_aarch64.dmg"), "dmg");
      writeFileSync(join(dmg, "OpenCodex_2.61.0_universal.dmg"), "dmg");
      writeFileSync(join(macos, "OpenCodex.app.tar.gz"), "archive");

      expect(() =>
        collectReleaseAssets({
          version: "2.61.0",
          target: "aarch64-apple-darwin",
          out: join(root, "release"),
          repoRoot: root,
        }),
      ).toThrow(/Multiple dmg bundles found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generates signed updater platforms and skips missing signatures", () => {
    const root = temporaryDirectory();
    try {
      writeFileSync(join(root, "OpenCodex-2.61.0-macos.app.tar.gz.sig"), "mac-signature\n");
      writeFileSync(join(root, "OpenCodex-2.61.0-windows-x64.msi.sig"), "win-signature\n");
      writeFileSync(join(root, "OpenCodex-2.61.0-linux-x86_64.AppImage.sig"), "appimage-signature\n");
      const warnings: string[] = [];
      const manifest = buildUpdaterManifest({
        version: "2.61.0",
        dir: root,
        repo: "lidge-jun/opencodex",
        out: join(root, "latest.json"),
        warn: message => warnings.push(message),
      });

      expect(manifest.platforms).toEqual({
        "darwin-aarch64": {
          signature: "mac-signature",
          url: "https://github.com/lidge-jun/opencodex/releases/download/v2.61.0/OpenCodex-2.61.0-macos.app.tar.gz",
        },
        "darwin-x86_64": {
          signature: "mac-signature",
          url: "https://github.com/lidge-jun/opencodex/releases/download/v2.61.0/OpenCodex-2.61.0-macos.app.tar.gz",
        },
        "windows-x86_64": {
          signature: "win-signature",
          url: "https://github.com/lidge-jun/opencodex/releases/download/v2.61.0/OpenCodex-2.61.0-windows-x64.msi",
        },
        // The AppImage keeps the plugin's default Linux key so already-released AppImage
        // installs keep resolving their updates; deb installs select the explicit key.
        "linux-x86_64": {
          signature: "appimage-signature",
          url: "https://github.com/lidge-jun/opencodex/releases/download/v2.61.0/OpenCodex-2.61.0-linux-x86_64.AppImage",
        },
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("linux-x86_64-deb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not write a manifest when no signed updater platforms remain", () => {
    const root = temporaryDirectory();
    try {
      const out = join(root, "latest.json");
      expect(() =>
        writeUpdaterManifest({
          version: "2.61.0",
          dir: root,
          repo: "lidge-jun/opencodex",
          out,
        }),
      ).toThrow("No signed updater platforms");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires every updater platform signature when requested", () => {
    const root = temporaryDirectory();
    try {
      writeFileSync(join(root, "OpenCodex-2.61.0-macos.app.tar.gz.sig"), "mac-signature\n");
      writeFileSync(join(root, "OpenCodex-2.61.0-windows-x64.msi.sig"), "win-signature\n");
      writeFileSync(join(root, "OpenCodex-2.61.0-linux-x86_64.AppImage.sig"), "appimage-signature\n");

      expect(() =>
        buildUpdaterManifest({
          version: "2.61.0",
          dir: root,
          repo: "lidge-jun/opencodex",
          out: join(root, "latest.json"),
          requireAll: true,
        }),
      ).toThrow("Missing signed updater platforms: linux-x86_64-deb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The widget extension is the one piece of the macOS app that the Tauri bundler copies but
 * never signs: `copy_custom_files_to_bundle` places `macOS.files` into the bundle and does not
 * add them to `sign_paths`, so whatever signature `build-widget.sh` leaves is the signature
 * that ships. That signature was ad-hoc, because the release step that builds the widget
 * carried no signing environment at all while the very next step did. macOS does not register
 * an extension signed that way, so the app would have installed with no widget and nothing in
 * the build would have said so.
 */
describe("the desktop build toolchain carries the bundle-type marker", () => {
  // updater.rs selects the deb updater target from tauri_utils::platform::bundle_type(),
  // which reads a marker the tauri-bundler patches into the binary at packaging time.
  // Bundlers before 2.5.0 (tauri-cli < 2.7.0) never patch: every packaged artifact then
  // reports "unknown" and a deb install would resolve the AppImage payload it cannot
  // apply. Verified statically at tag tauri-cli-v2.11.1: crates/tauri-bundler/src/
  // bundle.rs maps Deb and AppImage to their marker values, patches per package type,
  // signs after patching, and restores the unpatched binary between formats.
  const minimumCliWithBundlePatch = { major: 2, minor: 7 };

  test("the pinned Tauri CLI is new enough to patch the bundle type into each Linux artifact", () => {
    const manifest = JSON.parse(readFileSync(repoPath("desktop", "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const version = manifest.devDependencies?.["@tauri-apps/cli"];
    expect(version).toBeDefined();
    const [major, minor] = version!.split(".").map(Number);
    expect(
      major! > minimumCliWithBundlePatch.major
        || (major === minimumCliWithBundlePatch.major && minor! >= minimumCliWithBundlePatch.minor),
    ).toBe(true);
  });
});

describe("widget extension signing", () => {
  const script = readFileSync(repoPath("desktop", "scripts", "build-widget.sh"), "utf8");
  const workflow = Bun.YAML.parse(
    readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8"),
  ) as {
    jobs?: Record<string, {
      env?: Record<string, string>;
      steps?: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }>;
    }>;
  };
  const steps = workflow.jobs?.["package-desktop"]?.steps ?? [];
  const indexOfStep = (name: string) => steps.findIndex(step => step.name === name);
  // Located by what a step does, not by what it is called. The first version of this file keyed
  // on step names, and #5339 renamed the certificate import while this branch was open: the
  // rename survived the merge, the assertion did not, and `dev` went red on a test whose subject
  // was still correct.
  const indexOfStepRunning = (fragment: string) =>
    steps.findIndex(step => typeof step.run === "string" && step.run.includes(fragment));

  test("the release build hands the widget a signing identity and forbids an ad-hoc fallback", () => {
    const build = steps.find(step => step.name === "Build WidgetKit extension");
    expect(build).toBeDefined();
    expect(build?.env?.MACOS_SIGN_IDENTITY).toContain("APPLE_SIGNING_IDENTITY");
    expect(build?.env?.WIDGET_SIGN_REQUIRED).toContain("DESKTOP_SIGNING_CONFIGURED");
    expect(workflow.jobs?.["package-desktop"]?.env?.DESKTOP_SIGNING_CONFIGURED)
      .toContain("APPLE_CERTIFICATE");
  });

  test("the certificate is importable before the widget is signed and is removed afterwards", () => {
    // codesign resolves an identity through the keychain search list, and Tauri does not build
    // its own keychain until the bundling step, which is after this one.
    const importStep = indexOfStepRunning("security create-keychain");
    const buildStep = indexOfStep("Build WidgetKit extension");
    expect(importStep).toBeGreaterThanOrEqual(0);
    expect(buildStep).toBeGreaterThan(importStep);

    const cleanup = steps[indexOfStepRunning("security delete-keychain")];
    expect(cleanup?.if).toContain("always()");
    // The decoded p12 must not outlive the import, including when a later command fails.
    expect(steps[importStep]?.run).toContain("trap ");
    expect(steps[importStep]?.run).toContain("$certificate");
  });

  test("the script selects binaries by Mach-O magic bytes rather than by name", () => {
    // A suffix filter is what let an unsigned helper through on a sibling project: neither
    // `spawn-helper` nor `macos-trash` has an extension to match, and the submission came back
    // rejected with the containing bundle looking correctly signed.
    expect(script).toContain('file -b "$candidate"');
    expect(script).toContain('*"Mach-O"*');
    expect(script).not.toMatch(/-name\s+['"]\*\.(dylib|node|so)['"]/);
  });

  test("every signature carries the hardened runtime and the build proves it afterwards", () => {
    // Notarization rejects any Mach-O in the bundle without it, and the widget's was omitted.
    expect(script).toContain("--options runtime");
    expect(script).toContain("codesign --verify --deep --strict");
    expect(script).toContain('*"flags="*"runtime"*)');
    // Captured, not piped: under `pipefail` a matcher that exits on its first hit kills codesign
    // with SIGPIPE, and the assertion then fails on the signatures it was written to accept.
    expect(script).toContain('signature_display="$(codesign --display');
  });

  test("a run holding Developer ID material refuses to fall back to an ad-hoc widget", () => {
    expect(script).toContain('elif [[ "${WIDGET_SIGN_REQUIRED:-0}" == "1" ]]; then');
    expect(script).toContain("refusing to ad-hoc sign a release widget");
    // The refusal is resolved before the Swift build so a misconfigured release fails fast.
    expect(script.indexOf("refusing to ad-hoc sign a release widget"))
      .toBeLessThan(script.indexOf("swift build"));
  });
});
