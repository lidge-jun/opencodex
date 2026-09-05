import { expect, test } from "bun:test";

function moduleSpecifiers(src: string): string[] {
  // Strip comments first so a forbidden path inside a comment cannot trip the
  // allowlist, and so comments cannot hide a real import.
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const specs: string[] = [];
  const spec = /(?:\b(?:from|import|export)\s*[({]*\s*)(["'])([^"']+)\1/g;
  for (const match of withoutComments.matchAll(spec)) {
    specs.push(match[2] ?? "");
  }
  return specs;
}

test("config-mutation-audit leaf has no imports back into config/routing/server", async () => {
  const src = await Bun.file(new URL("../src/config-mutation-audit.ts", import.meta.url)).text();
  // Keyword-anchored extraction (with whitespace/newlines between the keyword and
  // the specifier) covers named, multiline, side-effect, dynamic import(), and
  // re-export forms, so a path cannot slip past a line-based regex.
  const specs = moduleSpecifiers(src);
  expect(specs.length).toBeGreaterThan(0);
  for (const spec of specs) {
    // The leaf must stay acyclic: only Node/Bun builtins and lib/ (e.g.
    // ./lib/redact) are allowed; no parent-directory imports and no config,
    // routing, router, provider, or server modules.
    const allowed = spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("./lib/");
    expect(allowed, `forbidden import in leaf: ${spec}`).toBe(true);
  }
  expect(specs).toContain("./lib/redact");
  // The pure snapshot contract lives in the leaf so tests can target it directly.
  expect(src).toContain("export function buildConfigMutationSnapshot");
  expect(src).toContain("export function readConfigMutationAudit");
});
