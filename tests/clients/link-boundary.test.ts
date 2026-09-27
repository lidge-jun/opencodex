import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";

function sourceImports(source: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:^|[;\n])\s*import\s+(?!type\b)(?:(?:[\s\S]*?)\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]!);
  return imports;
}

function resolveRelativeImport(from: string, specifier: string): string {
  const absoluteBase = resolve(repoRoot(), dirname(from), specifier);
  const candidates = [absoluteBase, `${absoluteBase}.ts`, `${absoluteBase}.tsx`, `${absoluteBase}.js`, `${absoluteBase}/index.ts`];
  const absolute = candidates.find(candidate => existsSync(candidate));
  if (!absolute) throw new Error(`cannot resolve ${specifier} imported by ${from}`);
  return relative(repoRoot(), absolute);
}

function isForbidden(relativePath: string): boolean {
  return relativePath === "src/router.ts"
    || relativePath.startsWith("src/router/")
    || relativePath.startsWith("src/server/")
    || relativePath.startsWith("src/cli/")
    || relativePath.startsWith("src/client/")
    || relativePath.startsWith("gui/");
}

test("the link modules stay outside server, router, cli, client, and gui import paths", () => {
  const starts = readdirSync(repoPath("src", "link"))
    .filter(name => name.endsWith(".ts"))
    .sort()
    .map(name => `src/link/${name}`);
  const queue = starts.map(path => ({ path, chain: [path] }));
  const visited = new Set<string>();
  const violations: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    if (isForbidden(current.path)) violations.push(current.chain.join(" -> "));
    const source = readFileSync(repoPath(...current.path.split("/")), "utf8");
    for (const specifier of sourceImports(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelativeImport(current.path, specifier);
      if (!visited.has(target)) queue.push({ path: target, chain: [...current.chain, target] });
    }
  }

  expect(violations).toEqual([]);
});
