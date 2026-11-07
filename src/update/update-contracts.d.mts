/** Closed wire records are unverified data and convey no update authority. */
export type Channel = "latest" | "preview" | "nightly";
export type UpdateRole = "release" | "tree" | "desktop-artifact" | "standalone-artifact" | "guardian-artifact";
export interface DigestSize { sha256: string; size: number }
export interface RootKey { keyId: string; algorithm: "minisign-ed25519-blake2b512/1"; publicKey: string }
export interface ReleaseKey extends RootKey { channels: Channel[]; roles: UpdateRole[] }
export interface UpdateRoot { schema: "ocx.update.root/1"; revision: number; expiresAt: string; rootKeys: RootKey[]; rootThreshold: number; releaseKeys: ReleaseKey[]; releaseThreshold: number; channels: Channel[] }
export interface SignatureEnvelope { schema: "ocx.update.signatures/1"; signatures: { keyFingerprint: string; signatureBox: string }[] }
export interface RootTransitionEnvelope { schema: "ocx.update.root-transition-signatures/1"; signatures: { keyFingerprint: string; signatureBox: string }[] }
export interface UpdateTarget { id: string; platform: "macos" | "linux" | "windows"; arch: "x64" | "arm64"; owner: "desktop" | "npm" | "pnpm" | "bun" | "standalone"; artifactKind: "tauri" | "tree" | "standalone" | "guardian"; bundleKind: "app-tar-gz" | "msi" | "appimage" | "deb" | "zip" | "tar-gz" | "binary"; assetName: string; artifact: DigestSize & { signatureBox: string; signerFingerprint: string }; tree: DigestSize | null; capabilities: DigestSize }
export interface UpdateRelease { schema: "ocx.update.release/1"; version: string; channel: Channel; sequence: number; sourceCommit: string; rolloutNotBefore: string; receipt: DigestSize; releaseNotes: {title: string; body: string}[]; targets: UpdateTarget[] }
export interface UpdateReceipt { schema: "ocx.update.verification/1"; sourceCommit: string; version: string; channel: Channel; workflowRunId: number; workflowAttempt: number; versionSources: {path: string; sha256: string}[]; assets: {name: string; sha256: string; size: number}[]; universalProofs: {assetName: string; artifactSha256: string; architectures: ["arm64", "x64"]; inspectionSha256: string}[]; architectureProofs: {targetId: string; assetName: string; artifactSha256: string; arch: "arm64" | "x64"; inspectionSha256: string}[] }
export type TreeEntry = {path: string; type: "file"; mode: number; size: number; sha256: string} | {path: string; type: "directory"; mode: number} | {path: string; type: "symlink"; target: string};
export interface UpdateTree {schema: "ocx.update.tree/1"; version: string; target: string; entries: TreeEntry[]}
export interface Capability {id: string; version: number}
export interface UpdateCapabilities {schema: "ocx.link-capabilities/1"; version: string; channel: Channel; target: string; artifactSha256: string; homeProvides: Capability[]; childRequires: Capability[]; updateActions: Capability[]; installerAdapters: Capability[]; recoveryProtocols: Capability[]; fleetJournalReaders: Capability[]; compatibilityEpoch: number; compatibilityVectorSha256: string}
export interface UpdatePolicy {schema: "ocx.update.policy/1"; revision: number; channel: Channel; check: "automatic" | "manual"; download: "automatic" | "manual"; install: "manual" | "on-quit" | "when-idle"}
export type OwnerKind = "desktop" | "service" | "unmanaged";
export interface UpdatePrepared {schema: "ocx.update.prepared/1"; operationId: string; candidateDigest: string; stageIdentity: string; stageDigest: string; installationId: string; ownerKind: OwnerKind; policyRevision: number}
export type UpdateActivation = {schema: "ocx.update.activation/1"; operationId: string; generation: number; runtimeInstance: string; pid: number; port: number; installationId: string; ownerKind: OwnerKind; candidateDigest: string; stageDigest: string; policyRevision: number; deadlineMs: number} & ({action: "reserve" | "inspect"} | {action: "commit" | "cancel"; permit: string});
export interface UpdateDocumentSchemas {"ocx.update.root/1": UpdateRoot; "ocx.update.signatures/1": SignatureEnvelope; "ocx.update.root-transition-signatures/1": RootTransitionEnvelope; "ocx.update.release/1": UpdateRelease; "ocx.update.verification/1": UpdateReceipt; "ocx.update.tree/1": UpdateTree; "ocx.link-capabilities/1": UpdateCapabilities; "ocx.update.policy/1": UpdatePolicy; "ocx.update.prepared/1": UpdatePrepared; "ocx.update.activation/1": UpdateActivation}
export function parseUpdateDocument<S extends keyof UpdateDocumentSchemas>(bytes: Uint8Array, expectedSchema: S): UpdateDocumentSchemas[S];
export function parseSignatureEnvelope(bytes: Uint8Array): SignatureEnvelope;
export function parseRootTransitionEnvelope(bytes: Uint8Array): RootTransitionEnvelope;
