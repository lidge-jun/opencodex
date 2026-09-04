import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskNonCode, specifierSites, tokenize } from "./tokens";

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

/** Rewrite every relative specifier in specifier position for a test now `depth` below tests/. */
export function rewriteSource(source: string, depth: number): string {
  const sites = specifierSites(source);
  let out = "";
  let cursor = 0;
  for (const site of sites) {
    const next = rewriteSpecifier(site.spec, depth);
    if (next === site.spec) continue;
    out += source.slice(cursor, site.token.start) + site.quote + next + site.quote;
    cursor = site.token.end;
  }
  return out + source.slice(cursor);
}

export const LOCAL_MARKER = "// layout: local";

const HELPER_NAMES = ["fixturePath", "helperPath", "repoPath", "repoRoot"] as const;

/**
 * The source with comments, templates and regex bodies blanked but string literals kept, so
 * rewrite rules can read `".."` arguments while never matching inside a comment or template.
 */
function maskKeepStrings(source: string, tokens = tokenize(source)): string {
  let out = "";
  for (const token of tokens) {
    const text = source.slice(token.start, token.end);
    out += token.kind === "code" || token.kind === "string" ? text : text.replace(/[^\n]/g, " ");
  }
  return out;
}

/**
 * Rewrite `import.meta.dir`-anchored escapes into repo-root helper calls, in code only:
 *   join|resolve(import.meta.dir, "..")                    -> repoRoot()
 *   join|resolve(import.meta.dir, "..", "src", "x.ts")     -> repoPath("src", "x.ts")
 *   join|resolve(import.meta.dir, "../src/x.ts")           -> repoPath("src/x.ts")
 *   join|resolve(import.meta.dir, "helpers", "c.ts")       -> helperPath("c.ts")
 *   fileURLToPath(new URL("../", import.meta.url))         -> repoRoot()
 *   resolve(dirname(fileURLToPath(import.meta.url)), "..") -> repoRoot()
 * A file that already declares a binding named repoRoot / repoPath / helperPath is left
 * untouched for the escape scanner (rewriting it would shadow the import). The helper import
 * is added after the last top-level import statement.
 */
export function rewriteMetaDirEscapes(source: string, depth: number): { source: string; rewrites: number } {
  const tokens = tokenize(source);
  const code = maskNonCode(source, tokens);
  const view = maskKeepStrings(source, tokens);
  // `const repoRoot = join(import.meta.dir, "..")` is the commonest escape of all: rebind the
  // local through an aliased import instead of refusing the file. Any other local named like a
  // helper (or a function) still stops the rewrite so nothing gets shadowed.
  const localRoot = /\bconst\s+repoRoot\s*=\s*(?:(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"\.\."\s*\)|fileURLToPath\(\s*new\s+URL\(\s*"(?:\.\.\/)+"\s*,\s*import\.meta\.url\s*\)\s*\)|resolve\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*"\.\."\s*\))\s*;/;
  const rebindsRoot = localRoot.test(view);
  const otherLocals = new RegExp(`\\b(?:const|let|var|function)\\s+(?:${HELPER_NAMES.filter(n => !(rebindsRoot && n === "repoRoot")).join("|")})\\b`);
  if (otherLocals.test(code)) return { source, rewrites: 0 };
  const rules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [new RegExp(localRoot.source, "g"), () => "const repoRoot = resolveRepoRoot();"],
    // `const root = new URL("../../", import.meta.url)` -> a file URL of the repository root.
    [/\bconst\s+root\s*=\s*new\s+URL\(\s*"(?:\.\.\/)+"\s*,\s*import\.meta\.url\s*\)\s*;/g, () => 'const root = pathToFileURL(repoRoot() + "/");'],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"\.\."\s*\)/g, () => "repoRoot()"],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"\.\."\s*,\s*/g, () => "repoPath("],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"\.\.\/([^"]+)"/g, m => `repoPath("${m[1]}"`],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"helpers"\s*,\s*/g, () => "helperPath("],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"helpers\/([^"]+)"/g, m => `helperPath("${m[1]}"`],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"fixtures"\s*,\s*/g, () => "fixturePath("],
    [/\b(?:join|resolve)\(\s*import\.meta\.dir\s*,\s*"fixtures\/([^"]+)"/g, m => `fixturePath("${m[1]}"`],
    [/\bfileURLToPath\(\s*new\s+URL\(\s*"\.\.\/"\s*,\s*import\.meta\.url\s*\)\s*\)/g, () => rootCall],
    [/\bresolve\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*"\.\."\s*\)/g, () => rootCall],
  ];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [re, build] of rules) {
    for (const m of view.matchAll(re)) edits.push({ start: m.index!, end: m.index! + m[0].length, text: build(m) });
  }
  if (edits.length === 0) return { source, rewrites: 0 };
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let applied = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
    applied += 1;
  }
  out += source.slice(cursor);
  const codeOut = maskNonCode(out);
  const used: string[] = HELPER_NAMES.filter(name => new RegExp(`\\b${name}\\(`).test(codeOut) && !(rebindsRoot && name === "repoRoot"));
  if (rebindsRoot) used.push("repoRoot as resolveRepoRoot");
  if (/\bpathToFileURL\((?:resolveRepoRoot|repoRoot)\(\)/.test(codeOut) && !/\bimport\s*\{[^}]*\bpathToFileURL\b[^}]*\}\s*from\s*["']node:url["']/.test(view)) {
    out = insertAfterImports(out, 'import { pathToFileURL } from "node:url";');
  }
  const existing = /^import\s*\{([^}]*)\}\s*from\s*(["'])([^"']*helpers\/repo-root)\2;?/m.exec(maskKeepStrings(out));
  if (existing) {
    // Augment a partial import rather than adding a second one.
    const names = new Set(existing[1]!.split(",").map(s => s.trim()).filter(Boolean));
    for (const name of used) names.add(name);
    const line = `import { ${[...names].sort().join(", ")} } from ${existing[2]}${existing[3]}${existing[2]};`;
    out = out.slice(0, existing.index) + line + out.slice(existing.index + existing[0].length);
  } else {
    const { toTests } = anchors(depth);
    out = insertAfterImports(out, `import { ${used.join(", ")} } from "${toTests}/helpers/repo-root";`);
  }
  return { source: out, rewrites: applied };
}

/**
 * Insert a line after the leading block of top-level import / export-from statements: the
 * run of such statements that starts at the top of the file (comments and blank lines
 * allowed between them). An import that appears later, after real code, is not part of that
 * block, so the helper never lands at the bottom of a file that happens to end with an import.
 */
export function insertAfterImports(source: string, line: string): string {
  const tokens = tokenize(source);
  const masked = maskNonCode(source, tokens);
  let insertAt = 0;
  let cursor = 0;
  const n = masked.length;
  while (cursor < n) {
    // Skip blank lines (comments are already blanked in `masked`).
    const lineEnd = masked.indexOf("\n", cursor);
    const lineStop = lineEnd === -1 ? n : lineEnd;
    const text = masked.slice(cursor, lineStop);
    if (text.trim() === "") { cursor = lineStop + 1; continue; }
    if (!/^(?:import|export)\b/.test(text) || /^(?:import|export)\s*\(/.test(text)) break;
    // Statement ends at the first ";" or, failing that, the end of the line holding the closing quote.
    const site = specifierSites(source, tokens).find(s => s.token.start >= cursor);
    const specEnd = site ? site.token.end : lineStop;
    const semi = masked.indexOf(";", specEnd);
    const nl = masked.indexOf("\n", specEnd);
    const stop = semi !== -1 && (nl === -1 || semi <= nl) ? semi : specEnd;
    const eol = masked.indexOf("\n", stop);
    insertAt = eol === -1 ? n : eol + 1;
    cursor = insertAt;
  }
  return source.slice(0, insertAt) + line + "\n" + source.slice(insertAt);
}

/** A string argument that leaves the file's directory toward the repo or the tests/ siblings. */
const ESCAPE_ARG = /^["'](?:\.\.(?:["'\/])|helpers\b|fixtures\b|src\/|gui\/|scripts\/|tests\/)/;
/** `new URL("../", import.meta.url)`: a URL used as a directory root, not a re-anchored specifier. */
const URL_ROOT = /new\s+URL\s*\(\s*(["'])(?:\.\.\/)+\1\s*,\s*import\.meta\.url/;

export interface EscapeHit {
  line: number;
  text: string;
  suppressed: boolean;
}

/**
 * Statements (code only, up to the next `;`) that combine `import.meta.dir` / `import.meta.url`
 * with a parent-directory or tests-sibling string argument, plus template literals that
 * interpolate `import.meta.dir` with such a path. A re-anchored `new URL("../../x",
 * import.meta.url)` specifier is what a correct rewrite looks like and is not an escape; a bare
 * `new URL("../", ...)` root is. File-local uses (`join(import.meta.dir, ".tmp-x")`) pass. A
 * statement carrying `// layout: local` is reported as suppressed.
 */
export function scanEscapes(source: string): EscapeHit[] {
  const tokens = tokenize(source);
  const masked = maskNonCode(source, tokens);
  const view = maskKeepStrings(source, tokens);
  const stringTokens = tokens.filter(t => t.kind === "string");
  const lines = source.split("\n");
  const hits = new Map<number, EscapeHit>();
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const report = (start: number, end: number) => {
    const line = lineOf(start);
    if (hits.has(line)) return;
    const region = source.slice(start, end);
    const text = lines[line - 1] ?? "";
    hits.set(line, { line, text, suppressed: region.includes(LOCAL_MARKER) || text.includes(LOCAL_MARKER) });
  };
  for (const m of masked.matchAll(/import\.meta\.(?:dir|url)/g)) {
    const at = m.index!;
    const back = Math.max(masked.lastIndexOf(";", at) + 1, masked.lastIndexOf("\n\n", at), 0);
    const fwd = masked.indexOf(";", at);
    const end = fwd === -1 ? source.length : fwd + 1;
    const stmt = view.slice(back, end);
    const strings = stringTokens.filter(t => t.start >= back && t.end <= end).map(t => source.slice(t.start, t.end));
    const urlSpec = /new\s+URL\s*\(\s*(["'][^"']*["'])\s*,\s*import\.meta\.url/.exec(stmt)?.[1];
    const escapes = strings.some(str => str !== urlSpec && ESCAPE_ARG.test(str));
    // new URL(<variable>, import.meta.url): the specifier lives somewhere the rewriter cannot
    // see, so a human has to look.
    const variableUrl = /new\s+URL\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*import\.meta\.url/.test(stmt);
    if (escapes || variableUrl || URL_ROOT.test(stmt)) report(at, end);
  }
  for (const t of tokens) {
    if (t.kind !== "template") continue;
    const text = source.slice(t.start, t.end);
    if (/\$\{\s*import\.meta\.dir\s*\}\/(?:\.\.|helpers\b|fixtures\b)/.test(text)) report(t.start, t.end);
  }
  return [...hits.values()].sort((a, b) => a.line - b.line);
}

export function layoutDir(): string {
  return dirname(LAYOUT_PATH);
}


