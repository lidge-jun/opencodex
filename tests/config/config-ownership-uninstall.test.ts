import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
  removeOwnedConfigState,
} from "../../src/lib/config-ownership";
import { writePristineCatalogBackup } from "../../src/codex/catalog/parsing";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function manifestPaths(dir: string): string[] {
  return (JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] }).paths;
}

describe("owned config uninstall", () => {
  test("first owned write creates a missing config root and its metadata", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-owned-path-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "usage.jsonl"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(parent);
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
      removeTreeWithRetry(parent);
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
      removeTreeWithRetry(parent);
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
      removeTreeWithRetry(parent);
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
      removeTreeWithRetry(parent);
    }
  });

  test("uninstall removes recorded admin tokens and per-home catalog backups", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-self-written-"));
    const dir = join(parent, "config");

    try {
      // Establish ownership the way production does: the first owned write into an empty dir.
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "{}\n");
      writeFileSync(join(dir, "admin-api-token"), "token\n");
      const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
      expect(recordOwnedConfigPath(dir, backupPath)).toBe(true);
      writeFileSync(backupPath, "{}\n");

      const result = removeOwnedConfigState(dir);
      expect(result).toMatchObject({ status: "removed" });
      expect(existsSync(dir)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("an unrecorded matching catalog backup name is never removed", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-lookalike-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      const foreign = join(dir, "catalog-backup-0123456789abcdef.json");
      mkdirSync(foreign);
      const nested = join(foreign, "mine.txt");
      writeFileSync(nested, "mine\n");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(readFileSync(nested, "utf8")).toBe("mine\n");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("writePristineCatalogBackup records a backup it writes itself", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-write-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      mkdirSync(dir, { recursive: true });
      // Ownership is claimed by the first owned write into an empty dir, as in production.
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');

      writePristineCatalogBackup(backupPath, catalogPath, { models: [] });

      expect(readFileSync(backupPath, "utf8")).toBe('{"models":[]}\n');
      expect(manifestPaths(dir)).toContain("catalog-backup-0123456789abcdef.json");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  for (const existing of ['{"models":[{"slug":"user-owned"}]}\n', '{"models":[]}\n']) {
    test(`writePristineCatalogBackup does not adopt an existing regular backup: ${existing.trim()}`, () => {
      const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-existing-"));
      const dir = join(parent, "config");
      const catalogPath = join(parent, "models.json");
      const name = "catalog-backup-0123456789abcdef.json";
      const backupPath = join(dir, name);
      const previous = process.env.OPENCODEX_HOME;
      process.env.OPENCODEX_HOME = dir;
      try {
        expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
        writeFileSync(catalogPath, '{"models":[]}\n');
        writeFileSync(backupPath, existing);
        const before = manifestPaths(dir);
        writePristineCatalogBackup(backupPath, catalogPath, { models: [] });
        expect(manifestPaths(dir)).toEqual(before);
        expect(manifestPaths(dir)).not.toContain(name);
        const result = removeOwnedConfigState(dir);
        expect(result.status).toBe("partial");
        expect(result.residualPaths).toEqual([backupPath]);
        expect(readFileSync(backupPath, "utf8")).toBe(existing);
      } finally {
        if (previous === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previous;
        removeTreeWithRetry(parent);
      }
    });
  }

  test("serialized pristine fallback records only the newly written backup", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-fallback-"));
    const dir = join(parent, "config");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [] });
      expect(JSON.parse(readFileSync(backupPath, "utf8"))).toEqual({ models: [] });
      expect(manifestPaths(dir)).toContain("catalog-backup-0123456789abcdef.json");
      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("a routed-only catalog creates neither a backup nor an ownership entry", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-routed-"));
    const dir = join(parent, "config");
    const name = "catalog-backup-0123456789abcdef.json";
    const backupPath = join(dir, name);
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [{ slug: "provider/model" }] });
      expect(existsSync(backupPath)).toBe(false);
      expect(manifestPaths(dir)).toEqual(before);
      expect(manifestPaths(dir)).not.toContain(name);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("failed pristine copying does not register an unwritten backup", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-failure-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "missing", "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');
      const before = manifestPaths(dir);
      expect(() => writePristineCatalogBackup(backupPath, catalogPath, { models: [] })).toThrow();
      expect(existsSync(backupPath)).toBe(false);
      expect(manifestPaths(dir)).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("preserving an already recorded pristine backup keeps its original ownership", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-owned-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');
      writePristineCatalogBackup(backupPath, catalogPath, { models: [] });
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, catalogPath, { models: [{ slug: "other" }] });
      expect(manifestPaths(dir)).toEqual(before);
      expect(readFileSync(backupPath, "utf8")).toBe('{"models":[]}\n');
      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("an existing matching backup directory stays unclaimed after the writer visits it", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-directory-"));
    const dir = join(parent, "config");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      mkdirSync(backupPath);
      const nested = join(backupPath, "mine.txt");
      writeFileSync(nested, "keep me\n");
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [] });
      expect(manifestPaths(dir)).toEqual(before);
      expect(removeOwnedConfigState(dir).residualPaths).toEqual([backupPath]);
      expect(readFileSync(nested, "utf8")).toBe("keep me\n");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });
});
