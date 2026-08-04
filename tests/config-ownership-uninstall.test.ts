import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
  removeOwnedConfigState,
} from "../src/lib/config-ownership";
import { getDefaultConfig, saveConfig } from "../src/config";

describe("owned config uninstall", () => {
  test("first owned write creates a missing config root and its metadata", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-owned-path-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "usage.jsonl"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses a legacy config directory without ownership metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-legacy-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"keep":true}\n');

    try {
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("ownership");
      expect(readFileSync(configPath, "utf8")).toBe('{"keep":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes manifest-owned state and the empty config directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-owned-"));
    const configPath = join(dir, "config.json");

    try {
      expect(recordOwnedConfigPath(dir, configPath)).toBe(true);
      writeFileSync(configPath, '{"owned":true}\n');

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves unowned files and reports a partial uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-shared-"));
    const ownedPath = join(dir, "config.json");
    const foreignPath = join(dir, "personal.txt");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(foreignPath, "keep me\n");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([foreignPath]);
      expect(existsSync(ownedPath)).toBe(false);
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recursively removes a manifest-owned state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-tree-"));
    const artifacts = join(dir, "artifacts");

    try {
      expect(recordOwnedConfigPath(dir, artifacts)).toBe(true);
      mkdirSync(join(artifacts, "nested"), { recursive: true });
      writeFileSync(join(artifacts, "nested", "image.bin"), "owned");

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unlinks an owned directory link without traversing its external target", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-link-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const linkedArtifacts = join(dir, "artifacts");
    mkdirSync(dir);
    mkdirSync(external);
    writeFileSync(join(external, "keep.bin"), "external");

    try {
      expect(recordOwnedConfigPath(dir, linkedArtifacts)).toBe(true);
      symlinkSync(external, linkedArtifacts, process.platform === "win32" ? "junction" : "dir");

      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(readFileSync(join(external, "keep.bin"), "utf8")).toBe("external");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a manifest path that escapes the config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-traversal-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const external = join(parent, "keep.txt");
    mkdirSync(dir);
    writeFileSync(external, "external");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      const manifestPath = join(dir, CONFIG_UNINSTALL_MANIFEST);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
      manifest.paths = ["../keep.txt"];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(external, "utf8")).toBe("external");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects linked ownership metadata without deleting owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-linked-metadata-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const ownedPath = join(dir, "config.json");
    mkdirSync(dir);
    mkdirSync(external);

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      rmSync(join(dir, CONFIG_UNINSTALL_MANIFEST));
      symlinkSync(
        external,
        join(dir, CONFIG_UNINSTALL_MANIFEST),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a fresh config save creates ownership metadata and records config.json", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-write-"));
    const dir = join(parent, "config");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toContain("config.json");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an existing nonempty config directory is not retroactively claimed", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-legacy-write-"));
    const dir = join(parent, "config");
    const foreignPath = join(dir, "personal.txt");
    mkdirSync(dir);
    writeFileSync(foreignPath, "keep me\n");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
