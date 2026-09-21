import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR } from "../codex/account-namespace-match";
import { redactSecretString } from "../lib/redact";
import { hasWarnedConfigFallback, markWarnedConfigFallback } from "./warn-memo";
import { configSchema } from "./schema/config-schema";
import type { OcxConfig } from "../types";

export function warnConfigRepaired(configPath: string, error: z.ZodError): void {
  if (hasWarnedConfigFallback(configPath)) return;
  markWarnedConfigFallback(configPath);
  const fields = error.issues.map(i => i.path.join(".") || "config").join(", ");
  console.error(`opencodex config at ${configPath}: repaired missing field(s) [${fields}] with defaults. Your providers and accounts are preserved.`);
}

/**
 * Sections whose entries are independent of one another, so one bad entry is
 * safe to drop without changing what the rest mean.
 *
 * Both are validated entry-by-entry in the `superRefine` above, which raises
 * every finding as a *document*-level issue. That is what made a single routing
 * candidate naming a disabled provider discard the operator's whole config —
 * all eleven providers, every API key, and the entire `modelCosts` table —
 * while the proxy carried on serving from built-in defaults and reporting
 * healthy.
 */
const SALVAGEABLE_CONFIG_SECTIONS = ["routingProfiles", "combos"] as const;

/** Optional nested fields that can be dropped whole without changing the rest of the document. */
const SALVAGEABLE_OPTIONAL_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["claudeCode", "desktopProfile"],
];

function isSalvageableConfigPath(section: string, id: string): boolean {
  if ((SALVAGEABLE_CONFIG_SECTIONS as readonly string[]).includes(section)) return true;
  return SALVAGEABLE_OPTIONAL_FIELDS.some(path => path[0] === section && path[1] === id);
}

/**
 * Drop just the named entries a parse failure blamed, so the rest of the
 * document survives.
 *
 * Returns `null` when the failure was not confined to those sections — the
 * caller then keeps its existing behaviour rather than guessing.
 *
 * The whole entry goes, not the individual offending candidate. A routing
 * profile that quietly loses one candidate still routes, just not where the
 * operator said it should, and a policy that silently changed shape is a worse
 * outcome than one that is plainly absent. Absent is also the loud option: a
 * dry-run against it answers `unknown_profile`, which — paired with the warning
 * this emits — points at the real mistake.
 */
function dropInvalidConfigSections(
  parsed: unknown,
  error: z.ZodError,
): { candidate: Record<string, unknown>; dropped: string[] } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const doomed = new Map<string, Set<string>>();
  for (const issue of error.issues) {
    if (isUnsalvageableIssue(issue)) return null;
    const [section, id] = issue.path;
    if (typeof section !== "string" || typeof id !== "string") return null;
    if (!isSalvageableConfigPath(section, id)) return null;
    // A complaint about the container itself ("combos must be an object") is
    // not about one entry, so there is nothing selective to drop.
    if (issue.path.length < 2) return null;
    let ids = doomed.get(section);
    if (!ids) doomed.set(section, ids = new Set());
    ids.add(id);
  }
  if (doomed.size === 0) return null;

  const candidate: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const dropped: string[] = [];
  for (const [section, ids] of doomed) {
    const current = candidate[section];
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (ids.has(key)) dropped.push(`${section}.${key}`);
      else kept[key] = value;
    }
    candidate[section] = kept;
  }
  return dropped.length > 0 ? { candidate, dropped } : null;
}

/**
 * Salvage until the document parses, not just once.
 *
 * One pass is not enough because the sections depend on each other: routing
 * profiles are validated against the combo map, so dropping an invalid combo can
 * expose a profile that referenced it. A single-pass salvage sees that second
 * failure and gives up, discarding the whole config -- the exact outcome this
 * code exists to prevent.
 *
 * `rawDocument` is the operator's document before defaults were merged in. When
 * supplied, the same entries are deleted from it too, so a diagnostics caller can
 * still tell an absent optional setting from one we injected.
 */

/**
 * Findings that must never be salvaged away.
 *
 * Salvage removes the entry a finding blamed, which is right for an ordinary
 * validation mistake and wrong for a namespace collision: the collision is a
 * *relationship* between a combo/profile and a Codex account selector, and it is
 * reported on the combo. Dropping that combo makes the document parse and quietly
 * admits the account selector the schema just refused, turning a hard admission
 * boundary into a config that loads. Refuse the whole document instead.
 */
const UNSALVAGEABLE_ISSUE_MESSAGES: readonly string[] = [
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
];

function isUnsalvageableIssue(issue: z.ZodIssue): boolean {
  return UNSALVAGEABLE_ISSUE_MESSAGES.some(message => issue.message.includes(message));
}
export function salvageConfigCandidate(
  merged: unknown,
  initialError: z.ZodError,
  rawDocument?: unknown,
): {
  candidate: Record<string, unknown>;
  rawCandidate: unknown;
  parsed: OcxConfig;
  dropped: string[];
  issues: z.ZodIssue[];
} | null {
  let candidate: unknown = merged;
  let rawCandidate: unknown = rawDocument;
  let error = initialError;
  const dropped: string[] = [];
  const issues: z.ZodIssue[] = [];
  // Bounded by construction: every pass must remove at least one entry, and there
  // are only so many entries to remove.
  const budget = countSalvageableEntries(merged) + 1;
  for (let pass = 0; pass < budget; pass++) {
    const step = dropInvalidConfigSections(candidate, error);
    if (!step || step.dropped.length === 0) return null;
    dropped.push(...step.dropped);
    issues.push(...error.issues);
    candidate = step.candidate;
    rawCandidate = deleteEntryPaths(rawCandidate, step.dropped);
    const result = configSchema.safeParse(candidate);
    if (result.success) {
      return { candidate: step.candidate, rawCandidate, parsed: result.data as OcxConfig, dropped, issues };
    }
    error = result.error;
  }
  return null;
}

function countSalvageableEntries(document: unknown): number {
  if (!document || typeof document !== "object" || Array.isArray(document)) return 0;
  let total = 0;
  for (const section of SALVAGEABLE_CONFIG_SECTIONS) {
    const value = (document as Record<string, unknown>)[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      total += Object.keys(value as Record<string, unknown>).length;
    }
  }
  for (const [section, id] of SALVAGEABLE_OPTIONAL_FIELDS) {
    const container = (document as Record<string, unknown>)[section];
    if (container && typeof container === "object" && !Array.isArray(container)
      && Object.hasOwn(container as Record<string, unknown>, id)) {
      total += 1;
    }
  }
  return total;
}

/** Delete `section.id` entries from a copy of the raw document. */
function deleteEntryPaths(document: unknown, entryPaths: readonly string[]): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const next: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  for (const entryPath of entryPaths) {
    const separator = entryPath.indexOf(".");
    if (separator <= 0) continue;
    const section = entryPath.slice(0, separator);
    const id = entryPath.slice(separator + 1);
    const container = next[section];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const kept: Record<string, unknown> = { ...(container as Record<string, unknown>) };
    delete kept[id];
    next[section] = kept;
  }
  return next;
}

/**
 * Entry ids are operator-chosen and can be token-shaped, so nothing dynamic reaches
 * the log unredacted. Static section names stay readable -- they are the part that
 * tells the operator where to look.
 */
function redactEntryPath(entryPath: string): string {
  const separator = entryPath.indexOf(".");
  if (separator <= 0) return redactSecretString(entryPath);
  return entryPath.slice(0, separator) + "." + redactSecretString(entryPath.slice(separator + 1));
}

function redactIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) => (index === 0 && typeof segment === "string" ? segment : redactSecretString(String(segment))))
    .join(".");
}

export function warnDroppedConfigSections(configPath: string, dropped: string[], issues: readonly z.ZodIssue[]): void {
  if (hasWarnedConfigFallback(configPath)) return;
  markWarnedConfigFallback(configPath);
  const reasons = issues
    .map(issue => `${redactIssuePath(issue.path)}: ${redactSecretString(issue.message)}`)
    .join("; ");
  console.error(
    `opencodex config at ${configPath}: dropped [${dropped.map(redactEntryPath).join(", ")}] and loaded the rest — ${reasons}. `
    + "Everything else in your config, including providers and modelCosts, is preserved.",
  );
}

export function warnAndBackupInvalidConfig(configPath: string, error: unknown): void {
  if (hasWarnedConfigFallback(configPath)) return;
  markWarnedConfigFallback(configPath);

  const backupPath = backupInvalidConfig(configPath);
  const reason = error instanceof z.ZodError
    ? error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : String(error);
  const backupNote = backupPath ? ` A backup was written to ${backupPath}.` : "";
  console.error(`Could not load opencodex config at ${configPath}: ${reason}. Using default config.${backupNote}`);
}

export function backupInvalidConfig(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    return backupPath;
  } catch {
    return null;
  }
}
