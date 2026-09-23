/**
 * Every hard-coded link to the public docs has to land on a page the site actually builds.
 *
 * https://opencodex.me/guides/macos-menu-bar/ was reported as a 404 from outside the project. The
 * live cause was a cancelled deploy, but the same review found a guide linking to
 * /opencodex/guides/macos-menu-bar/ - the old GitHub Pages project path - which 404s on the custom
 * domain no matter how often the site is deployed.
 *
 * Two layers guard this, because CI reaches the sources through different jobs:
 *
 * - docs-site/src/integrations/internal-links.mjs runs inside the Astro build (the CI docs job and
 *   Deploy Docs) and checks every rendered href, src and fragment. A docs-only pull request never
 *   starts this Bun suite, so that is where docs content is checked.
 * - This file checks the URLs other surfaces hard-code - README, the locale READMEs, src/, gui/src/,
 *   skills/ - against the content tree, and pins the resolver behaviour the build check relies on.
 *
 * Not checked here: fragments on hard-coded URLs (only the rendered pages carry the real heading
 * ids).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { repoPath } from "../helpers/repo-root";

type PageScan = { ids: ReadonlySet<string>; links: readonly string[] };
type BrokenLink = { page: string; href: string; reason: string };
type InternalLinks = {
  internalTarget(value: string, base: string): { path: string; fragment: string } | null;
  scanHtml(html: string): PageScan;
  checkInternalLinks(files: ReadonlySet<string>, pages: ReadonlyMap<string, PageScan>): { checked: number; broken: BrokenLink[] };
};

const CONTENT = repoPath("docs-site/src/content/docs");
const PUBLIC = repoPath("docs-site/public");
const URL_PATTERN = /https:\/\/(opencodex\.me|lidge-jun\.github\.io\/opencodex)(\/[^\s"'<>)\]\x60]*)?/g;
const SKIPPED_URL = /\$\{|\.(?:xml|png|jpe?g|gif|svg|ico|txt|webp)$/;
const SURFACE_DIRS = ["readme", "src", "gui/src", "skills", "docs-site/src/components", ".github/ISSUE_TEMPLATE"];
const SURFACE_EXTENSIONS = /\.(?:md|mdx|ts|tsx|json|astro|mjs|ya?ml)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function localeKeys(): string[] {
  const config = readFileSync(repoPath("docs-site/astro.config.mjs"), "utf8");
  const block = /locales:\s*\{([\s\S]*?)\n\s*\},/.exec(config);
  if (!block) throw new Error("astro.config.mjs has no locales block");
  return [...block[1].matchAll(/^\s*"?([a-z]{2}(?:-[a-z]{2})?)"?\s*:/gm)]
    .map(match => match[1])
    .filter(key => key !== "root");
}

function routeTable(): Set<string> {
  const routes = new Set<string>();
  for (const file of walk(CONTENT)) {
    if (!/\.mdx?$/.test(file)) continue;
    const route = relative(CONTENT, file).split("\\").join("/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
    // Astro serves slugs in lower case; a URL is checked against them exactly, so /Guides/ fails.
    routes.add(route.toLowerCase());
  }
  return routes;
}

const ROUTES = routeTable();
const LOCALES = localeKeys();

/** Resolves a site path the way the built site serves it, including Starlight's locale fallback. */
function resolvesOnSite(sitePath: string): boolean {
  const path = decodeURI(sitePath).replace(/^\/+|\/+$/g, "");
  if (path !== "" && existsSync(join(PUBLIC, path))) return true;
  if (ROUTES.has(path)) return true;
  const [first, ...rest] = path.split("/");
  return LOCALES.includes(first) && ROUTES.has(rest.join("/"));
}

function sitePathOf(url: string): string {
  const parsed = new URL(url);
  let path = parsed.pathname;
  if (parsed.hostname === "lidge-jun.github.io") path = path.slice("/opencodex".length) || "/";
  return path;
}

function hardCodedUrls(): Array<{ where: string; url: string }> {
  const files = [
    ...readdirSync(repoPath(".")).filter(name => /\.md$/.test(name) || name === "package.json").map(name => repoPath(name)),
    ...SURFACE_DIRS.flatMap(dir => walk(repoPath(dir)).filter(file => SURFACE_EXTENSIONS.test(file))),
  ];
  const found: Array<{ where: string; url: string }> = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(URL_PATTERN)) {
        const url = match[0].replace(/[.,;:]+$/, "");
        if (SKIPPED_URL.test(url.split("#")[0])) continue;
        found.push({ where: relative(repoPath("."), file) + ":" + (index + 1), url });
      }
    });
  }
  return found;
}

async function loadIntegration(): Promise<InternalLinks> {
  return (await import(repoPath("docs-site/src/integrations/internal-links.mjs"))) as InternalLinks;
}

describe("docs link targets", () => {
  test("CI selects hard-coded URL checks for README, skills, and issue-template edits", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/ci.yml"), "utf8")) as {
      on?: { push?: { paths?: string[] } };
      jobs?: { changes?: { steps?: Array<{ uses?: string; with?: { filters?: string } }> } };
    };
    const filter = workflow.jobs?.changes?.steps?.find(step => step.uses?.startsWith("dorny/paths-filter@"));
    const ciPaths = (Bun.YAML.parse(filter?.with?.filters ?? "") as { ci?: string[] }).ci ?? [];
    for (const path of ["readme/**", "skills/**", ".github/ISSUE_TEMPLATE/**"]) {
      expect(ciPaths).toContain(path);
      expect(workflow.on?.push?.paths).toContain(path);
    }
  });

  test("every hard-coded docs URL names a page the site builds", () => {
    const urls = hardCodedUrls();
    // An extractor that silently matched nothing would pass the check below.
    expect(urls.length).toBeGreaterThan(20);
    const broken = urls.filter(({ url }) => !resolvesOnSite(sitePathOf(url)));
    expect(broken.map(({ where, url }) => where + " " + url)).toEqual([]);
  });

  test("locale URLs fall back to English pages, and the old project prefix does not resolve", () => {
    expect(LOCALES).toEqual(expect.arrayContaining(["fr", "ja", "ko", "ru", "tr", "zh-cn", "zh-tw"]));
    expect(resolvesOnSite(sitePathOf("https://opencodex.me/guides/macos-menu-bar/"))).toBe(true);
    expect(resolvesOnSite(sitePathOf("https://opencodex.me/ko/guides/desktop-app/"))).toBe(true);
    expect(resolvesOnSite(sitePathOf("https://opencodex.me/opencodex/guides/macos-menu-bar/"))).toBe(false);
    expect(resolvesOnSite(sitePathOf("https://opencodex.me/Guides/Providers/"))).toBe(false);
    expect(resolvesOnSite(sitePathOf("https://lidge-jun.github.io/opencodex/guides/cursor-private-inference/"))).toBe(true);
    expect(resolvesOnSite("/favicon.png")).toBe(true);
  });

  test("the build check resolves links the way the site serves them", async () => {
    const { internalTarget } = await loadIntegration();
    const server = "https://opencodex.me/reference/configuration/server/";
    expect(internalTarget("/guides/macos-menu-bar/", server)).toEqual({ path: "/guides/macos-menu-bar/", fragment: "" });
    expect(internalTarget("../../guides/codex-integration.md#steering", server)).toEqual({
      path: "/reference/guides/codex-integration.md",
      fragment: "steering",
    });
    expect(internalTarget("#remote-access", server)).toEqual({ path: "/reference/configuration/server/", fragment: "remote-access" });
    expect(internalTarget("https://lidge-jun.github.io/opencodex/guides/pi/", server)).toEqual({ path: "/guides/pi/", fragment: "" });
    expect(internalTarget("https://github.com/lidge-jun/opencodex", server)).toBeNull();
    expect(internalTarget("mailto:someone@example.com", server)).toBeNull();
    expect(internalTarget("/_astro/page.css", server)).toBeNull();
    expect(internalTarget("&#47;guides/pi/", server)).toEqual({ path: "/guides/pi/", fragment: "" });
    expect(internalTarget("/guides/pi/?a=1&amp;b=2#x", server)).toEqual({ path: "/guides/pi/", fragment: "x" });
  });

  test("the build check reads every attribute quoting form", async () => {
    const { scanHtml } = await loadIntegration();
    const scan = scanHtml("<h2 id='one'>x</h2><h3 id=two>y</h3><a href=\"/a/\">a</a><a href='/b/'>b</a><img src=/c.png>");
    expect([...scan.ids]).toEqual(["one", "two"]);
    expect(scan.links).toEqual(["/a/", "/b/", "/c.png"]);
  });

  test("the build check reports missing pages and fragments, exempting only the 404 page locale picker", async () => {
    const { checkInternalLinks } = await loadIntegration();
    const files = new Set(["/guides/macos-menu-bar/index.html", "/guides/desktop-app/index.html", "/404.html", "/favicon.png"]);
    const pages = new Map<string, PageScan>([
      ["/guides/macos-menu-bar/index.html", { ids: new Set(["widget"]), links: [] }],
      [
        "/guides/desktop-app/index.html",
        {
          ids: new Set(["install"]),
          links: [
            "/guides/macos-menu-bar/",
            "/guides/macos-menu-bar",
            "/guides/macos-menu-bar/#widget",
            "#install",
            "/favicon.png",
            "/opencodex/guides/macos-menu-bar/",
            "/guides/macos-menu-bar/#missing",
            "#missing",
          ],
        },
      ],
      ["/404.html", { ids: new Set(), links: ["/ko/404/", "/zh-cn/404/", "/guides/desktop-app/", "/guides/removed/"] }],
    ]);
    const { checked, broken } = checkInternalLinks(files, pages);
    expect(checked).toBe(10);
    expect(broken).toEqual([
      { page: "/guides/desktop-app/index.html", href: "/opencodex/guides/macos-menu-bar/", reason: "missing-page" },
      { page: "/guides/desktop-app/index.html", href: "/guides/macos-menu-bar/#missing", reason: "missing-fragment" },
      { page: "/guides/desktop-app/index.html", href: "#missing", reason: "missing-fragment" },
      { page: "/404.html", href: "/guides/removed/", reason: "missing-page" },
    ]);
  });

  test("the docs site build runs the check", () => {
    const config = readFileSync(repoPath("docs-site/astro.config.mjs"), "utf8");
    expect(config).toContain('from "./src/integrations/internal-links.mjs"');
    expect(config).toMatch(/internalLinks\(\)/);
  });
});
