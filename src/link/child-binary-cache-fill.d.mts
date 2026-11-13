export declare const CHILD_RELEASE_DIGESTS_PATH: string;
export declare const CHILD_RELEASE_REPOSITORY: string;
export declare const CHILD_CACHE_ARTIFACT_FILES: readonly string[];
export declare function childReleaseAssetUrl(version: string, file: string): string;
/** "ocx-child-builds": the fill's own directory under OPENCODEX_HOME. */
export declare const CHILD_FILL_DIR: string;
export declare function childBinaryCacheDir(opencodexHome: string, version: string): string;
export declare function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 | null;

/**
 * Why the startup step's ownership claim stopped a fill before any write: an ocx-child-builds directory
 * the ownership manifest does not list that already holds files (OpenCodex did not create it), an
 * uninstall in progress, or a manifest that is full or locked by another process (the next start tries again).
 */
export type ChildCacheClaimRefusal = "foreign_directory" | "uninstall_in_progress" | "ownership_unavailable";

export type ChildCacheFillOutcome =
  /** first_start: no record of an earlier version (a fresh install), so the version is recorded and nothing fetched. */
  /** invalid_digests: the package's digest file is there but unreadable or unusable (the record is left alone); busy: another process is filling. */
  | { readonly kind: "skipped"; readonly reason: "invalid_version" | "no_digests" | "invalid_digests" | "downgrade" | "first_start" | "not_an_upgrade" | "busy" | "source_checkout" | "unsupported_platform" | "disabled" | "version_mismatch" | ChildCacheClaimRefusal }
  /** cached: every verified build now in the cache; fetched: those downloaded now; failed: listed builds withdrawn from the manifest. */
  | { readonly kind: "filled"; readonly cached: readonly string[]; readonly fetched: readonly string[]; readonly failed: readonly string[] };

export interface ChildCacheFillOptions {
  /** Root of the running package tree, which its installer verified. */
  readonly packageRoot: string;
  readonly version: string;
  /** Required: the Home the reader resolves (getConfigDir() in the startup step); there is no environment fallback. */
  readonly opencodexHome: string;
  readonly fetchImpl?: typeof fetch;
  /** Per download. */
  readonly timeoutMs?: number;
  /** Defaults to process.platform; on win32 the fill does nothing (no mode bits to prove the cache private). */
  readonly platform?: NodeJS.Platform;
  /** Clock for the fill lock's age; defaults to Date.now. */
  readonly now?: () => number;
  /** The running code's own version (startup); a package.json that differs records nothing (version_mismatch). */
  readonly bundledVersion?: string;
  /** Called once after the gates and before the first write; a refusal ends the fill with that reason. */
  readonly claimCache?: () => ChildCacheClaimRefusal | null;
}

export declare function runningPackageRoot(): string;
export declare function fillChildBinaryCacheForVersion(options: ChildCacheFillOptions): Promise<ChildCacheFillOutcome>;
export declare function runningPackageVersion(packageRoot?: string): string | null;
/** Defaults: the running package root and its package.json version. */
export declare function fillChildBinaryCacheOnStart(
  options: Partial<ChildCacheFillOptions> & { readonly opencodexHome: string },
  out?: { log: (line: string) => void; warn: (line: string) => void },
): Promise<ChildCacheFillOutcome | null>;
