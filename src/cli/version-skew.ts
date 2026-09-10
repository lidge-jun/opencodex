/**
 * CLI-versus-proxy version skew (#2701, #3464).
 *
 * The reported failure: `ocx` on PATH is an older install than the running proxy, so its
 * help describes commands the proxy does not have and its output describes a different
 * build. Nothing surfaced that, because the CLI never compared the two.
 *
 * Kept in its own module rather than inside `status.ts` so `doctor` can reuse the exact
 * comparison instead of reimplementing it -- two diagnostics disagreeing about whether an
 * install is stale would be worse than neither reporting it.
 */
import { parseStrictSemver, type StrictSemver } from "../lib/strict-semver";

/** Placeholder versions that mean "unknown", not "different". */
const PLACEHOLDERS = new Set(["unknown", "0.0.0"]);

export interface VersionSkew {
  readonly cliVersion: string;
  /** Version the live proxy reported, or null when nothing is live or it reported none. */
  readonly proxyVersion: string | null;
  readonly skewed: boolean;
  /** Operator-facing explanation; null when there is nothing to report. */
  readonly warning: string | null;
}

/** Suppressed comparisons are not confirmed matches, even when both placeholders agree. */
export function isConfirmedVersionMatch(skew: VersionSkew): boolean {
  return skew.proxyVersion === skew.cliVersion && !PLACEHOLDERS.has(skew.cliVersion);
}

/** SemVer precedence ignores build metadata; raw equality is handled separately. */
function compareVersions(cli: StrictSemver, proxy: StrictSemver): number {
  for (let i = 0; i < cli.core.length; i++) {
    if (cli.core[i]! !== proxy.core[i]!) return cli.core[i]! > proxy.core[i]! ? 1 : -1;
  }
  if (cli.prerelease.length === 0) return proxy.prerelease.length === 0 ? 0 : 1;
  if (proxy.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.max(cli.prerelease.length, proxy.prerelease.length); i++) {
    const left = cli.prerelease[i];
    const right = proxy.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left !== typeof right) return typeof left === "bigint" ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * Compare the running CLI against the live proxy.
 *
 * Suppressed rather than reported when either side is a placeholder. `packageVersion()`
 * answers `"unknown"` when `package.json` carries no string version, and the server's
 * `VERSION` falls back to `"0.0.0"` when it cannot resolve its own package -- comparing
 * against either would report skew that says nothing about the install. A false stale-CLI
 * warning would send an operator to reinstall a healthy setup.
 */
export function computeVersionSkew(cliVersion: string, proxyVersion: string | undefined): VersionSkew {
  const proxy = proxyVersion ?? null;
  if (proxy === null || PLACEHOLDERS.has(proxy) || PLACEHOLDERS.has(cliVersion) || proxy === cliVersion) {
    return { cliVersion, proxyVersion: proxy, skewed: false, warning: null };
  }
  const cliSemver = parseStrictSemver(cliVersion);
  const proxySemver = parseStrictSemver(proxy);
  const order = cliSemver && proxySemver ? compareVersions(cliSemver, proxySemver) : 0;
  const advice = order > 0
    ? "the running proxy is older than this CLI. Restart the proxy using the intended current installation. "
      // `restart`, not `repair`: a version skew leaves the service DEFINITION unchanged, and
      // repair reloads only when something changed, so it would no-op and keep the old
      // process serving (#4249).
      + "For a background service, run ocx service restart (repair reloads only a changed definition)."
    : order < 0
      ? "this ocx on PATH is older than the running proxy. Upgrade the CLI or resolve PATH to the intended installation."
      : "the versions differ, but neither can be identified as older. Check which installations the CLI and proxy use.";
  return {
    cliVersion,
    proxyVersion: proxy,
    skewed: true,
    warning: `CLI ${cliVersion} does not match the running proxy ${proxy} — ${advice}`,
  };
}
