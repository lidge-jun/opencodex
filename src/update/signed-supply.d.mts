declare const rootEvidence: unique symbol;
declare const rootTransition: unique symbol;
declare const releaseEvidence: unique symbol;
declare const targetEvidence: unique symbol;

/** In-process module-owned root handle; parsing a document does not create one. */
export interface RootEvidence { readonly [rootEvidence]: never }
export interface VerifiedRootTransition { readonly [rootTransition]: never }
export type RootBasis = RootEvidence | VerifiedRootTransition;
export interface ReleaseEvidence { readonly [releaseEvidence]: never }
export interface TargetEvidence { readonly [targetEvidence]: never; readonly candidateId: string }
export interface TransitionSummary { readonly predecessorDigest: string; readonly predecessorRevision: number; readonly successorDigest: string; readonly successorRevision: number }
export interface UpdateSelection {
  platform: "macos" | "linux" | "windows";
  arch: "x64" | "arm64";
  owner: "desktop" | "npm" | "pnpm" | "bun" | "standalone";
  artifactKind: "tauri" | "tree" | "standalone" | "guardian";
  bundleKind: "app-tar-gz" | "msi" | "appimage" | "deb" | "zip" | "tar-gz" | "binary";
}

export function bootstrapEmbeddedRoot(bytes: Uint8Array, nowMs: number): RootEvidence;
export function verifyRootTransition(predecessorBasis: RootBasis, bytes: Uint8Array, envelopeBytes: Uint8Array, nowMs: number): VerifiedRootTransition;
export function inspectTransition(transition: VerifiedRootTransition): TransitionSummary;
export function verifyReleaseEvidence(bytes: Uint8Array, envelopeBytes: Uint8Array, rootBasis: RootBasis, expectedChannel: "latest" | "preview" | "nightly", nowMs: number): ReleaseEvidence;
export function selectTargetEvidence(releaseEvidence: ReleaseEvidence, selection: UpdateSelection): TargetEvidence;
