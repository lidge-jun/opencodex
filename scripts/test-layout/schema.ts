import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The tests/ layout map. `explicit` is the authoritative basename -> directory table; the
 * regex seeds under `domains` exist so a brand-new test file can still resolve before someone
 * adds it to `explicit`. `migrated` lists the domains whose files have already left the root.
 */
export interface DomainSpec {
  match: string[];
  children?: Record<string, string[]>;
}

export interface Layout {
  version: 1;
  root: "tests";
  keepAtRoot: string[];
  domains: Record<string, DomainSpec>;
  explicit: Record<string, string>;
  migrated: string[];
}

export const LAYOUT_PATH = join(import.meta.dir, "layout.json");

export function loadLayout(path: string = LAYOUT_PATH): Layout {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Layout;
  if (parsed.version !== 1 || parsed.root !== "tests") {
    throw new Error(`${path}: unsupported layout version/root`);
  }
  for (const key of ["keepAtRoot", "migrated"] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`${path}: ${key} must be an array`);
  }
  if (typeof parsed.explicit !== "object" || parsed.explicit === null) {
    throw new Error(`${path}: explicit must be an object`);
  }
  return parsed;
}

/**
 * Directory (relative to tests/) a test file belongs in, or null when the map does not know it.
 * Explicit entries win, then child regexes, then domain regexes; first match wins.
 */
export function resolveTarget(layout: Layout, basename: string): string | null {
  const explicit = layout.explicit[basename];
  if (explicit !== undefined) return explicit;
  for (const [domain, spec] of Object.entries(layout.domains)) {
    for (const [child, patterns] of Object.entries(spec.children ?? {})) {
      if (patterns.some(pattern => new RegExp(pattern).test(basename))) return `${domain}/${child}`;
    }
  }
  for (const [domain, spec] of Object.entries(layout.domains)) {
    if (spec.match.some(pattern => new RegExp(pattern).test(basename))) return domain;
  }
  return null;
}

/** Where the file lives right now: its target once that domain has migrated, else the root. */
export function currentPath(layout: Layout, basename: string): string {
  const target = resolveTarget(layout, basename);
  if (target === null) return basename;
  const top = target.split("/")[0]!;
  return layout.migrated.includes(top) ? `${target}/${basename}` : basename;
}

/** Nesting depth of a target directory below tests/ (`server` -> 1, `providers/cursor` -> 2). */
export function depthOf(target: string): number {
  return target.split("/").length;
}

/**
 * Relative specifier prefixes the mover rewrites. Each entry names the prefix as written in a
 * root-level test and which anchor it points at: `tests` for siblings of the tests/ root
 * (helpers, fixtures, preload, fake-codex-server) and `repo` for everything above it.
 */
export const REWRITE_PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly anchor: "tests" | "repo" }> = [
  { prefix: "./helpers/", anchor: "tests" },
  { prefix: "../helpers/", anchor: "tests" },
  { prefix: "./fixtures/", anchor: "tests" },
  { prefix: "../fixtures/", anchor: "tests" },
  { prefix: "./preload", anchor: "tests" },
  { prefix: "../preload", anchor: "tests" },
  { prefix: "./fake-codex-server", anchor: "tests" },
  { prefix: "../fake-codex-server", anchor: "tests" },
  { prefix: "../src/", anchor: "repo" },
  { prefix: "../gui/", anchor: "repo" },
  { prefix: "../scripts/", anchor: "repo" },
  { prefix: "../bin/", anchor: "repo" },
  { prefix: "../package.json", anchor: "repo" },
  { prefix: "../.gitignore", anchor: "repo" },
  { prefix: "../.github/", anchor: "repo" },
  { prefix: "../skills/", anchor: "repo" },
  { prefix: "../docs-site/", anchor: "repo" },
  { prefix: "../structure/", anchor: "repo" },
  { prefix: "../devlog/", anchor: "repo" },
  { prefix: "../", anchor: "repo" },
];

/** `..` chains that reach tests/ and the repository root from a file at `depth` below tests/. */
export function anchors(depth: number): { toTests: string; toRepo: string } {
  const up = (n: number) => Array.from({ length: n }, () => "..").join("/");
  return { toTests: up(depth), toRepo: up(depth + 1) };
}

/**
 * Rewrite one relative specifier written for a root-level test so it resolves from a file
 * `depth` directories below tests/. Non-relative specifiers and unknown prefixes are returned
 * unchanged. Longest prefix wins so `../helpers/` is not swallowed by the bare `../` rule.
 */
export function rewriteSpecifier(spec: string, depth: number): string {
  if (depth < 1) return spec;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  const { toTests, toRepo } = anchors(depth);
  const sorted = [...REWRITE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, anchor } of sorted) {
    if (!spec.startsWith(prefix)) continue;
    // "./helpers/x" and "../helpers/x" both mean tests/helpers/x from the root; strip the
    // leading "./" or "../" and re-anchor.
    const stripped = prefix.startsWith("./") ? prefix.slice(2) : prefix.slice(3);
    const rest = spec.slice(prefix.length);
    const base = anchor === "tests" ? toTests : toRepo;
    return `${base}/${stripped}${rest}`;
  }
  return spec;
}

const SPECIFIER_SITES: ReadonlyArray<RegExp> = [
  // static import / export ... from "x", side-effect import "x"
  /(\bfrom\s*)(["'])([^"']+)\2/g,
  /(\bimport\s*)(["'])([^"']+)\2/g,
  // dynamic import("x"), typeof import("x"), require("x"), import.meta.resolve("x")
  /(\bimport\s*\(\s*)(["'])([^"']+)\2/g,
  /(\brequire\s*\(\s*)(["'])([^"']+)\2/g,
  /(\bimport\.meta\.resolve\s*\(\s*)(["'])([^"']+)\2/g,
  // new URL("x", import.meta.url)
  /(\bnew\s+URL\s*\(\s*)(["'])([^"']+)\2(?=\s*,\s*import\.meta\.url)/g,
];

/** Rewrite every relative specifier site in a source file for a test now `depth` below tests/. */
export function rewriteSource(source: string, depth: number): string {
  let out = source;
  for (const site of SPECIFIER_SITES) {
    out = out.replace(site, (whole, lead: string, quote: string, spec: string) => {
      const next = rewriteSpecifier(spec, depth);
      return next === spec ? whole : `${lead}${quote}${next}${quote}`;
    });
  }
  return out;
}

export const LOCAL_MARKER = "// layout: local";

/**
 * A path built from import.meta.dir that reaches outside the file's own directory:
 *   join(import.meta.dir, "..", ...)        join(import.meta.dir, "../src", ...)
 *   join(import.meta.dir, "helpers", ...)   resolve(import.meta.dir, "..")
 * The rewriter cannot express these (it only rewrites module specifiers and URL strings),
 * so they need a human. `new URL("../x", import.meta.url)` is NOT an escape: the rewriter
 * already re-anchored that string, and the leading "../" is what a correct rewrite looks like.
 */
const DIR_ESCAPE = /import\.meta\.dir\s*,\s*["'`](?:\.\.(?:["'`\/])|helpers\b|fixtures\b|src\/|gui\/|scripts\/|tests\/)/;
/** `fileURLToPath(new URL("../", import.meta.url))` and friends: a URL used as a directory root. */
const URL_ROOT_ESCAPE = /new\s+URL\s*\(\s*["'`](?:\.\.\/)+["'`]\s*,\s*import\.meta\.url/;

export interface EscapeHit {
  line: number;
  text: string;
  suppressed: boolean;
}

/**
 * Lines that use import.meta.dir / import.meta.url to leave the file's own directory. A
 * file-local use (`join(import.meta.dir, ".tmp-x")`) is not an escape. A line carrying the
 * `// layout: local` marker is reported as suppressed so reviewers can see it in the PR.
 */
export function scanEscapes(source: string): EscapeHit[] {
  const hits: EscapeHit[] = [];
  source.split("\n").forEach((text, index) => {
    if (!/import\.meta\.(dir|url)/.test(text)) return;
    if (!DIR_ESCAPE.test(text) && !URL_ROOT_ESCAPE.test(text)) return;
    hits.push({ line: index + 1, text, suppressed: text.includes(LOCAL_MARKER) });
  });
  return hits;
}

export function layoutDir(): string {
  return dirname(LAYOUT_PATH);
}
