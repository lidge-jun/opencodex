/**
 * The one way a management route installs a new `claudeCode` block on the live config.
 *
 * Every writer stamps the auth-mode migration sentinel. `runClaudeAuthModeMigration` reads a
 * block with no `authMode` and no sentinel as a pre-upgrade subscriber and pins it to literal
 * subscription, so a route that CREATES the block (a bare `{ enabled }` toggle) without the
 * sentinel silently converts an Auto user on the next start. Persisting stays with the caller,
 * through `saveConfigPreservingClaudeCode`, whose baseline guard keeps a concurrent hand edit
 * of the block unless this process changed it too.
 */
import type { OcxClaudeCodeConfig, OcxConfig } from "../types";

export function commitClaudeCodeBlock(config: OcxConfig, next: OcxClaudeCodeConfig, now = new Date()): void {
  if (!next.authModeMigratedAt) next.authModeMigratedAt = now.toISOString();
  config.claudeCode = next;
}
