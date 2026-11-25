/**
 * Read-only preview of the native Codex restore (catch-up 010, G-001).
 *
 * Answers "if Codex were switched back to its native path now, which config.toml keys would
 * change, and would the restore refuse first?" by walking `restoreNativeCodexAsync` in its own
 * order with the read-only halves of the same decisions: the home owner check, the external
 * provider courtesy, the recorded service ownership, the history disposition, the journal
 * comparison (`previewJournalRestore`), the removal transform (`previewRemovedCodexConfig`),
 * the provider-table retention and the approved-provider URL restore
 * (`previewApprovedCodexProviderRestore`). It takes no lock and writes nothing. Values never
 * leave this module: a change is a file, a key and add/update/remove.
 *
 * The catalog rows and conversation-history relabel a restore also performs are not config
 * keys and are not listed.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { inspectRecordedServiceOwnership, type OwnershipDeps } from "../integrations/native/ownership-preflight";
import { codexHomeIsAbsent, inspectCodexHomeOwner } from "./codex-home-owner";
import { readBoundedCodexConfig } from "./inject/bounded-config-reader";
import { applyEol, externalCodexModelProvider } from "./inject/config-toml";
import { appendOcxProviderTableBlock, extractOcxProviderTableBlock } from "./inject/provider-table";
import { previewRemovedCodexConfig } from "./inject/remove";
import { resolveRestoreHistoryDisposition } from "./inject/restore";
import { previewJournalRestore } from "./journal";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, getCodexHome } from "./paths";
import { parseTomlDocument } from "./project-config-warnings";
import { previewApprovedCodexProviderRestore } from "./provider-routing";
import { siblingOfLivePort } from "./sibling-start";

export type CodexRestoreOutcome =
  /** The restore would run; `changes` lists what it rewrites (possibly nothing). */
  | "restore"
  | "skipped_sibling"
  | "refused_owner"
  | "refused_history"
  | "refused_journal"
  | "refused_profile"
  | "refused_managed_defaults"
  /** Config would be restored, then the approved-provider URL restore fails on its evidence. */
  | "provider_evidence_invalid"
  | "unreadable";

export interface CodexRestoreChange {
  file: "config.toml" | "opencodex.config.toml";
  /** Root key, `section.key`, or `*` for the whole file. */
  key: string;
  change: "add" | "update" | "remove";
}

export interface CodexRestorePreview {
  outcome: CodexRestoreOutcome;
  changes: CodexRestoreChange[];
  /** Kept `[model_providers.opencodex]` because tagged conversations still need it. */
  providerTableRetained: boolean;
}

export interface CodexRestorePreviewDeps {
  ownership?: OwnershipDeps;
  historyDisposition?: () => ReturnType<typeof resolveRestoreHistoryDisposition>;
}

function readProfile(): string | null {
  return existsSync(CODEX_PROFILE_PATH) ? readFileSync(CODEX_PROFILE_PATH, "utf8") : null;
}

function flatten(content: string | null): Map<string, string> {
  const keys = new Map<string, string>();
  if (content === null) return keys;
  const { root, sections } = parseTomlDocument(applyEol(content, "\n"));
  for (const [key, value] of Object.entries(root)) keys.set(key, value);
  for (const [section, entries] of sections) {
    for (const [key, value] of Object.entries(entries)) keys.set(`${section}.${key}`, value);
  }
  return keys;
}

/** Key-level difference between two config.toml texts; values are compared, never returned. */
export function codexConfigKeyChanges(before: string | null, after: string | null): CodexRestoreChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const changes: CodexRestoreChange[] = [];
  for (const [key, value] of a) {
    if (!b.has(key)) changes.push({ file: "config.toml", key, change: "remove" });
    else if (b.get(key) !== value) changes.push({ file: "config.toml", key, change: "update" });
  }
  for (const key of b.keys()) if (!a.has(key)) changes.push({ file: "config.toml", key, change: "add" });
  return changes.sort((x, y) => x.key.localeCompare(y.key));
}

function profileChange(before: string | null, after: string | null): CodexRestoreChange[] {
  if (before === after) return [];
  const file = basename(CODEX_PROFILE_PATH) as CodexRestoreChange["file"];
  const change = before === null ? "add" : after === null ? "remove" : "update";
  return [{ file, key: "*", change }];
}

export function previewCodexNativeRestore(deps: CodexRestorePreviewDeps = {}): CodexRestorePreview {
  const none = (outcome: CodexRestoreOutcome): CodexRestorePreview => ({ outcome, changes: [], providerTableRetained: false });
  const home = getCodexHome();
  if (codexHomeIsAbsent(home)) return none("restore");
  if (siblingOfLivePort() !== null) return none("skipped_sibling");
  const owner = inspectCodexHomeOwner(home);
  if (owner.kind === "foreign" || owner.kind === "unknown") return none("refused_owner");

  let config: string | null;
  try { config = readBoundedCodexConfig(CODEX_CONFIG_PATH); } catch { return none("unreadable"); }
  const profile = readProfile();
  const finish = (afterConfig: string | null, afterProfile: string | null, retained: boolean): CodexRestorePreview => {
    let restored = afterConfig;
    let outcome: CodexRestoreOutcome = "restore";
    if (afterConfig !== null) {
      try { restored = previewApprovedCodexProviderRestore(afterConfig); }
      catch { outcome = "provider_evidence_invalid"; }
    }
    return {
      outcome,
      changes: [...codexConfigKeyChanges(config, restored), ...profileChange(profile, afterProfile)],
      providerTableRetained: retained,
    };
  };

  // External-provider courtesy: config.toml is the other provider's; only approved URLs revert.
  if (config !== null && externalCodexModelProvider(config)) return finish(config, profile, false);
  if (inspectRecordedServiceOwnership(deps.ownership)?.ownership === "foreign") return none("refused_owner");
  const disposition = (deps.historyDisposition ?? (() => resolveRestoreHistoryDisposition(undefined)))();
  if (disposition.kind === "refuse") return none("refused_history");
  const retain = disposition.kind === "stand-down" && disposition.retainProviderTable;
  const capturedBlock = retain && config !== null ? extractOcxProviderTableBlock(applyEol(config, "\n")) : null;

  const journal = previewJournalRestore(config, profile);
  if (journal.kind === "unverified") return none("refused_journal");
  if (journal.kind === "profile-symlink") return none("refused_profile");
  const planned = journal.kind === "planned" ? journal : null;
  let afterProfile = planned && planned.profileAfter !== undefined ? planned.profileAfter : profile;

  let afterConfig: string | null;
  if (planned?.configRestored) {
    afterConfig = planned.configWrite ?? config;
  } else {
    // removeCodexConfig: the profile goes unless the journal step restored or kept it.
    const preserveProfile = planned !== null && (planned.profileRestored || planned.profileChanged);
    if (config === null) {
      afterConfig = null;
    } else {
      const removed = previewRemovedCodexConfig(config, retain ? "stand-down-retain" : disposition.kind === "stand-down" ? "stand-down-remove" : "refuse-on-any");
      if (removed.managedDefaultsError) return none("refused_managed_defaults");
      afterConfig = removed.content;
    }
    if (!preserveProfile) afterProfile = null;
  }
  // The settled re-attach after a journal replay (idempotent on the strip path).
  if (capturedBlock !== null && afterConfig !== null) {
    try { afterConfig = appendOcxProviderTableBlock(applyEol(afterConfig, "\n"), capturedBlock); }
    catch { return none("refused_history"); }
  }
  return finish(afterConfig, afterProfile, capturedBlock !== null);
}
