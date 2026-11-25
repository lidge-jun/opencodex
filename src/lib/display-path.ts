import { homedir } from "node:os";

/**
 * A filesystem path as a management response may show it.
 *
 * The Connections view has to name files (the acceptance asks for the owning file), but a path
 * can carry identity: the user's home holds the account name, and a directory named after an
 * email address is common for per-account homes. Policy: the user's home prefix becomes `~`,
 * and any path segment containing `@` becomes `…`. Everything else is shown as is.
 */
export function displayPath(path: string, home: string = process.env.HOME?.trim() || homedir()): string {
  let shown = path;
  const trimmedHome = home.replace(/[\\/]+$/, "");
  if (trimmedHome && (path === trimmedHome || path.startsWith(`${trimmedHome}/`) || path.startsWith(`${trimmedHome}\\`))) {
    shown = `~${path.slice(trimmedHome.length)}`;
  }
  return shown.split(/([\\/])/).map(segment => segment.includes("@") ? "…" : segment).join("");
}
