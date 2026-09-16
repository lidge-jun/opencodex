/**
 * Shared registry metadata pre-flight for every direct package-manager launcher.
 *
 * This intentionally does not perform the query itself. The caller supplies the
 * already-hardened npm/pnpm invocation, so the plain Node launcher and the Bun
 * update worker apply exactly the same integrity policy without importing TypeScript
 * into the published launcher.
 */
function outputText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

/**
 * Check the registry's dist.integrity value for one immutable package version.
 * A failed query is a best-effort skip; successful metadata without a sha512 SRI
 * value is anomalous and fails closed before the caller changes local state.
 */
export function checkRegistryPackageIntegrity(packageName, version, run) {
  if (!version) return { ok: "skipped", reason: "no resolved version (registry unavailable)" };

  let result;
  try {
    result = run(["view", `${packageName}@${version}`, "dist.integrity"], true);
  } catch {
    return { ok: "skipped", reason: "registry integrity query failed" };
  }
  if (result?.status !== 0) {
    return { ok: "skipped", reason: `registry integrity query failed (status ${result?.status ?? "timeout"})` };
  }

  const tokens = outputText(result.stdout).replace(/["']/g, "").trim().split(/\s+/).filter(Boolean);
  const integrity = tokens.find(token => /^sha512-[A-Za-z0-9+/=]+$/.test(token));
  if (!integrity) return { ok: false, reason: `registry returned no sha512 integrity for ${packageName}@${version}` };
  return { ok: true, integrity };
}
