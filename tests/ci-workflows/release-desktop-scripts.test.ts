import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleaseAssets } from "../../desktop/scripts/collect-release-assets";
import { buildUpdaterManifest, writeUpdaterManifest } from "../../desktop/scripts/updater-manifest";

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
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("linux-x86_64");
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

      expect(() =>
        buildUpdaterManifest({
          version: "2.61.0",
          dir: root,
          repo: "lidge-jun/opencodex",
          out: join(root, "latest.json"),
          requireAll: true,
        }),
      ).toThrow("Missing signed updater platforms: linux-x86_64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
