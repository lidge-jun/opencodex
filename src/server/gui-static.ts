import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

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

export function serveGuiFile(pathname: string): Response | null {
  const guiDist = findGuiDist();
  if (!guiDist) return null;
  const filePath = resolveGuiFilePath(guiDist, pathname);
  if (!filePath) return null;

  if (!isFile(filePath)) {
    if (!extname(pathname)) {
      const indexPath = join(guiDist, "index.html");
      if (isFile(indexPath)) {
        return new Response(Bun.file(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }
    return null;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType },
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
      management: "/api/*",
    },
  };
}
