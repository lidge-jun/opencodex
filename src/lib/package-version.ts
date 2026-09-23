import pkg from "../../package.json" with { type: "json" };

type PackageManifest = { version?: unknown };

export function packageVersion(fallback = "unknown"): string {
  const version = (pkg as PackageManifest).version;
  return typeof version === "string" ? version : fallback;
}
