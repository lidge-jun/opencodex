import { existsSync, statSync } from "node:fs";

// The `bun` package leaves a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary. Keep the threshold and the
// false-on-filesystem-error contract shared by the Node launcher and Bun code.
export const REAL_BUN_MIN_BYTES = 1_000_000;

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isRealBunBinary(path) {
  try {
    return existsSync(path) && statSync(path).size >= REAL_BUN_MIN_BYTES;
  } catch {
    return false;
  }
}
