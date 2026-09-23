// @ts-check
/**
 * Build-time internal link check for the docs site.
 *
 * opencodex.me shipped a guide link to /opencodex/guides/macos-menu-bar/, a leftover of the
 * GitHub Pages project path, and the configuration reference split left dozens of
 * /reference/configuration/#… fragments pointing at headings that had moved to subpages. Nothing
 * failed, because nothing looked at the generated site. This integration reads the HTML Astro
 * just wrote and refuses the build when an internal href or src names a file the build did not
 * produce, or a fragment the target page does not carry.
 *
 * It runs wherever the site is built: the CI docs job on every pull request touching docs-site/,
 * and the Deploy Docs build before publishing. It checks what is in the generated HTML, so links
 * assembled by client-side scripts and links to other hosts are outside it.
 *
 * The resolver is exported without any Astro import so the repository's Bun suite can exercise it
 * with fixtures (tests/ci-workflows/docs-link-targets.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_ORIGIN = "https://opencodex.me";
const CANONICAL_HOST = "opencodex.me";
// GitHub redirects the former project site to the custom domain with the prefix removed.
const LEGACY_HOST = "lidge-jun.github.io";
const LEGACY_PREFIX = "/opencodex";
const UNCHECKED_PREFIXES = ["/_astro/", "/pagefind/"];
// Starlight builds one root 404.html, but its language picker there links /<locale>/404/, which it
// never builds. Only those links, and only on that page, are exempt; its other links are checked.
const GENERATED_NOT_FOUND_PAGE = "/404.html";
const LOCALE_NOT_FOUND_PATH = /^\/[a-z]{2}(?:-[a-z]{2})?\/404\/?$/;

const NAMED_ENTITIES = /** @type {Record<string, string>} */ ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" });

/**
 * Attribute values arrive HTML-encoded. Numeric references matter as much as named ones:
 * href="&#47;guides/pi/" is the path /guides/pi/.
 * @param {string} value
 */
export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Double-quoted, single-quoted and unquoted attribute values are all valid HTML.
const ATTRIBUTE = /\s(href|src|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/gi;

/**
 * The URL a page is served at, used as the base for its relative links.
 * @param {string} page dist-relative path with a leading slash, e.g. /guides/x/index.html
 */
export function pageUrl(page) {
  return SITE_ORIGIN + page.replace(/index\.html$/, "");
}

/**
 * Reduce an href or src to a site path and fragment, or null when it is not this site's.
 * @param {string} value attribute value as written in the HTML
 * @param {string} base URL of the page containing it
 * @returns {{ path: string, fragment: string } | null}
 */
export function internalTarget(value, base) {
  const raw = decodeEntities(value).trim();
  if (raw === "" || /^(mailto|data|javascript|tel):/i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  let path = url.pathname;
  if (url.hostname === LEGACY_HOST && (path === LEGACY_PREFIX || path.startsWith(LEGACY_PREFIX + "/"))) {
    path = path.slice(LEGACY_PREFIX.length) || "/";
  } else if (url.hostname !== CANONICAL_HOST) {
    return null;
  }
  if (UNCHECKED_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  let fragment = "";
  if (url.hash.length > 1) {
    try {
      fragment = decodeURIComponent(url.hash.slice(1));
    } catch {
      fragment = url.hash.slice(1);
    }
  }
  try {
    path = decodeURI(path);
  } catch {
    // keep the encoded form; it will simply not match a file
  }
  return { path, fragment };
}

/**
 * The generated file a site path is served from, or null.
 * @param {ReadonlySet<string>} files dist-relative paths with a leading slash
 * @param {string} path
 */
export function resolveFile(files, path) {
  if (files.has(path)) return path;
  const trimmed = path.replace(/\/+$/, "");
  if (files.has(trimmed + "/index.html")) return trimmed + "/index.html";
  if (trimmed !== "" && files.has(trimmed + ".html")) return trimmed + ".html";
  return null;
}

/**
 * @typedef {{ ids: ReadonlySet<string>, links: readonly string[] }} PageScan
 * @typedef {{ page: string, href: string, reason: "missing-page" | "missing-fragment" }} BrokenLink
 */

/**
 * @param {string} html
 * @returns {PageScan}
 */
export function scanHtml(html) {
  const ids = new Set();
  const links = [];
  for (const match of html.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[1].toLowerCase() === "id") ids.add(decodeEntities(value));
    else links.push(value);
  }
  return { ids, links };
}

/**
 * @param {ReadonlySet<string>} files every generated file, dist-relative with a leading slash
 * @param {ReadonlyMap<string, PageScan>} pages every generated HTML page
 * @returns {{ checked: number, broken: BrokenLink[] }}
 */
export function checkInternalLinks(files, pages) {
  /** @type {BrokenLink[]} */
  const broken = [];
  let checked = 0;
  for (const [page, scan] of pages) {
    const base = pageUrl(page);
    for (const href of scan.links) {
      const target = internalTarget(href, base);
      if (!target) continue;
      const file = resolveFile(files, target.path);
      if (!file && page === GENERATED_NOT_FOUND_PAGE && LOCALE_NOT_FOUND_PATH.test(target.path)) continue;
      checked += 1;
      if (!file) {
        broken.push({ page, href, reason: "missing-page" });
        continue;
      }
      if (target.fragment === "" || !file.endsWith(".html")) continue;
      const ids = pages.get(file)?.ids;
      if (!ids?.has(target.fragment)) broken.push({ page, href, reason: "missing-fragment" });
    }
  }
  return { checked, broken };
}

/** @param {string} dir */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/** @returns {import("astro").AstroIntegration} */
export default function internalLinks() {
  return {
    name: "opencodex-internal-links",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const files = new Set();
        /** @type {Map<string, PageScan>} */
        const pages = new Map();
        for (const absolute of listFiles(root)) {
          const rel = "/" + relative(root, absolute).split(sep).join("/");
          files.add(rel);
          if (rel.endsWith(".html")) pages.set(rel, scanHtml(readFileSync(absolute, "utf8")));
        }
        const { checked, broken } = checkInternalLinks(files, pages);
        if (broken.length === 0) {
          logger.info("checked " + checked + " internal links across " + pages.size + " pages");
          return;
        }
        const lines = broken.map((b) => "  " + b.page + " -> " + b.href + " (" + b.reason + ")");
        throw new Error(
          broken.length + " broken internal link(s) in the generated site:\n" + lines.join("\n"),
        );
      },
    },
  };
}
