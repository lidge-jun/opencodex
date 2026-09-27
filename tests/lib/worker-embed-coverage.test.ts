/**
 * Every worker a compiled binary can start must be embedded by build-standalone.
 *
 * `spawnWorker(url, key)` looks `key` up in the bundles scripts/build-standalone.ts generates and
 * falls back to `url` when it is missing. The fallback is right for source checkouts and wrong
 * in a compiled binary, where the nested entrypoint does not resolve (oven-sh/bun#29124). A key
 * that drifts from `WORKER_ENTRIES`, or a new bare `new Worker(new URL(...))`, therefore passes
 * every source-run test and breaks only the released binary — the failure #5761 fixed.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoPath } from "../helpers/repo-root";

// Bare workers that a compiled binary can never start, each with the reason.
const BARE_WORKER_EXEMPTIONS: Record<string, string> = {
  // Only reached when the installer is pnpm, which runs the package from source, not the binary.
  "src/update/async-check.ts": "pnpm-only owner lookup",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.(?:ts|mts|mjs)$/.test(name) ? [path] : [];
  });
}

function workerEntries(): Map<string, string> {
  const script = readFileSync(repoPath("scripts", "build-standalone.ts"), "utf8");
  const block = /const WORKER_ENTRIES[^{]*\{([\s\S]*?)\n\};/.exec(script)?.[1];
  if (!block) throw new Error("WORKER_ENTRIES not found in scripts/build-standalone.ts");
  const entries = new Map<string, string>();
  for (const match of block.matchAll(/"([^"]+)":\s*join\(repoRoot,\s*([^)]*)\)/g)) {
    const segments = [...match[2]!.matchAll(/"([^"]+)"/g)].map(segment => segment[1]!);
    entries.set(match[1]!, segments.join("/"));
  }
  return entries;
}

const root = repoPath();
const files = sourceFiles(repoPath("src")).map(path => ({
  rel: relative(root, path).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));

test("every spawnWorker key is embedded for the same worker file", () => {
  const entries = workerEntries();
  const spawned = new Map<string, string>();
  for (const { rel, text } of files) {
    for (const match of text.matchAll(/spawnWorker\(\s*new URL\("\.\/([^"]+)",\s*import\.meta\.url\)\.href,\s*"([^"]+)"\s*\)/g)) {
      spawned.set(match[2]!, `${rel.slice(0, rel.lastIndexOf("/"))}/${match[1]}`);
    }
  }
  expect(spawned.size).toBeGreaterThan(0);
  for (const [key, workerFile] of spawned) expect({ key, embedded: entries.get(key) }).toEqual({ key, embedded: workerFile });
  // A stale entry bundles a worker nobody spawns, and usually means a key was renamed on one side.
  expect([...entries.keys()].filter(key => !spawned.has(key))).toEqual([]);
});

test("workers are started through spawnWorker unless explicitly exempted", () => {
  const bare = files
    .filter(({ rel, text }) => rel !== "src/lib/worker-embed.ts" && /new Worker\(/.test(text.replace(/^\s*(?:\*|\/\/).*$/gm, "")))
    .map(({ rel }) => rel);
  expect(bare.sort()).toEqual(Object.keys(BARE_WORKER_EXEMPTIONS).sort());
});
