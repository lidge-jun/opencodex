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

function decodeBase64(text: string, what: string, expectedBytes?: number): Buffer {
  const payload = Buffer.from(text, "base64");
  // Buffer.from is intentionally permissive; release metadata must be canonical.
  if (!text || payload.toString("base64") !== text
    || (expectedBytes !== undefined && payload.length !== expectedBytes)) {
    throw new Error(`Malformed ${what}: invalid base64 or decoded length`);
  }
  return payload;
}

function decodeBox(text: string, what: string): string {
  // Transport whitespace is harmless (the updater manifest also trims it).
  // The encoded payload itself must still be canonical and valid UTF-8.
  const payload = decodeBase64(text.trim(), what);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
}

function boxLines(text: string): string[] {
  // Accept minisign text with LF or CRLF and an optional terminal newline;
  // signatures authenticate decoded bytes/comments, not transport line endings.
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** minisign public key: base64 of algorithm ("Ed") || key id (8) || raw key (32). */
export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const lines = boxLines(text);
  if (lines.length !== 2 || !lines[0]!.startsWith("untrusted comment: ")) {
    throw new Error("Malformed minisign public key box");
  }
  const payload = decodeBase64(lines[1]!, "minisign public key", 42);
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
  return parseMinisignPublicKey(decodeBox(pubkey, "Tauri public key"));
}

/** Tauri CLI 2.11.1 wraps a minisign 0.7.3 prehashed signature box in base64. */
export function verifyUpdaterSignature(filePath: string, key: MinisignPublicKey): void {
  const signaturePath = `${filePath}.sig`;
  if (!existsSync(signaturePath)) throw new Error(`Missing signature: ${signaturePath}`);
  const lines = boxLines(decodeBox(readFileSync(signaturePath, "utf8"), "Tauri signature"));
  const trustedPrefix = "trusted comment: ";
  if (lines.length !== 4 || !lines[0]!.startsWith("untrusted comment: ")
    || !lines[2]!.startsWith(trustedPrefix)) {
    throw new Error(`Malformed signature box in ${signaturePath}`);
  }
  const payload = decodeBase64(lines[1]!, "signature packet", 74);
  const globalSignature = decodeBase64(lines[3]!, "comment signature", 64);
  const algorithm = payload.subarray(0, 2).toString("utf8");
  if (algorithm !== "ED") {
    throw new Error(`Unsupported signature algorithm in ${signaturePath}: ${JSON.stringify(algorithm)}`);
  }
  const keyId = payload.subarray(2, 10).toString("hex");
  if (keyId !== key.keyId) {
    throw new Error(`Signature ${signaturePath} was made by key ${keyId}, not the pinned updater key ${key.keyId}`);
  }
  const signature = payload.subarray(10, 74);
  // ED is ordinary Ed25519 over the BLAKE2b-512 digest, not Ed25519ph.
  const digest = createHash("blake2b512").update(readFileSync(filePath)).digest();
  if (!ed25519Verify(null, digest, key.publicKey, signature)) {
    throw new Error(`Signature verification failed for ${filePath}`);
  }
  // minisign signs the raw signature + trimmed trusted comment, without its
  // prefix or line terminator. The original filename may differ after collection.
  const trustedComment = lines[2]!.slice(trustedPrefix.length).trim();
  const message = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!ed25519Verify(null, message, key.publicKey, globalSignature)) {
    throw new Error(`Comment signature verification failed for ${filePath}`);
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
