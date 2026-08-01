import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const REMOTE_AGENT_MANIFEST_FILE = "remote-agent-manifest.json";
export const REMOTE_AGENT_MANIFEST_SIGNATURE_FILE = `${REMOTE_AGENT_MANIFEST_FILE}.sig`;
export const REMOTE_AGENT_PUBLIC_KEY_FILE = "remote-agent-public-key.pem";
export const REMOTE_AGENT_MAX_BYTES = 64 * 1024 * 1024;

export const REMOTE_AGENT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABcZpftnO6RPhs2EyXahbCyNv61SF9lKGQubC+4vpXhA=
-----END PUBLIC KEY-----
`;

export const REMOTE_AGENT_KEY_ID = "sha256:7e60478af3ab0994ca21b21fd6cd14e55e38d7ad204116d2e2cc4760e0c61446";

export const REMOTE_AGENT_SPECS = [
  { package: "linux-x64", executable: "opencodex-remote-agent", releaseFile: "opencodex-remote-agent-linux-x64" },
  { package: "linux-arm64", executable: "opencodex-remote-agent", releaseFile: "opencodex-remote-agent-linux-arm64" },
  { package: "macos-x64", executable: "opencodex-remote-agent", releaseFile: "opencodex-remote-agent-macos-x64" },
  { package: "macos-arm64", executable: "opencodex-remote-agent", releaseFile: "opencodex-remote-agent-macos-arm64" },
  { package: "windows-x64", executable: "opencodex-remote-agent.exe", releaseFile: "opencodex-remote-agent-windows-x64.exe" },
  { package: "windows-arm64", executable: "opencodex-remote-agent.exe", releaseFile: "opencodex-remote-agent-windows-arm64.exe" },
] as const;

export type RemoteAgentPackage = typeof REMOTE_AGENT_SPECS[number]["package"];

interface RemoteAgentManifestArtifact {
  path: string;
  releaseFile: string;
  sha256: string;
  signature: string;
}

interface RemoteAgentUnsignedManifest {
  schemaVersion: 1;
  keyId: string;
  sourceCommit: string;
  packageVersion: string;
  artifacts: Record<RemoteAgentPackage, RemoteAgentManifestArtifact>;
}

export interface RemoteAgentManifest extends RemoteAgentUnsignedManifest {
  manifestSignature: string;
}

interface AssembleRemoteAgentBundleOptions {
  inputRoot: string;
  bundleRoot: string;
  releaseAssetsRoot: string;
  privateKeyPem: string;
  sourceCommit: string;
  packageVersion: string;
  expectedPublicKeyPem?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function specForPackage(packageName: string) {
  return REMOTE_AGENT_SPECS.find(spec => spec.package === packageName);
}

export function remoteAgentPackageForRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RemoteAgentPackage | null {
  const normalizedPlatform = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  if (!normalizedPlatform || (arch !== "x64" && arch !== "arm64")) return null;
  const packageName = `${normalizedPlatform}-${arch}`;
  return specForPackage(packageName) ? packageName as RemoteAgentPackage : null;
}

function parseManifest(raw: string, expectedKeyId: string): RemoteAgentManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Remote Agent manifest is not valid JSON");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "keyId", "sourceCommit", "packageVersion", "artifacts", "manifestSignature",
  ])) {
    throw new Error("Remote Agent manifest has an unsupported structure");
  }
  if (value.schemaVersion !== 1 || value.keyId !== expectedKeyId) {
    throw new Error("Remote Agent manifest uses an untrusted signing key");
  }
  if (typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) {
    throw new Error("Remote Agent manifest has an invalid source commit");
  }
  if (
    typeof value.packageVersion !== "string"
    || value.packageVersion.length > 128
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.packageVersion)
  ) {
    throw new Error("Remote Agent manifest has an invalid package version");
  }
  if (typeof value.manifestSignature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.manifestSignature)) {
    throw new Error("Remote Agent manifest signature is invalid");
  }
  if (!isRecord(value.artifacts)) throw new Error("Remote Agent manifest has no artifact map");
  const packageNames = REMOTE_AGENT_SPECS.map(spec => spec.package);
  if (!hasExactKeys(value.artifacts, packageNames)) {
    throw new Error("Remote Agent manifest does not contain the complete platform set");
  }

  for (const spec of REMOTE_AGENT_SPECS) {
    const artifact = value.artifacts[spec.package];
    if (!isRecord(artifact) || !hasExactKeys(artifact, ["path", "releaseFile", "sha256", "signature"])) {
      throw new Error(`Remote Agent manifest entry is invalid for ${spec.package}`);
    }
    if (artifact.path !== `${spec.package}/${spec.executable}` || artifact.releaseFile !== spec.releaseFile) {
      throw new Error(`Remote Agent manifest path is invalid for ${spec.package}`);
    }
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error(`Remote Agent checksum is invalid for ${spec.package}`);
    }
    if (typeof artifact.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(artifact.signature)) {
      throw new Error(`Remote Agent signature is invalid for ${spec.package}`);
    }
  }
  return value as unknown as RemoteAgentManifest;
}

function unsignedManifest(manifest: RemoteAgentManifest | RemoteAgentUnsignedManifest): RemoteAgentUnsignedManifest {
  const artifacts = {} as Record<RemoteAgentPackage, RemoteAgentManifestArtifact>;
  for (const spec of REMOTE_AGENT_SPECS) {
    const artifact = manifest.artifacts[spec.package];
    artifacts[spec.package] = {
      path: artifact.path,
      releaseFile: artifact.releaseFile,
      sha256: artifact.sha256,
      signature: artifact.signature,
    };
  }
  return {
    schemaVersion: 1,
    keyId: manifest.keyId,
    sourceCommit: manifest.sourceCommit,
    packageVersion: manifest.packageVersion,
    artifacts,
  };
}

function manifestSigningPayload(manifest: RemoteAgentManifest | RemoteAgentUnsignedManifest): Buffer {
  return Buffer.from(`opencodex-remote-agent-manifest-v1\0${JSON.stringify(unsignedManifest(manifest))}`, "utf8");
}

function readBoundedRegularFile(path: string): Buffer {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("Remote Agent artifact is missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > REMOTE_AGENT_MAX_BYTES) {
    throw new Error("Remote Agent artifact is not a bounded regular file");
  }
  return readFileSync(path);
}

function publicKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function loadPublicKey(publicKeyPem: string): { key: KeyObject; keyId: string } {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return { key, keyId: publicKeyId(key) };
  } catch {
    throw new Error("Remote Agent public key is invalid");
  }
}

function loadPrivateKey(privateKeyPem: string): KeyObject {
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("Remote Agent signing key is invalid");
  }
}

function verifyArtifactBytes(bytes: Buffer, artifact: RemoteAgentManifestArtifact, publicKey: KeyObject): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) throw new Error("Remote Agent checksum verification failed");
  let signature: Buffer;
  try {
    signature = Buffer.from(artifact.signature, "base64url");
  } catch {
    throw new Error("Remote Agent signature is malformed");
  }
  if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new Error("Remote Agent signature verification failed");
  }
}

function verifyManifestSignature(manifest: RemoteAgentManifest, publicKey: KeyObject): void {
  const signature = Buffer.from(manifest.manifestSignature, "base64url");
  if (signature.length !== 64 || !verify(null, manifestSigningPayload(manifest), publicKey, signature)) {
    throw new Error("Remote Agent manifest signature verification failed");
  }
}

function assertExpectedPackageVersion(manifest: RemoteAgentManifest, expectedPackageVersion?: string): void {
  if (expectedPackageVersion !== undefined && manifest.packageVersion !== expectedPackageVersion) {
    throw new Error("Remote Agent bundle does not match the installed package version");
  }
}

export function readRemoteAgentManifest(
  bundleRoot: string,
  publicKeyPem: string = REMOTE_AGENT_PUBLIC_KEY_PEM,
): RemoteAgentManifest {
  const { key, keyId } = loadPublicKey(publicKeyPem);
  let raw: string;
  try {
    raw = readFileSync(join(bundleRoot, REMOTE_AGENT_MANIFEST_FILE), "utf8");
  } catch {
    throw new Error("Remote Agent manifest is missing");
  }
  const manifest = parseManifest(raw, keyId);
  verifyManifestSignature(manifest, key);
  return manifest;
}

export function verifyRemoteAgentArtifact(
  bundleRoot: string,
  packageName: RemoteAgentPackage,
  publicKeyPem: string = REMOTE_AGENT_PUBLIC_KEY_PEM,
  expectedPackageVersion?: string,
): string {
  const spec = specForPackage(packageName);
  if (!spec) throw new Error("Remote Agent is not available for this platform");
  const { key, keyId } = loadPublicKey(publicKeyPem);
  let raw: string;
  try {
    raw = readFileSync(join(bundleRoot, REMOTE_AGENT_MANIFEST_FILE), "utf8");
  } catch {
    throw new Error("Remote Agent manifest is missing");
  }
  const manifest = parseManifest(raw, keyId);
  verifyManifestSignature(manifest, key);
  assertExpectedPackageVersion(manifest, expectedPackageVersion);
  const binary = join(bundleRoot, spec.package, spec.executable);
  verifyArtifactBytes(readBoundedRegularFile(binary), manifest.artifacts[spec.package], key);
  return binary;
}

export function verifyRemoteAgentBundle(
  bundleRoot: string,
  publicKeyPem: string = REMOTE_AGENT_PUBLIC_KEY_PEM,
  expectedPackageVersion?: string,
): RemoteAgentManifest {
  const { key, keyId } = loadPublicKey(publicKeyPem);
  let raw: string;
  try {
    raw = readFileSync(join(bundleRoot, REMOTE_AGENT_MANIFEST_FILE), "utf8");
  } catch {
    throw new Error("Remote Agent manifest is missing");
  }
  const manifest = parseManifest(raw, keyId);
  verifyManifestSignature(manifest, key);
  assertExpectedPackageVersion(manifest, expectedPackageVersion);
  for (const spec of REMOTE_AGENT_SPECS) {
    const bytes = readBoundedRegularFile(join(bundleRoot, spec.package, spec.executable));
    verifyArtifactBytes(bytes, manifest.artifacts[spec.package], key);
  }
  return manifest;
}

function replaceDirectory(staged: string, destination: string): void {
  const backup = `${destination}.old-${process.pid}-${randomUUID()}`;
  const hadDestination = existsSync(destination);
  if (hadDestination) renameSync(destination, backup);
  try {
    renameSync(staged, destination);
    if (hadDestination) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadDestination && existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  }
}

/**
 * [Decision Log]
 * - 목적과 의도: npm 설치 후 런타임 컴파일 없이 지원 플랫폼 Agent를 제공하되, 패키지나 캐시가 변조된 경우 실행을 차단한다.
 * - 기존 구현 및 제약 조건: Agent source만 있었고 CI artifact, 서명 manifest, 런타임 신뢰 기준이 없었다.
 * - 검토한 주요 대안: 사용자 PC cargo build, 플랫폼별 npm optional package, checksum만 사용, 단일 npm package에 서명 binary 동봉.
 * - 선택한 방식: 공식 runner의 6개 native build를 release job에서 Ed25519로 서명하고, 정확한 allowlist manifest와 함께 원자적으로 조립한다.
 * - 다른 대안 대신 이 방식을 선택한 이유: 설치 절차를 바꾸지 않으면서 공급망 변조를 fail-closed로 막고 build provenance를 한 release commit에 묶을 수 있다.
 * - 장점, 단점 및 영향: Linux/macOS/Windows x64·arm64가 즉시 동작하지만 release secret 관리와 6개 runner 검증이 필수다.
 */
export function assembleRemoteAgentBundle(options: AssembleRemoteAgentBundleOptions): RemoteAgentManifest {
  if (!/^[0-9a-f]{40}$/.test(options.sourceCommit)) throw new Error("Remote Agent source commit must be a full lowercase SHA");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.packageVersion)) {
    throw new Error("Remote Agent package version must be valid semver");
  }
  const expectedPublicKeyPem = options.expectedPublicKeyPem ?? REMOTE_AGENT_PUBLIC_KEY_PEM;
  const { key: expectedPublicKey, keyId } = loadPublicKey(expectedPublicKeyPem);
  const privateKey = loadPrivateKey(options.privateKeyPem);
  const derivedPublicKey = createPublicKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  if (publicKeyId(derivedPublicKey) !== keyId) throw new Error("Remote Agent signing key does not match the pinned public key");

  const bundleRoot = resolve(options.bundleRoot);
  const releaseRoot = resolve(options.releaseAssetsRoot);
  const bundleStage = join(dirname(bundleRoot), `.${basename(bundleRoot)}.tmp-${process.pid}-${randomUUID()}`);
  const releaseStage = join(dirname(releaseRoot), `.${basename(releaseRoot)}.tmp-${process.pid}-${randomUUID()}`);
  const artifacts = {} as Record<RemoteAgentPackage, RemoteAgentManifestArtifact>;
  mkdirSync(bundleStage, { recursive: true, mode: 0o755 });
  mkdirSync(releaseStage, { recursive: true, mode: 0o755 });

  try {
    for (const spec of REMOTE_AGENT_SPECS) {
      const source = join(options.inputRoot, `remote-agent-${spec.package}`, spec.executable);
      const bytes = readBoundedRegularFile(source);
      const signature = sign(null, bytes, privateKey);
      const artifact: RemoteAgentManifestArtifact = {
        path: `${spec.package}/${spec.executable}`,
        releaseFile: spec.releaseFile,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signature: signature.toString("base64url"),
      };
      artifacts[spec.package] = artifact;

      const packageDir = join(bundleStage, spec.package);
      mkdirSync(packageDir, { recursive: true, mode: 0o755 });
      const packagedBinary = join(packageDir, spec.executable);
      copyFileSync(source, packagedBinary);
      if (!spec.package.startsWith("windows-")) chmodSync(packagedBinary, 0o755);

      const releaseBinary = join(releaseStage, spec.releaseFile);
      copyFileSync(source, releaseBinary);
      if (!spec.package.startsWith("windows-")) chmodSync(releaseBinary, 0o755);
      writeFileSync(`${releaseBinary}.sig`, signature, { mode: 0o644 });
    }

    const unsigned: RemoteAgentUnsignedManifest = {
      schemaVersion: 1,
      keyId,
      sourceCommit: options.sourceCommit,
      packageVersion: options.packageVersion,
      artifacts,
    };
    const manifestSignature = sign(null, manifestSigningPayload(unsigned), privateKey);
    const manifest: RemoteAgentManifest = {
      ...unsigned,
      manifestSignature: manifestSignature.toString("base64url"),
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(bundleStage, REMOTE_AGENT_MANIFEST_FILE), serialized, { mode: 0o644 });
    writeFileSync(join(releaseStage, REMOTE_AGENT_MANIFEST_FILE), serialized, { mode: 0o644 });
    writeFileSync(join(releaseStage, REMOTE_AGENT_MANIFEST_SIGNATURE_FILE), manifestSignature, { mode: 0o644 });
    writeFileSync(join(releaseStage, REMOTE_AGENT_PUBLIC_KEY_FILE), expectedPublicKeyPem, { mode: 0o644 });

    verifyRemoteAgentBundle(bundleStage, expectedPublicKeyPem, options.packageVersion);
    if (!verify(null, Buffer.from("bundle-key-check"), expectedPublicKey, sign(null, Buffer.from("bundle-key-check"), privateKey))) {
      throw new Error("Remote Agent signing key verification failed");
    }
    mkdirSync(dirname(bundleRoot), { recursive: true });
    mkdirSync(dirname(releaseRoot), { recursive: true });
    replaceDirectory(bundleStage, bundleRoot);
    replaceDirectory(releaseStage, releaseRoot);
    return manifest;
  } catch (error) {
    rmSync(bundleStage, { recursive: true, force: true });
    rmSync(releaseStage, { recursive: true, force: true });
    throw error;
  }
}
