import { homedir } from "node:os";

/**
 * Path segments a management response may show as they are. Everything else is `…`.
 *
 * The Connections view has to name files (the acceptance asks for the owning file), but any
 * segment the operator chose — a user name, an account id, a per-account directory, a token
 * someone used as a folder name — can identify them. Policy: the user's home prefix becomes
 * `~`, a drive letter stays, and only the fixed directory and file names OpenCodex, Codex and
 * Claude use are shown; consecutive masked segments collapse into one `…`.
 */
const SHOWN_SEGMENTS = new Set([
  "~", ".claude", ".codex", ".opencodex", ".config", "opencodex",
  "settings.json", "config.toml", "opencodex.config.toml", "opencodex-journal.json", "service-state.json",
  "Library", "Application Support", "Claude", "Claude-3p", "configLibrary", "AppData", "Roaming", "Local",
]);

export function displayPath(path: string, home: string = process.env.HOME?.trim() || homedir()): string {
  let shown = path;
  const trimmedHome = home.replace(/[\\/]+$/, "");
  if (trimmedHome && (path === trimmedHome || path.startsWith(`${trimmedHome}/`) || path.startsWith(`${trimmedHome}\\`))) {
    shown = `~${path.slice(trimmedHome.length)}`;
  }
  const parts = shown.split(/([\\/])/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "/" || part === "\\" || part === "") { out.push(part); continue; }
    const kept = SHOWN_SEGMENTS.has(part) || /^[A-Za-z]:$/.test(part);
    if (kept) { out.push(part); continue; }
    // Collapse "…/…" runs: the separator before this segment follows a previous mask.
    if (out.length >= 2 && out[out.length - 2] === "…" && (out[out.length - 1] === "/" || out[out.length - 1] === "\\")) {
      out.pop();
      continue;
    }
    out.push("…");
  }
  return out.join("");
}
