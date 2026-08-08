import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import {
  resetBundledCatalogCacheForTests,
  resolveCatalogSourceForGather,
} from "../src/codex/catalog/bundled";
import {
  acceptCatalogGatherSourcePath,
  captureAndSealCatalogHomeSelection,
  captureCatalogGatherTargetIdentity,
  createCatalogGatherEvidenceSession,
  readCatalogGatherSource,
  sealCatalogGatherEvidenceSession,
  type CatalogGatherProviderAuthEvidence,
} from "../src/codex/catalog/filesystem-evidence";
import type { CatalogSourceEvidence } from "../src/codex/convergence-types";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

interface ManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly mtimeNs: string;
  readonly inode: string;
  readonly device: string;
  readonly size: string;
  readonly sha256?: string;
  readonly linkTarget?: string;
}

let testRoot = "";
let codexHome = "";
let opencodexHome = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai" };
}

function recursiveManifest(root: string): readonly ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const kind = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      path: relativePath,
      kind,
      mode: Number(stat.mode),
      mtimeNs: String(stat.mtimeNs),
      inode: String(stat.ino),
      device: String(stat.dev),
      size: String(stat.size),
      ...(kind === "file"
        ? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
        : {}),
      ...(kind === "symlink" ? { linkTarget: readlinkSync(path) } : {}),
    });
    if (kind !== "directory") return;
    for (const child of readdirSync(path).sort()) {
      visit(join(path, child), relativePath === "." ? child : join(relativePath, child));
    }
  };
  visit(root, ".");
  return entries;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-filesystem-evidence-")));
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
  rmSync(testRoot, { recursive: true, force: true });
});

test("source reads record PRESENT and ABSENT before returning their result", () => {
  const presentPath = join(codexHome, "present.json");
  const absentPath = join(codexHome, "absent.json");
  const presentBytes = Buffer.from("present bytes\n");
  writeFileSync(presentPath, presentBytes);

  const session = createCatalogGatherEvidenceSession();
  captureAndSealCatalogHomeSelection(session);
  acceptCatalogGatherSourcePath(session, "catalog-target-selection", join(codexHome, "config.toml"));
  expect(readCatalogGatherSource(session, "catalog-target-selection")).toBeNull();
  acceptCatalogGatherSourcePath(session, "active-catalog-merge", presentPath);
  expect(readCatalogGatherSource(session, "active-catalog-merge")).toEqual(Uint8Array.from(presentBytes));
  acceptCatalogGatherSourcePath(session, "models-cache-fallback", absentPath);
  expect(readCatalogGatherSource(session, "models-cache-fallback")).toBeNull();

  const evidence = sealCatalogGatherEvidenceSession(session);
  expect(evidence.conditional["active-catalog-merge"]).toEqual([{
    state: "present",
    role: "active-catalog-merge",
    logicalPath: presentPath,
    canonicalPath: presentPath,
    parentIdentity: {
      canonicalPath: codexHome,
      volume: expect.any(String),
      fileId: expect.any(String),
    },
    fileIdentity: { volume: expect.any(String), fileId: expect.any(String) },
    sha256: createHash("sha256").update(presentBytes).digest("hex"),
  }]);
  expect(evidence.conditional["models-cache-fallback"]).toEqual([{
    state: "absent",
    role: "models-cache-fallback",
    logicalPath: absentPath,
    canonicalPath: absentPath,
    parentIdentity: {
      canonicalPath: codexHome,
      volume: expect.any(String),
      fileId: expect.any(String),
    },
    fileIdentity: null,
  }]);
});

test("refuses sealing without the required catalog-target-selection observation", () => {
  const session = createCatalogGatherEvidenceSession();
  captureAndSealCatalogHomeSelection(session);
  expect(() => sealCatalogGatherEvidenceSession(session)).toThrow("catalog-target-selection");
});

test("sealed evidence is detached and recursively immutable", () => {
  const session = createCatalogGatherEvidenceSession();
  captureAndSealCatalogHomeSelection(session);
  acceptCatalogGatherSourcePath(session, "catalog-target-selection", join(codexHome, "config.toml"));
  readCatalogGatherSource(session, "catalog-target-selection");
  acceptCatalogGatherSourcePath(session, "active-catalog-merge", join(codexHome, "missing.json"));
  readCatalogGatherSource(session, "active-catalog-merge");
  const evidence = sealCatalogGatherEvidenceSession(session);

  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.conditional)).toBe(true);
  expect(Object.isFrozen(evidence.conditional["active-catalog-merge"])).toBe(true);
  expect(() => {
    (evidence.conditional["active-catalog-merge"] as CatalogSourceEvidence["conditional"]["active-catalog-merge"] & unknown[])
      .push(evidence.conditional["active-catalog-merge"][0]!);
  }).toThrow();
  expect(() => {
    (evidence.required["catalog-target-selection"].parentIdentity as { canonicalPath: string }).canonicalPath = "mutated";
  }).toThrow();
  expect(evidence.conditional["active-catalog-merge"]).toHaveLength(1);
  expect(evidence.required["catalog-target-selection"].parentIdentity.canonicalPath).toBe(codexHome);
});

test("refuses a derived path before catalog-home selection is sealed", () => {
  const session = createCatalogGatherEvidenceSession();
  expect(() => acceptCatalogGatherSourcePath(
    session,
    "catalog-target-selection",
    join(codexHome, "config.toml"),
  )).toThrow("before accepting a derived path");
  expect(() => captureCatalogGatherTargetIdentity(session, join(codexHome, "catalog.json")))
    .toThrow("before accepting a derived path");
});

test("admission observation does not create missing generation storage", () => {
  const before = recursiveManifest(testRoot);
  expect(() => captureCatalogAdmissionSnapshot(config())).toThrow("generation is database");
  expect(recursiveManifest(testRoot)).toEqual(before);
});

test("populated and scratch gather sessions perform zero filesystem writes", () => {
  saveConfig(config());
  const configPath = join(codexHome, "config.toml");
  const activePath = join(codexHome, "active.json");
  const authPath = join(opencodexHome, "oauth.json");
  writeFileSync(configPath, "model_catalog_json = \"active.json\"\n");
  writeFileSync(activePath, JSON.stringify({
    models: [{ slug: "gpt-5.5", base_instructions: "observed" }],
  }));
  writeFileSync(authPath, "{}\n");
  const beforePopulated = recursiveManifest(testRoot);

  resetBundledCatalogCacheForTests();
  const populated = createCatalogGatherEvidenceSession();
  captureAndSealCatalogHomeSelection(populated);
  acceptCatalogGatherSourcePath(populated, "catalog-target-selection", configPath);
  readCatalogGatherSource(populated, "catalog-target-selection");
  acceptCatalogGatherSourcePath(populated, "active-catalog-merge", activePath);
  expect(resolveCatalogSourceForGather(populated, "custom").kind).toBe("available");
  acceptCatalogGatherSourcePath(populated, "models-cache-fallback", join(codexHome, "missing-cache.json"));
  populated.readSource("models-cache-fallback");
  acceptCatalogGatherSourcePath(populated, "provider-auth-selection", authPath);
  const providerEvidence: CatalogGatherProviderAuthEvidence = populated;
  expect(providerEvidence.authStoreBuffer).toEqual(Uint8Array.from(readFileSync(authPath)));
  captureCatalogGatherTargetIdentity(populated, activePath);
  sealCatalogGatherEvidenceSession(populated);
  expect(recursiveManifest(testRoot)).toEqual(beforePopulated);

  const scratchHome = join(testRoot, "scratch-home");
  mkdirSync(scratchHome);
  process.env.CODEX_HOME = scratchHome;
  const beforeScratch = recursiveManifest(testRoot);
  const scratch = createCatalogGatherEvidenceSession();
  captureAndSealCatalogHomeSelection(scratch);
  acceptCatalogGatherSourcePath(scratch, "catalog-target-selection", join(scratchHome, "config.toml"));
  readCatalogGatherSource(scratch, "catalog-target-selection");
  sealCatalogGatherEvidenceSession(scratch);
  expect(recursiveManifest(testRoot)).toEqual(beforeScratch);

  process.env.CODEX_HOME = join(testRoot, "absent-home");
  const beforeAbsent = recursiveManifest(testRoot);
  expect(() => captureAndSealCatalogHomeSelection(createCatalogGatherEvidenceSession())).toThrow();
  expect(recursiveManifest(testRoot)).toEqual(beforeAbsent);
});
