/**
 * One-time authMode migration (devlog/_plan/260726_claude_auth_auto/015).
 *
 * Before auto existed, choosing "Subscription" in the GUI DELETED the key. So on disk
 * an explicit subscription choice and "never chose anything" are byte-identical, and
 * reading both as auto would flip a deliberate subscriber into proxy mode the moment
 * their credentials are undetectable. This migration preserves the old EFFECTIVE
 * behaviour for configs that already had a claudeCode block, and leaves genuinely
 * untouched configs on auto.
 */
import type { OcxConfig } from "../types";

/**
 * @returns true when the config changed and the caller should persist it.
 */
export function runClaudeAuthModeMigration(config: OcxConfig, now = new Date()): boolean {
  const claudeCode = config.claudeCode;
  // No block at all = a fresh or Claude-untouched install: auto is the right default,
  // and writing a sentinel here would create the block for no reason.
  if (!claudeCode) return false;
  // Idempotent: the sentinel's presence is the "already migrated" fact. A user who
  // later picks Auto deletes authMode but KEEPS the sentinel, so the next start must
  // not resurrect subscription.
  if (typeof claudeCode.authModeMigratedAt === "string" && claudeCode.authModeMigratedAt.length > 0) {
    return false;
  }
  if (claudeCode.authMode === undefined) {
    claudeCode.authMode = "subscription";
  }
  claudeCode.authModeMigratedAt = now.toISOString();
  return true;
}
