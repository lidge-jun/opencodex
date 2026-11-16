declare const rootEvidence: unique symbol;
declare const rootTransition: unique symbol;
declare const releaseEvidence: unique symbol;
declare const targetEvidence: unique symbol;
declare const artifactEvidence: unique symbol;
declare const receiptEvidence: unique symbol;
declare const treeEvidence: unique symbol;
declare const capabilityEvidence: unique symbol;

/** In-process module-owned root handle; parsing a document does not create one. */
export interface RootEvidence { readonly [rootEvidence]: never }
export interface VerifiedRootTransition { readonly [rootTransition]: never }
export type RootBasis = RootEvidence | VerifiedRootTransition;
export interface ReleaseEvidence { readonly [releaseEvidence]: never }
export interface TargetEvidence { readonly [targetEvidence]: never; readonly candidateId: string }
export interface ArtifactEvidence { readonly [artifactEvidence]: never }
export interface ReceiptEvidence { readonly [receiptEvidence]: never }
export interface TreeEvidence { readonly [treeEvidence]: never }
export interface CapabilityEvidence { readonly [capabilityEvidence]: never }
export interface TransitionSummary { readonly predecessorDigest: string; readonly predecessorRevision: number; readonly successorDigest: string; readonly successorRevision: number }
export interface UpdateSelection {
  platform: "macos" | "linux" | "windows";
  arch: "x64" | "arm64";
  owner: "desktop" | "npm" | "pnpm" | "bun" | "standalone";
  artifactKind: "tauri" | "tree" | "standalone" | "guardian";
  bundleKind: "app-tar-gz" | "msi" | "appimage" | "deb" | "zip" | "tar-gz" | "binary";
}
/** Detached diagnostic data; none of these shapes is an evidence handle. */
export interface SnapshotBasis { readonly basisDigest: string; readonly basisRevision: number }
export interface SnapshotTargetBinding extends SnapshotBasis { readonly releaseDigest: string; readonly targetId: string; readonly candidateId: string }
export interface RootEvidenceSnapshot { readonly kind: "root"; readonly rootBytes: Uint8Array; readonly rootDigest: string; readonly rootRevision: number; readonly anchorDigest: string }
export interface TransitionEvidenceSnapshot { readonly kind: "transition"; readonly rootBytes: Uint8Array; readonly envelopeBytes: Uint8Array; readonly rootDigest: string; readonly rootRevision: number; readonly predecessorDigest: string; readonly predecessorRevision: number }
export interface ReleaseEvidenceSnapshot extends SnapshotBasis { readonly kind: "release"; readonly releaseBytes: Uint8Array; readonly envelopeBytes: Uint8Array; readonly releaseDigest: string; readonly channel: "latest" | "preview" | "nightly" }
export interface TargetEvidenceSnapshot extends SnapshotTargetBinding { readonly kind: "target"; readonly selection: Readonly<UpdateSelection> }
export interface ArtifactEvidenceSnapshot extends SnapshotTargetBinding { readonly kind: "artifact"; readonly artifactDigest: string; readonly artifactSize: number; readonly signatureBox: string; readonly signerFingerprint: string }
export interface ReceiptEvidenceSnapshot extends SnapshotTargetBinding { readonly kind: "receipt"; readonly receiptBytes: Uint8Array; readonly receiptDigest: string; readonly receiptSize: number }
export interface TreeEvidenceSnapshot extends SnapshotTargetBinding { readonly kind: "tree"; readonly treeBytes: Uint8Array; readonly envelopeBytes: Uint8Array; readonly treeDigest: string; readonly treeSize: number; readonly envelopeDigest: string; readonly envelopeSize: number; readonly receiptDigest: string }
export interface CapabilityEvidenceSnapshot extends SnapshotTargetBinding { readonly kind: "capability"; readonly capabilityBytes: Uint8Array; readonly capabilityDigest: string; readonly capabilitySize: number; readonly receiptDigest: string }
export type EvidenceHandle = RootBasis | ReleaseEvidence | TargetEvidence | ArtifactEvidence | ReceiptEvidence | TreeEvidence | CapabilityEvidence;
export type EvidenceSnapshot = RootEvidenceSnapshot | TransitionEvidenceSnapshot | ReleaseEvidenceSnapshot | TargetEvidenceSnapshot | ArtifactEvidenceSnapshot | ReceiptEvidenceSnapshot | TreeEvidenceSnapshot | CapabilityEvidenceSnapshot;

export function bootstrapEmbeddedRoot(bytes: Uint8Array, nowMs: number): RootEvidence;
export function verifyRootTransition(predecessorBasis: RootBasis, bytes: Uint8Array, envelopeBytes: Uint8Array, nowMs: number): VerifiedRootTransition;
export function inspectTransition(transition: VerifiedRootTransition): TransitionSummary;
export function verifyReleaseEvidence(bytes: Uint8Array, envelopeBytes: Uint8Array, rootBasis: RootBasis, expectedChannel: "latest" | "preview" | "nightly", nowMs: number): ReleaseEvidence;
export function selectTargetEvidence(releaseEvidence: ReleaseEvidence, selection: UpdateSelection): TargetEvidence;
export function verifyArtifactEvidence(target: TargetEvidence, bytes: Uint8Array, basis: RootBasis, nowMs: number): ArtifactEvidence;
export function verifyExternalMetadataEvidence(target: TargetEvidence, input: { kind: "receipt"; bytes: Uint8Array }, basis: RootBasis, nowMs: number): ReceiptEvidence;
export function verifyExternalMetadataEvidence(target: TargetEvidence, input: { kind: "tree"; bytes: Uint8Array; signatureEnvelopeBytes: Uint8Array; receiptEvidence: ReceiptEvidence }, basis: RootBasis, nowMs: number): TreeEvidence;
export function verifyExternalMetadataEvidence(target: TargetEvidence, input: { kind: "capability"; bytes: Uint8Array; receiptEvidence: ReceiptEvidence }, basis: RootBasis, nowMs: number): CapabilityEvidence;
export function snapshotEvidence(handle: RootEvidence): RootEvidenceSnapshot;
export function snapshotEvidence(handle: VerifiedRootTransition): TransitionEvidenceSnapshot;
export function snapshotEvidence(handle: ReleaseEvidence): ReleaseEvidenceSnapshot;
export function snapshotEvidence(handle: TargetEvidence): TargetEvidenceSnapshot;
export function snapshotEvidence(handle: ArtifactEvidence): ArtifactEvidenceSnapshot;
export function snapshotEvidence(handle: ReceiptEvidence): ReceiptEvidenceSnapshot;
export function snapshotEvidence(handle: TreeEvidence): TreeEvidenceSnapshot;
export function snapshotEvidence(handle: CapabilityEvidence): CapabilityEvidenceSnapshot;
export function snapshotEvidence(handle: EvidenceHandle): EvidenceSnapshot;
