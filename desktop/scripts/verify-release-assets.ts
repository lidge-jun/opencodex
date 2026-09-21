/**
 * Pre-publication release asset verification.
 *
 * Everything a release will publish is checked here, in the verify-release job,
 * before any publication step may run: the expected platform file set derived from
 * the workflow's own packaging matrices and the producer scripts' tables, every
 * recorded checksum against the bytes on disk, every updater signature
 * cryptographically against the pinned minisign public key, and the updater
 * manifest parsed back against the files it names. The result is a
 * machine-readable receipt; attach-release requires the receipt to name the same
 * version and commit before it uploads anything, so publication can only ever
 * consume the verified bundle.
 */
import { createHash, createPublicKey, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  standaloneArchiveName,
  standaloneTargets as sharedStandaloneTargets,
} from "../../scripts/standalone-targets";
import { bundlesByTarget } from "./collect-release-assets";
import { platformFiles, writeUpdaterManifest, type UpdaterManifest } from "./updater-manifest";

export interface VerifyReleaseAssetsOptions {
  version: string;
  dir: string;
  repo: string;
  sha: string;
  repoRoot?: string;
  manifestOut?: string;
  receiptOut?: string;
  requireSignatures?: boolean;
}

export interface ReleaseVerificationReceipt {
  version: string;
  repo: string;
  sha: string;
  expectedFiles: number;
  checksumsVerified: number;
  signaturesVerified: number;
  manifestPlatforms: string[];
}

/**
 * The expected file set, derived from the producer tables rather than restated.
 * Signatures are required only for the assets the updater actually signs — the
 * unique suffixes in platformFiles — because the DMG and the deb are not updater
 * targets and are never signed.
 */
export function expectedReleaseAssets(options: {
  version: string;
  desktopTargets: string[];
  requireSignatures?: boolean;
}): string[] {
  const expected: string[] = [];
  for (const target of sharedStandaloneTargets) {
    const archive = standaloneArchiveName(options.version, target);
    expected.push(archive, `${archive}.sha256`);
  }
  const updaterSuffixes = new Set(Object.values(platformFiles));
  for (const target of options.desktopTargets) {
    const bundles = bundlesByTarget[target];
    if (!bundles) throw new Error(`Unsupported desktop target in release matrix: ${target}`);
    for (const bundle of bundles) {
      const asset = `OpenCodex-${options.version}-${bundle.name}`;
      expected.push(asset, `${asset}.sha256`);
      if (options.requireSignatures && updaterSuffixes.has(bundle.name)) {
        expected.push(`${asset}.sig`);
      }
    }
  }
  return expected;
}

/** The packaging matrices of the release workflow itself — the source of truth for the set. */
export function releaseMatrixTargets(workflowText: string): {
  standaloneTargets: string[];
  desktopTargets: string[];
} {
  const workflow = Bun.YAML.parse(workflowText) as {
    jobs?: Record<string, { strategy?: { matrix?: { include?: Array<{ target?: string }> } } }>;
  };
  const read = (job: string): string[] =>
    (workflow.jobs?.[job]?.strategy?.matrix?.include ?? [])
      .map(entry => entry.target)
      .filter((target): target is string => typeof target === "string");
  const standaloneTargets = read("package-standalone");
  const desktopTargets = read("package-desktop");
  if (standaloneTargets.length === 0 || desktopTargets.length === 0) {
    throw new Error("release.yml packaging matrices are empty or unreadable");
  }
  return { standaloneTargets, desktopTargets };
}

/**
 * Every recorded checksum against the bytes on disk, in exactly the producers'
 * format (64 hex, two spaces, bare name, one trailing newline). The recorded name
 * must equal the checksum file's own name minus the suffix: a foo.sha256 naming
 * bar would leave foo's bytes unchecked while bar's are checked twice.
 */
export function verifyChecksums(dir: string): number {
  const checksumFiles = readdirSync(dir).filter(name => name.endsWith(".sha256")).sort();
  if (checksumFiles.length === 0) throw new Error(`No .sha256 files found in ${dir}`);
  for (const checksumFile of checksumFiles) {
    const content = readFileSync(join(dir, checksumFile), "utf8");
    const match = /^([0-9a-f]{64})  (\S+)\n$/.exec(content);
    if (!match) throw new Error(`Malformed checksum record in ${checksumFile}: ${JSON.stringify(content)}`);
    const digest = match[1]!;
    const recorded = match[2]!;
    const own = checksumFile.slice(0, -".sha256".length);
    if (recorded !== own) {
      throw new Error(`Checksum ${checksumFile} records ${recorded}; it must record its own payload ${own}`);
    }
    const payload = join(dir, recorded);
    if (!existsSync(payload)) throw new Error(`Checksum ${checksumFile} names ${recorded}, which is missing`);
    const actual = createHash("sha256").update(readFileSync(payload)).digest("hex");
    if (actual !== digest) {
      throw new Error(`Checksum mismatch for ${recorded}: recorded ${digest}, computed ${actual}`);
    }
  }
  return checksumFiles.length;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MinisignPublicKey {
  keyId: string;
  publicKey: KeyObject;
}

function minisignPayload(text: string, expectedBytes: number, what: string): Buffer {
  const encoded = text
    .split("\n")
    .filter(line => line.trim().length > 0 && !line.trimStart().startsWith("untrusted comment:"))
    .join("")
    .trim();
  const payload = Buffer.from(encoded, "base64");
  if (payload.length !== expectedBytes) {
    throw new Error(`Malformed ${what}: expected ${expectedBytes} decoded bytes, got ${payload.length}`);
  }
  return payload;
}

/** minisign public key: base64 of algorithm ("Ed") || key id (8) || raw key (32). */
export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const payload = minisignPayload(text, 42, "minisign public key");
  const algorithm = payload.subarray(0, 2).toString("utf8");
  if (algorithm !== "Ed") {
    throw new Error(`Unsupported minisign public key algorithm: ${JSON.stringify(algorithm)}`);
  }
  return {
    keyId: payload.subarray(2, 10).toString("hex"),
    publicKey: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, payload.subarray(10, 42)]),
      format: "der",
      type: "spki",
    }),
  };
}

/** The updater public key pinned in the Tauri configuration. */
export function loadUpdaterPublicKey(tauriConfPath: string): MinisignPublicKey {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8")) as {
    plugins?: { updater?: { pubkey?: string } };
  };
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error(`No plugins.updater.pubkey in ${tauriConfPath}`);
  return parseMinisignPublicKey(Buffer.from(pubkey, "base64").toString("utf8"));
}

/**
 * minisign signature: base64 of algorithm || key id (8) || signature (64).
 * "Ed" is a pure Ed25519 signature over the raw file bytes — the form the Tauri
 * bundler emits. "ED" (BLAKE2b-prehashed) or anything else fails loudly rather
 * than being silently mis-verified.
 */
export function verifyUpdaterSignature(filePath: string, key: MinisignPublicKey): void {
  const signaturePath = `${filePath}.sig`;
  if (!existsSync(signaturePath)) throw new Error(`Missing signature: ${signaturePath}`);
  const payload = minisignPayload(readFileSync(signaturePath, "utf8"), 74, `signature ${signaturePath}`);
  const algorithm = payload.subarray(0, 2).toString("utf8");
  if (algorithm !== "Ed") {
    throw new Error(`Unsupported signature algorithm in ${signaturePath}: ${JSON.stringify(algorithm)}`);
  }
  const keyId = payload.subarray(2, 10).toString("hex");
  if (keyId !== key.keyId) {
    throw new Error(`Signature ${signaturePath} was made by key ${keyId}, not the pinned updater key ${key.keyId}`);
  }
  if (!ed25519Verify(null, readFileSync(filePath), key.publicKey, payload.subarray(10, 74))) {
    throw new Error(`Signature verification failed for ${filePath}`);
  }
}

function parseBackManifest(manifestPath: string, options: VerifyReleaseAssetsOptions): string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UpdaterManifest;
  if (manifest.version !== options.version) {
    throw new Error(`Manifest version ${manifest.version} != ${options.version}`);
  }
  const platforms = Object.keys(manifest.platforms).sort();
  const expectedPlatforms = Object.keys(platformFiles).sort();
  if (JSON.stringify(platforms) !== JSON.stringify(expectedPlatforms)) {
    throw new Error(
      `Manifest platforms (${platforms.join(", ")}) do not match the updater platform set (${expectedPlatforms.join(", ")})`,
    );
  }
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const base = `OpenCodex-${options.version}-${platformFiles[platform]}`;
    const expectedUrl = `https://github.com/${options.repo}/releases/download/v${options.version}/${base}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`Manifest entry ${platform} points at ${entry.url}, expected ${expectedUrl}`);
    }
    if (!existsSync(join(options.dir, base))) {
      throw new Error(`Manifest entry ${platform} names ${base}, which is missing`);
    }
    // The manifest must carry exactly the signature that was just verified,
    // not merely a nonempty string.
    const sidecar = readFileSync(join(options.dir, `${base}.sig`), "utf8").trim();
    if (entry.signature !== sidecar) {
      throw new Error(`Manifest entry ${platform} signature does not match ${base}.sig`);
    }
  }
  return platforms;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function verifyReleaseAssets(options: VerifyReleaseAssetsOptions): ReleaseVerificationReceipt {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, "../.."));
  const dir = resolve(options.dir);
  const { standaloneTargets, desktopTargets } = releaseMatrixTargets(
    readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8"),
  );
  // The workflow matrix must describe exactly the shared target set the builder
  // uses; a target added to one and not the other fails here, not at release time.
  const workflowStandalone = [...standaloneTargets].sort();
  const sharedStandalone = [...sharedStandaloneTargets].sort();
  if (JSON.stringify(workflowStandalone) !== JSON.stringify(sharedStandalone)) {
    throw new Error(
      `release.yml package-standalone matrix (${workflowStandalone.join(", ")})`
        + ` does not match scripts/standalone-targets.ts (${sharedStandalone.join(", ")})`,
    );
  }
  const expected = expectedReleaseAssets({
    version: options.version,
    desktopTargets,
    requireSignatures: options.requireSignatures,
  });
  const missing = expected.filter(name => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    throw new Error(`Missing expected release assets:\n${missing.join("\n")}`);
  }

  const checksumsVerified = verifyChecksums(dir);

  const updaterKey = loadUpdaterPublicKey(
    join(repoRoot, "desktop", "src-tauri", "tauri.conf.json"),
  );
  // Every signature present is verified, required or not: a tampered signature in
  // an unsigned dry-run bundle must fail, not be skipped.
  let signaturesVerified = 0;
  for (const name of readdirSync(dir).filter(candidate => candidate.endsWith(".sig")).sort()) {
    const payload = join(dir, name.slice(0, -".sig".length));
    if (!existsSync(payload)) throw new Error(`Signature ${name} has no payload beside it`);
    verifyUpdaterSignature(payload, updaterKey);
    signaturesVerified += 1;
  }

  let manifestPlatforms: string[] = [];
  if (options.manifestOut) {
    writeUpdaterManifest({
      version: options.version,
      dir,
      repo: options.repo,
      out: options.manifestOut,
      requireAll: options.requireSignatures,
    });
    manifestPlatforms = parseBackManifest(options.manifestOut, options);
  }

  // attach-release uploads dist/release/* verbatim, so anything unexpected here
  // would be published unchecked. The bundle is exactly the expected set plus
  // the manifest this run just generated.
  const allowed = new Set(expected);
  if (options.manifestOut) allowed.add(options.manifestOut.split(/[\\/]/).pop()!);
  const extras = readdirSync(dir).filter(name => !allowed.has(name));
  if (extras.length > 0) {
    throw new Error(`Unexpected files in the release bundle (refusing to publish them):\n${extras.join("\n")}`);
  }

  const receipt: ReleaseVerificationReceipt = {
    version: options.version,
    repo: options.repo,
    sha: options.sha,
    expectedFiles: expected.length,
    checksumsVerified,
    signaturesVerified,
    manifestPlatforms,
  };
  if (options.receiptOut) {
    atomicWrite(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

if (import.meta.main) {
  const version = argument("--version");
  const dir = argument("--dir");
  const repo = argument("--repo");
  const sha = argument("--sha");
  if (!version || !dir || !repo || !sha) {
    throw new Error(
      "Usage: verify-release-assets.ts --version <version> --dir <dir> --repo <owner/name> --sha <commit>"
        + " [--manifest-out <file>] [--require-signatures] [--receipt-out <file>]",
    );
  }
  const receipt = verifyReleaseAssets({
    version,
    dir,
    repo,
    sha,
    manifestOut: argument("--manifest-out"),
    receiptOut: argument("--receipt-out"),
    requireSignatures: Bun.argv.includes("--require-signatures"),
  });
  console.log(
    `Verified ${receipt.expectedFiles} expected files, ${receipt.checksumsVerified} checksums,`
      + ` ${receipt.signaturesVerified} signatures`
      + (receipt.manifestPlatforms.length > 0
        ? `, manifest platforms: ${receipt.manifestPlatforms.join(", ")}`
        : ""),
  );
}
