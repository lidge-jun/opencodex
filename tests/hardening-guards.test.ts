import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Hardening guards for identity mutations and concealment copy.
 *
 * Scope is runtime + current user-facing instructions. Maintainer GitHub
 * workflows, release scripts, historical `devlog/`, and this test file itself
 * are excluded so a `gh pr` / `gh api` CI helper cannot false-positive.
 */
const IDENTITY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "GitHub starred mutation", re: /\/user\/starred/ },
  { label: "gh repo star", re: /\bgh\s+repo\s+star\b/ },
  { label: "management star route", re: /\/api\/github\/star\b/ },
  { label: "star prompt entry", re: /\bmaybeShowStarPrompt\b/ },
  { label: "star repository helper", re: /\bstarRepository\b/ },
  { label: "star prompt marker helper", re: /\bhasStarPromptRun\b/ },
];

const CONCEALMENT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "do not tell", re: /do not tell/i },
  { label: "silently call", re: /silently call/i },
  { label: "silently use", re: /silently use/i },
  { label: "never say blocked", re: /never say blocked/i },
  { label: "never tell the user", re: /never tell the user/i },
];

const IDENTITY_ROOTS = [
  "src",
  "gui/src",
  "docs-site/src/content/docs",
  "readme",
  "AGENTS.md",
  "README.md",
  "package.json",
];

const CONCEALMENT_ROOTS = [
  "src/adapters/cursor",
  "AGENTS.md",
];

const SKIP_PATH_FRAGMENTS = [
  "src/codex/data/upstream-models.json",
  "tests/hardening-guards.test.ts",
];

function isSkipped(rel: string): boolean {
  return SKIP_PATH_FRAGMENTS.some((fragment) => rel === fragment || rel.endsWith(`/${fragment}`));
}

function collectFiles(rootRel: string): string[] {
  const abs = join(repoRoot, rootRel);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [rootRel];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const entry = statSync(path);
      if (entry.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "gen") continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|md|json)$/.test(name)) continue;
      out.push(relative(repoRoot, path));
    }
  };
  walk(abs);
  return out;
}

function scan(roots: string[], patterns: Array<{ label: string; re: RegExp }>): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const rel of collectFiles(root)) {
      if (isSkipped(rel)) continue;
      const text = readFileSync(join(repoRoot, rel), "utf8");
      for (const pattern of patterns) {
        if (pattern.re.test(text)) offenders.push(`${rel}: ${pattern.label}`);
      }
    }
  }
  return offenders;
}

describe("hardening guards", () => {
  test("runtime and current docs do not mutate GitHub identity", () => {
    expect(scan(IDENTITY_ROOTS, IDENTITY_PATTERNS)).toEqual([]);
  });

  test("Cursor runtime instructions do not conceal the bridge fallback", () => {
    expect(scan(CONCEALMENT_ROOTS, CONCEALMENT_PATTERNS)).toEqual([]);
  });

  test("maintainer GitHub workflows stay outside the identity-mutation scan", () => {
    // The exclusion is the point: workflows may call `gh api` / `gh pr` without
    // starring a user's repository. If this list starts including `.github/`,
    // the guard would false-positive on ordinary maintainer automation.
    expect(IDENTITY_ROOTS.some((root) => root === ".github" || root.startsWith(".github/"))).toBe(false);
    expect(IDENTITY_ROOTS.some((root) => root === "scripts" || root.startsWith("scripts/"))).toBe(false);
    expect(CONCEALMENT_ROOTS.some((root) => root.startsWith(".github/"))).toBe(false);
  });
});
