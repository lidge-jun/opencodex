import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/** Compiled Bun binaries expose their bundled module tree through the `$bunfs` marker. */
export function isStandaloneBinary(): boolean {
  return isStandaloneModuleUrl(import.meta.url);
}

export function isStandaloneModuleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || parsed.host !== "") return false;
    // Bun may encode the Windows virtual root's tilde; decode one URL layer only.
    const path = decodeURIComponent(parsed.pathname);
    return path.startsWith("/$bunfs/") || /^\/[A-Za-z]:\/~BUN\//.test(path);
  } catch {
    return false;
  }
}

/** Directory containing the compiled executable and its copied runtime assets. */
export function standaloneRoot(): string {
  return dirname(realpathSync(process.execPath));
}
