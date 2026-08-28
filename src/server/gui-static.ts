import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { browserSecurityHeaders } from "./auth-cors";
import type { GuiSessionBootstrap } from "./management-auth";

/** opencodex version, read from the packaged package.json (same source as the server bootstrap). */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon",
};

function findGuiDist(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "gui", "dist"),
    join(import.meta.dir, "..", "..", "..", "gui", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

export function resolveGuiFilePath(guiDist: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const relativePath = decodedPath === "/" || decodedPath === ""
    ? "index.html"
    : decodedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = resolve(guiDist);
  const filePath = resolve(root, relativePath);
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** HTML-attribute escape for values interpolated into meta tags. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Shared session meta-tag block, escaped for quoted attribute interpolation. */
function sessionBootstrapMeta(session: GuiSessionBootstrap): string {
  return [
    `<meta name="opencodex-session-token" content="${escapeHtmlAttribute(session.token)}">`,
    `<meta name="opencodex-session-csrf" content="${escapeHtmlAttribute(session.csrfToken)}">`,
    `<meta name="opencodex-session-origin" content="${escapeHtmlAttribute(session.origin)}">`,
  ].join("");
}

function htmlDocumentResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...browserSecurityHeaders(),
    },
  });
}

function htmlResponse(path: string, session?: GuiSessionBootstrap): Response {
  let html = readFileSync(path, "utf8");
  if (session) {
    const bootstrap = sessionBootstrapMeta(session);
    html = html.includes("</head>") ? html.replace("</head>", `${bootstrap}</head>`) : `${bootstrap}${html}`;
  }
  return htmlDocumentResponse(html);
}

/**
 * Minimal session-bootstrap document, independent of any packaged GUI build. The dev
 * GUI (Vite) proxies /opencodex-session to the backend with the original host so the
 * backend can mint an origin-bound loopback session even when gui/dist does not exist.
 */
export function serveSessionBootstrap(session: GuiSessionBootstrap): Response {
  const bootstrap = sessionBootstrapMeta(session);
  const html = `<!doctype html><html><head><meta charset="utf-8">${bootstrap}</head><body></body></html>`;
  return htmlDocumentResponse(html);
}

export function serveGuiFile(
  pathname: string,
  guiDist = findGuiDist(),
  session?: GuiSessionBootstrap,
): Response | null {
  if (!guiDist) return null;
  const filePath = resolveGuiFilePath(guiDist, pathname);
  if (!filePath) return null;

  if (!isFile(filePath)) {
    if (!extname(pathname)) {
      const indexPath = join(guiDist, "index.html");
      if (isFile(indexPath)) {
        return htmlResponse(indexPath, session);
      }
    }
    return null;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  if (ext === ".html") return htmlResponse(filePath, session);
  // Snapshot bytes before returning the response. Bun.file is lazy: if gui/dist is replaced
  // after Bun frames the response but before the stream finishes, its Content-Length can
  // describe the old file while the body comes from the new one (#2792).
  return new Response(readFileSync(filePath), {
    headers: { "Content-Type": contentType, ...browserSecurityHeaders() },
  });
}

export function rootFallbackPayload() {
  return {
    status: "ok",
    service: "opencodex",
    version: VERSION,
    dashboard: {
      available: false,
      reason: "GUI build not found. Run `bun run build:gui` from the opencodex repo, or use `ocx gui` from a packaged install.",
    },
    endpoints: {
      health: "/healthz",
      models: "/v1/models",
      responses: "/v1/responses",
      chatCompletions: "/v1/chat/completions",
      management: "/api/*",
    },
  };
}
