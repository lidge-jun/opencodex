import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import type {
  CatalogConditionalSourceObservations,
  CatalogConditionalSourceRole,
  CatalogRequiredSourceObservations,
  CatalogRequiredSourceRole,
  CatalogSourceEvidence,
} from "../src/codex/convergence-types";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const CONDITIONAL_SOURCE_ROLES = [
  "active-catalog-merge",
  "bundled-catalog-template",
  "hashed-backup-fallback",
  "legacy-backup-fallback",
  "models-cache-fallback",
  "native-catalog-selection",
  "provider-auth-selection",
  "runtime-selection",
] as const satisfies readonly CatalogConditionalSourceRole[];

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type MissingRequiredEvidence = Omit<CatalogSourceEvidence, "required"> & Readonly<{
  required: Omit<CatalogRequiredSourceObservations, CatalogRequiredSourceRole>;
}>;
type MissingConditionalEvidence = Omit<CatalogSourceEvidence, "conditional"> & Readonly<{
  conditional: Omit<CatalogConditionalSourceObservations, "runtime-selection">;
}>;
type MissingHomeEvidence = Omit<CatalogSourceEvidence, "homeSelection">;

const STRUCTURALLY_INVALID_EVIDENCE_ASSIGNABILITY: readonly [
  IsAssignable<MissingRequiredEvidence, CatalogSourceEvidence>,
  IsAssignable<MissingConditionalEvidence, CatalogSourceEvidence>,
  IsAssignable<MissingHomeEvidence, CatalogSourceEvidence>,
] = [false, false, false];

let testRoot = "";
let codexHome = "";
let opencodexHome = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-admission-")));
  codexHome = join(testRoot, "codex-home");
  opencodexHome = join(testRoot, "opencodex-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

test("captures the given config reference, generation, and catalog target identities", () => {
  saveConfig(config(20200));
  const residentConfig = config(30300);
  writeFileSync(join(codexHome, "opencodex-catalog.json"), "{}\n");
  writeFileSync(join(codexHome, "models_cache.json"), "{}\n");

  const snapshot = captureCatalogAdmissionSnapshot(residentConfig);

  expect(snapshot.config).toBe(residentConfig);
  expect(snapshot.config.port).toBe(30300);
  expect(snapshot.generation).toEqual({ value: 1 });
  expect(snapshot.configIdentity).toEqual({
    referenceIdentity: expect.any(String),
    generation: { value: 1 },
    snapshotIdentity: expect.any(String),
  });
  expect(JSON.parse(snapshot.targets.catalog)).toMatchObject({
    path: join(codexHome, "opencodex-catalog.json"),
    canonicalParent: codexHome,
    parentIdentity: { device: expect.any(String), inode: expect.any(String) },
    fileIdentity: { device: expect.any(String), inode: expect.any(String) },
  });
  expect(JSON.parse(snapshot.targets.cache)).toMatchObject({
    path: join(codexHome, "models_cache.json"),
    canonicalParent: codexHome,
    fileIdentity: { device: expect.any(String), inode: expect.any(String) },
  });
  expect(snapshot.targets.catalogBackups).toHaveLength(2);

  expect(snapshot.sourceEvidence.required["catalog-target-selection"]).toEqual({
    state: "absent",
    role: "catalog-target-selection",
    logicalPath: join(codexHome, "config.toml"),
    canonicalPath: join(codexHome, "config.toml"),
    parentIdentity: {
      canonicalPath: codexHome,
      volume: expect.any(String),
      fileId: expect.any(String),
    },
    fileIdentity: null,
  });
  expect(snapshot.sourceEvidence.homeSelection).toEqual({
    selector: { kind: "environment", raw: codexHome },
    canonicalCodexHome: codexHome,
    rootIdentity: { volume: expect.any(String), fileId: expect.any(String) },
  });
  expect(Object.keys(snapshot.sourceEvidence.conditional).sort()).toEqual(CONDITIONAL_SOURCE_ROLES);
  for (const observations of Object.values(snapshot.sourceEvidence.conditional)) {
    expect(observations).toEqual([]);
  }
});

test("captures PRESENT catalog target-selection evidence from the exact config bytes", () => {
  saveConfig(config());
  const selectedCatalog = join(codexHome, "selected-catalog.json");
  const configBytes = Buffer.from(
    `model_catalog_json = ${JSON.stringify(selectedCatalog)}\n`,
    "utf8",
  );
  writeFileSync(join(codexHome, "config.toml"), configBytes);

  const snapshot = captureCatalogAdmissionSnapshot(config());
  const observation = snapshot.sourceEvidence.required["catalog-target-selection"];

  expect(JSON.parse(snapshot.targets.catalog)).toMatchObject({ path: selectedCatalog });
  if (observation.state !== "present") {
    throw new Error(`Expected PRESENT target-selection evidence, received ${observation.state}.`);
  }
  expect(observation).toEqual({
    state: "present",
    role: "catalog-target-selection",
    logicalPath: join(codexHome, "config.toml"),
    canonicalPath: join(codexHome, "config.toml"),
    parentIdentity: {
      canonicalPath: codexHome,
      volume: expect.any(String),
      fileId: expect.any(String),
    },
    fileIdentity: {
      volume: expect.any(String),
      fileId: expect.any(String),
    },
    sha256: createHash("sha256").update(configBytes).digest("hex"),
  });
});

test("binds opaque config identity to the exact reference, generation, and snapshot", () => {
  saveConfig(config());
  const firstConfig = config(20200);
  const equalButDistinctConfig = config(20200);

  const first = captureCatalogAdmissionSnapshot(firstConfig).configIdentity;
  const sameReference = captureCatalogAdmissionSnapshot(firstConfig).configIdentity;
  const distinctReference = captureCatalogAdmissionSnapshot(equalButDistinctConfig).configIdentity;
  firstConfig.port = 30300;
  const mutated = captureCatalogAdmissionSnapshot(firstConfig).configIdentity;

  expect(sameReference).toEqual(first);
  expect(distinctReference.referenceIdentity).not.toBe(first.referenceIdentity);
  expect(distinctReference.snapshotIdentity).toBe(first.snapshotIdentity);
  expect(mutated.referenceIdentity).toBe(first.referenceIdentity);
  expect(mutated.snapshotIdentity).not.toBe(first.snapshotIdentity);
  expect(mutated.generation).toEqual(first.generation);
});

test("ignores process-local symbol tags when binding the config snapshot identity", () => {
  saveConfig(config());
  const plainIdentity = captureCatalogAdmissionSnapshot(config(20200)).configIdentity;

  const tagged = config(20200);
  Object.defineProperty(tagged, Symbol("opencodex.user-cost-overlay-preservation-owner"), {
    value: { refs: 1, config: tagged, ownedProviders: Object.keys(tagged.providers ?? {}) },
    enumerable: true,
    configurable: true,
  });
  const taggedIdentity = captureCatalogAdmissionSnapshot(tagged).configIdentity;

  // The tag is process-local metadata: JSON.stringify omits it and no persist
  // path writes it, so it must not change the durable snapshot identity. The
  // reference identity stays per-object, matching the untagged contract.
  expect(taggedIdentity.snapshotIdentity).toBe(plainIdentity.snapshotIdentity);
  expect(taggedIdentity.referenceIdentity).not.toBe(plainIdentity.referenceIdentity);
});

test("rejects missing home, required, and conditional evidence keys structurally", () => {
  expect(STRUCTURALLY_INVALID_EVIDENCE_ASSIGNABILITY).toEqual([false, false, false]);
});

test("changes target identity when a parent symlink retargets without changing the path", () => {
  saveConfig(config());
  const parentA = join(testRoot, "catalog-parent-a");
  const parentB = join(testRoot, "catalog-parent-b");
  const linkedParent = join(testRoot, "catalog-parent");
  mkdirSync(parentA);
  mkdirSync(parentB);
  symlinkSync(parentA, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const textualCatalogPath = join(linkedParent, "catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(textualCatalogPath)}\n`,
  );

  const before = JSON.parse(captureCatalogAdmissionSnapshot(config()).targets.catalog);
  if (process.platform === "win32") removeTreeWithRetry(linkedParent);
  else unlinkSync(linkedParent);
  symlinkSync(parentB, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const after = JSON.parse(captureCatalogAdmissionSnapshot(config()).targets.catalog);

  expect(before.path).toBe(textualCatalogPath);
  expect(after.path).toBe(textualCatalogPath);
  expect(before.canonicalParent).not.toBe(after.canonicalParent);
  expect(before.parentIdentity).not.toEqual(after.parentIdentity);
});
