import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Load the classic dashboard's page sources under Bun with the same module resolution its
 * Vite build uses (`gui/vite.classic.config.ts`).
 *
 * `classic/src` holds only the files the redesign changed, and those files still import their
 * neighbours as if they sat in `src/`. Vite's overlay plugin rewrites that at build time; Bun
 * has no such plugin, so a plain `import("../classic/src/pages/Logs")` dies on
 * `../i18n/shared`. This loader reproduces the rule — an import resolves to the classic copy
 * when one exists, otherwise to `src/` — so a test exercises the shipped classic page instead
 * of a copy of it.
 */
const GUI_ROOT = join(import.meta.dir, "..", "..");
const SRC = join(GUI_ROOT, "src");
const CLASSIC = join(GUI_ROOT, "classic", "src");
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.[^"']*)\2/g;

const inside = (root: string, path: string): string | null => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : null;
};

let installed = false;

/** Idempotent: Bun keeps one plugin registry per process. */
export function installClassicSourceOverlay(): void {
  if (installed) return;
  installed = true;
  Bun.plugin({
    name: "opencodex-classic-source-overlay",
    setup(build) {
      build.onLoad({ filter: /classic[\\/]src[\\/].*\.(ts|tsx)$/ }, args => {
        const rel = inside(CLASSIC, args.path);
        if (!rel) return undefined;
        const asIfSrc = join(SRC, rel);
        const rewritten = readFileSync(args.path, "utf8").replace(
          RELATIVE_SPECIFIER,
          (match, lead: string, quote: string, specifier: string) => {
            const target = resolve(dirname(asIfSrc), specifier);
            const hit = RESOLVE_EXTENSIONS
              .map(extension => target + extension)
              .find(candidate => existsSync(candidate) && !candidate.endsWith(sep));
            if (!hit) return match;
            const relToSrc = inside(SRC, hit);
            const resolved = relToSrc && existsSync(join(CLASSIC, relToSrc)) ? join(CLASSIC, relToSrc) : hit;
            return `${lead}${quote}${resolved}${quote}`;
          },
        );
        return { contents: rewritten, loader: "tsx" };
      });
      // The classic page imports stylesheets, which the build handles and Bun cannot.
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    },
  });
}
