import { test } from "bun:test";
import { API } from "typescript/unstable/sync";

/**
 * Parser for the auxiliary update lint (known-pattern regression checks, not a security
 * boundary). TypeScript 7's sync client reads its child's stdio through Node stream
 * handles on POSIX, which Bun does not expose, so the client cannot start there. Only that
 * known POSIX startup failure yields null; any other failure, and every failure on
 * Windows, still throws. Runtime guard tests never depend on this parser.
 */
export function openUpdateLintParser(): API | null {
  try { return new API(); }
  catch (error) {
    if (process.platform !== "win32" && error instanceof TypeError && /_handle/.test(error.message)) return null;
    throw error;
  }
}

/** A lint case that runs only where the sync parser could start. */
export const lintTest = (api: API | null) => test.skipIf(api === null);
