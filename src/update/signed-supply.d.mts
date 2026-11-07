declare const verifiedRoot: unique symbol;
declare const verifiedRelease: unique symbol;
declare const verifiedCandidate: unique symbol;

/** In-process module-owned root handle; parsing a document does not create one. */
export interface VerifiedRoot { readonly [verifiedRoot]: never }
export interface VerifiedRelease { readonly [verifiedRelease]: never }
export interface VerifiedCandidate { readonly [verifiedCandidate]: never; readonly candidateId: string }
export interface UpdateSelection {
  platform: "macos" | "linux" | "windows";
  arch: "x64" | "arm64";
  owner: "desktop" | "npm" | "pnpm" | "bun" | "standalone";
  artifactKind: "tauri" | "tree" | "standalone" | "guardian";
  bundleKind: "app-tar-gz" | "msi" | "appimage" | "deb" | "zip" | "tar-gz" | "binary";
}

export function bootstrapEmbeddedRoot(bytes: Uint8Array, nowMs: number): VerifiedRoot;
export function verifyReleaseRecord(bytes: Uint8Array, envelopeBytes: Uint8Array, trustedRoot: VerifiedRoot, expectedChannel: "latest" | "preview" | "nightly", nowMs: number): VerifiedRelease;
export function selectVerifiedTarget(verifiedRelease: VerifiedRelease, selection: UpdateSelection): VerifiedCandidate;
