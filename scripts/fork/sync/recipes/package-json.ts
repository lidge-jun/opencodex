const FORK_PACKAGE_NAME = "@yansigit/opencodex";

export function mergePackageJson(ours: string, theirs: string): string {
  const current = JSON.parse(ours) as Record<string, unknown>;
  const upstream = JSON.parse(theirs) as Record<string, unknown>;
  if (typeof current.version !== "string" || current.version.length === 0) {
    throw new Error("fork package.json must contain a version");
  }
  return `${JSON.stringify({
    ...upstream,
    name: FORK_PACKAGE_NAME,
    version: current.version,
  }, null, 2)}\n`;
}
