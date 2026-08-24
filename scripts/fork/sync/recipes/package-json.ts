const FORK_PACKAGE_NAME = "@yansigit/opencodex";

export function mergePackageJson(ours: string, theirs: string): string {
  JSON.parse(ours);
  const upstream = JSON.parse(theirs) as Record<string, unknown>;
  return `${JSON.stringify({
    ...upstream,
    name: FORK_PACKAGE_NAME,
  }, null, 2)}\n`;
}
