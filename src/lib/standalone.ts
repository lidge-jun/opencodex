import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/** Compiled Bun binaries expose their bundled module tree through the `$bunfs` marker. */
export function isStandaloneBinary(): boolean {
  return isStandaloneModuleUrl(import.meta.url);
}

export function isStandaloneModuleUrl(url: string): boolean {
  return url.includes("/$bunfs/") || /^file:\/\/\/[A-Za-z]:\/~BUN\//.test(url);
}

/** Directory containing the compiled executable and its copied runtime assets. */
export function standaloneRoot(): string {
  return dirname(realpathSync(process.execPath));
}
