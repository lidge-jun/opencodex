import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { labInstallationSaltPath } from "../src/lab/paths";
import {
  INSTALLATION_SALT_CACHE_MAX_ENTRIES,
  installationSaltCache,
  readExistingInstallationSalt,
} from "../src/lab/subject/installation-salt";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

function saltFixture(value: number): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-lab-salt-cache-"));
  roots.push(root);
  const path = labInstallationSaltPath(root);
  mkdirSync(join(root, "lab"), { recursive: true });
  writeFileSync(path, new Uint8Array(32).fill(value));
  return root;
}

beforeEach(() => {
  installationSaltCache.clear();
});

afterEach(() => {
  installationSaltCache.clear();
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Lab installation salt cache", () => {
  test("an evicted salt is re-read from disk", () => {
    const firstRoot = saltFixture(1);
    expect(readExistingInstallationSalt(firstRoot)).toEqual(new Uint8Array(32).fill(1));
    for (let index = 1; index <= INSTALLATION_SALT_CACHE_MAX_ENTRIES; index += 1) {
      readExistingInstallationSalt(saltFixture(index + 1));
    }

    writeFileSync(labInstallationSaltPath(firstRoot), new Uint8Array(32).fill(255));

    expect(readExistingInstallationSalt(firstRoot)).toEqual(new Uint8Array(32).fill(255));
  });

  test("cache never exceeds its entry cap", () => {
    for (let index = 0; index < INSTALLATION_SALT_CACHE_MAX_ENTRIES * 2; index += 1) {
      readExistingInstallationSalt(saltFixture(index));
      expect(installationSaltCache.size).toBeLessThanOrEqual(INSTALLATION_SALT_CACHE_MAX_ENTRIES);
    }
  });
});
