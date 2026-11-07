import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { bundleSignatureDetailsReason, bundleTrustStat, untrustedBundleFilesystemReason, type BundleTrustDeps } from "./bundle-trust-policy";

export { OPENAI_TEAM_ID, bundleSignatureDetailsReason, bundleTrustStat, untrustedBundleFilesystemReason } from "./bundle-trust-policy";
export type { BundleTrustDeps } from "./bundle-trust-policy";

const CODESIGN = "/usr/bin/codesign";
const CODESIGN_TIMEOUT_MS = 30_000;

export { defaultAsyncBundleTrustDeps, untrustedChatgptBundleReasonAsync } from "./bundle-trust-async";
export type { AsyncBundleTrustDeps, TrustCommandSpawn } from "./bundle-trust-async";

export function defaultBundleTrustDeps(): BundleTrustDeps {
  const admin = spawnSync("/usr/bin/dscl", [".", "-read", "/Groups/admin", "PrimaryGroupID"], {
    encoding: "utf8", timeout: 5000,
  });
  const adminId = admin.status === 0 ? /^PrimaryGroupID: ([0-9]+)\s*$/.exec(admin.stdout)?.[1] : undefined;
  return {
    adminGroupId: adminId === undefined ? undefined : Number(adminId),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    stat: bundleTrustStat,
    codesign(args) {
      const result = spawnSync(CODESIGN, [...args], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS });
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
  };
}

/**
 * Null when the bundle root and selected executable pass filesystem and OpenAI signature checks.
 * Restore omits the app-server binary and validates the app shell instead. Directories and the
 * binary must be owned by root or this user, non-symlink, and not group/other-writable;
 * ancestors also pass POSIX directory-entry replacement checks through the filesystem root.
 */
export function untrustedChatgptBundleReason(
  bundleRoot: string,
  binary: string | undefined = undefined,
  deps: BundleTrustDeps = defaultBundleTrustDeps(),
): string | null {
  const filesystemProblem = untrustedBundleFilesystemReason(bundleRoot, binary, deps);
  if (filesystemProblem) return filesystemProblem;
  binary ??= join(bundleRoot, "Contents", "MacOS", "ChatGPT");
  for (const target of [bundleRoot, binary]) {
    if (deps.codesign(["--verify", "--strict", target]).status !== 0) return `${target} failed code-signature verification`;
    const detailsProblem = bundleSignatureDetailsReason(target, deps.codesign(["-dv", "--verbose=2", target]));
    if (detailsProblem) return detailsProblem;
  }
  return null;
}
