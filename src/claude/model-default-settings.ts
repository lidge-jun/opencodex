import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { assertNotRealClaudeConfigUnderTest } from "../lib/test-home-guard";
import { claudeConfigDir } from "./auth-detect";
import { claudeTierDisplayName, type ClaudeTierModels } from "./context-windows";

const tiers = ["opus", "sonnet", "haiku", "fable"] as const;

function readSettings(path: string): { raw: string; exists: boolean; doc: Record<string, unknown>; env: Record<string, unknown> } {
  let raw = "";
  let exists = false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("settings_unreadable");
    raw = readFileSync(path, "utf8");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("settings_unreadable");
  }
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = exists ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    doc = parsed as Record<string, unknown>;
    if (doc.env !== undefined && (!doc.env || typeof doc.env !== "object" || Array.isArray(doc.env))) throw new Error();
  } catch { throw new Error("settings_unreadable"); }
  return { raw, exists, doc, env: (doc.env ?? {}) as Record<string, unknown> };
}

function snapshotFingerprint(current: ReturnType<typeof readSettings>, models: ClaudeTierModels | undefined) {
  const target = selectedEnv(models, current.env);
  return createHash("sha256").update(JSON.stringify([current.exists, current.raw, target])).digest("hex");
}

/** Test seams for edits at publication boundaries; never configured through the API. */
export interface ModelDefaultWriteHooks {
  beforeCapture?: () => void;
  beforePublish?: () => void;
}

export class ModelDefaultsRecoveryError extends Error {
  constructor(readonly backupPath: string, options?: ErrorOptions) {
    super("settings_recovery_required", options);
  }
}

/** Unset tiers stay untouched; only a label matching its current alias is managed. */
function selectedEnv(models: ClaudeTierModels | undefined, current: Record<string, unknown>): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const tier of tiers) {
    const slot = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
    const name = `${slot}_NAME`;
    const value = models?.[tier]?.trim();
    if (!value) continue;
    env[slot] = value;
    const previous = typeof current[slot] === "string" ? claudeTierDisplayName(current[slot]) : undefined;
    const managed = previous !== undefined && current[name] === previous;
    // Custom (including empty/non-string) labels are user-owned. Exact pairing
    // follows the launcher label convention; the name alone proves no ownership.
    if (!Object.hasOwn(current, name) || managed) {
      const label = claudeTierDisplayName(value);
      if (label !== undefined) env[name] = label;
      else if (managed) env[name] = null;
    }
  }
  return env;
}

export function previewClaudeModelDefaults(models: ClaudeTierModels | undefined, configDir = claudeConfigDir()) {
  const path = join(configDir, "settings.json");
  const current = readSettings(path);
  const target = selectedEnv(models, current.env);
  const changes = Object.entries(target).filter(([key, value]) => current.env[key] !== value)
    // The existing preview wire shape uses an empty replacement for label removal.
    .map(([key, value]) => ({ key, before: typeof current.env[key] === "string" ? current.env[key] as string : null, after: value ?? "" }));
  const fingerprint = snapshotFingerprint(current, models);
  return { path, fingerprint, changes };
}

export function applyClaudeModelDefaults(
  models: ClaudeTierModels | undefined,
  fingerprint: string,
  configDir = claudeConfigDir(),
  backupDir = join(configDir, "model-default-backups"),
  hooks: ModelDefaultWriteHooks = {},
) {
  const preview = previewClaudeModelDefaults(models, configDir);
  if (preview.fingerprint !== fingerprint) throw new Error("settings_changed");
  if (!preview.changes.length) return { changed: false, path: preview.path };
  assertNotRealClaudeConfigUnderTest(configDir, preview.path);
  const current = readSettings(preview.path);
  const check = snapshotFingerprint(current, models);
  if (check !== fingerprint) throw new Error("settings_changed");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const recoveryDir = mkdtempSync(join(backupDir, "apply-"));
  if (process.platform === "win32") hardenSecretDir(recoveryDir, { required: true });
  const backupPath = join(recoveryDir, "settings.json");
  const staged = join(configDir, `.model-defaults-${randomUUID()}.tmp`);
  let captured = false;
  let published = false;
  try {
    const env = { ...current.env };
    for (const [key, value] of Object.entries(selectedEnv(models, current.env))) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    current.doc.env = env;
    atomicWriteFileNoFollow(staged, `${JSON.stringify(current.doc, null, 2)}\n`);
    // Verify same-volume exclusive publication before moving the shared file.
    const probe = join(recoveryDir, "link-probe");
    linkSync(staged, probe);
    unlinkSync(probe);
    hooks.beforeCapture?.();
    if (current.exists) {
      // Move the actual destination, not a stale in-memory copy. A same-filesystem
      // move captures late edits; cross-device failures leave the original alone.
      try { renameSync(preview.path, backupPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("settings_changed");
        throw error;
      }
      captured = true;
      const capturedEntry = lstatSync(backupPath);
      if (!capturedEntry.isFile() || capturedEntry.isSymbolicLink()) throw new Error("settings_changed");
      if (process.platform === "win32") hardenSecretPath(backupPath, { required: true });
      if (snapshotFingerprint(readSettings(backupPath), models) !== fingerprint) throw new Error("settings_changed");
    }
    hooks.beforePublish?.();
    // A hard-link publish is exclusive on POSIX and Windows: never replace a
    // document created by another writer during the brief move-aside interval.
    try { linkSync(staged, preview.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("settings_changed");
      throw error;
    }
    published = true;
    return { changed: true, path: preview.path, ...(captured ? { backupPath } : {}) };
  } catch (error) {
    if (captured && !published) {
      try { linkSync(backupPath, preview.path); } catch (restoreError) {
        // A newer destination wins. Retain the captured document privately;
        // never delete the winner or overwrite it as an automatic rollback.
        throw new ModelDefaultsRecoveryError(backupPath, { cause: restoreError });
      }
    }
    throw error;
  } finally {
    // The private stage is also present at the destination after successful
    // linking; cleanup failure must not turn a committed apply into failure.
    try { unlinkSync(staged); } catch { /* private residue, no shared-file cleanup */ }
  }
}
