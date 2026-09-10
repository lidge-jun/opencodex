/**
 * Merge the retired `devin-cli` provider id into `devin` at startup
 * (devlog/_plan/260913_devin_provider_merge).
 *
 * The two registry entries were the same adapter, api-server, and credential
 * shape — only the login path differed — so `devin-cli` was removed from the
 * registry and survives as a deprecated alias. What remains is the saved
 * state written under the old id: a `providers["devin-cli"]` config row,
 * cross-config references, and the auth.json credential slot. All three move
 * here because an alias can resolve lookups but cannot un-dangle a reference
 * that validation requires to be a configured provider.
 *
 * Posture is Alibaba/OpenAI-tier fail-closed, not model-rename: this writes
 * auth.json, so both files get an immutable copy-verify-link snapshot before
 * any write, and a backup failure throws out of `startServer` rather than
 * rewriting credentials with no rollback point. A rekey that fails AFTER the
 * backup degrades to a warning instead — the old slot is still valid via the
 * alias and the next boot retries.
 *
 * Collision posture matches the config half: a `devin` row or slot that
 * already exists means two potentially different accounts, and choosing a
 * survivor is a user decision, so the migration refuses and warns.
 */
import { copyFileSync, existsSync, linkSync, readFileSync, rmSync } from "node:fs";
import { getConfigPath, saveConfig } from "../config";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { DEVIN_DEFAULT_API_SERVER } from "../oauth/devin/api-base";
import {
  getAuthStorePath,
  peekAuthStore,
  rekeyProviderCredentials,
  type ProviderCredentialRekeyOutcome,
} from "../oauth/store";
import { isRetiredDevinAcpIdentityUrl } from "./devin-cli-authmode-migration";
import { rewriteProviderReferences } from "./provider-id-rewrite";
import type { OcxConfig } from "../types";

const FROM_ID = "devin-cli";
const TO_ID = "devin";

/**
 * One snapshot suffix covers both files: the migration is not repeatable per
 * file, and two suffixes would only say which file happened to snapshot first.
 */
const BACKUP_SUFFIX = ".pre-devin-provider-merge-v1.bak";

/**
 * Immutable pre-migration snapshot, published by copy-verify-link.
 *
 * Same construction as alibaba-region-backup.ts, kept as a local copy because
 * that module's IO seam and error type are Alibaba-specific. The reasoning
 * carries over unchanged: a bare exclusive create can publish a truncated
 * file after a mid-copy crash, and an existing snapshot is reused rather than
 * compared — the earliest snapshot is the best rollback point, and demanding
 * equality would brick an install whose config legitimately changed after an
 * aborted run.
 */
function snapshotOnce(path: string): "absent" | "created" | "reused" {
  if (!existsSync(path)) return "absent";
  const backup = `${path}${BACKUP_SUFFIX}`;
  if (existsSync(backup)) return "reused";
  const source = readFileSync(path);
  const temp = `${backup}.${process.pid}.tmp`;
  try {
    copyFileSync(path, temp);
    if (!readFileSync(temp).equals(source)) {
      throw new Error(`failed to write a complete backup to ${temp}`);
    }
    linkSync(temp, backup);
    return "created";
  } catch (error) {
    // A concurrent process won the publish race with the same verified copy.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "reused";
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function backupConfigBeforeDevinProviderMerge(configPath = getConfigPath()): "absent" | "created" | "reused" {
  return snapshotOnce(configPath);
}

export function backupAuthBeforeDevinProviderMerge(authPath = getAuthStorePath()): "absent" | "created" | "reused" {
  return snapshotOnce(authPath);
}

export interface DevinProviderMergeProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

/**
 * Move `providers["devin-cli"]` to `providers["devin"]` and re-point every
 * cross-config reference. Pure projection: the input is not mutated and the
 * caller decides whether to persist the result.
 *
 * The moved row is normalized to the canonical entry's contract in the same
 * pass — `authMode: "oauth"` and `adapter: "devin"` are the only values the
 * `devin` registry entry admits, and a `cli.devin.ai` baseUrl was the retired
 * ACP transport's identity placeholder, never a destination. This absorbs
 * what `projectDevinCliAuthMode` used to do for the registry-id row; that
 * projection keeps only the custom-named-row adapter repair.
 */
export function projectDevinProviderMerge(config: OcxConfig): DevinProviderMergeProjection {
  const source = config.providers?.[FROM_ID];
  if (!source) return { config, changed: false, warnings: [] };

  if (codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, TO_ID)) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${FROM_ID}" needs to move to "${TO_ID}", but that destination is reserved `
        + "by a configured Codex account namespace. Nothing was changed. Rename the account "
        + "selector or move the provider manually, then restart.",
      ],
    };
  }
  if (config.providers[TO_ID]) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${FROM_ID}" is merged into "${TO_ID}", but "${TO_ID}" already exists. Both `
        + "were left untouched: merging two provider rows can merge two different accounts, "
        + "which is not a decision this migration can make. Move any devin-cli-only settings "
        + `onto "${TO_ID}" and delete the unused entry.`,
      ],
    };
  }

  const projected = structuredClone(config);
  const moved = projected.providers[FROM_ID]!;
  delete projected.providers[FROM_ID];
  moved.adapter = "devin";
  moved.authMode = "oauth";
  if (isRetiredDevinAcpIdentityUrl(moved.baseUrl)) {
    moved.baseUrl = DEVIN_DEFAULT_API_SERVER;
  }
  projected.providers[TO_ID] = moved;

  const { changed: rewritten, collisions } = rewriteProviderReferences(projected, FROM_ID, TO_ID);
  // The rewriter is not transactional, so the clone is already partly
  // rewritten here. Returning the ORIGINAL config discards it.
  if (collisions.length > 0) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${FROM_ID}" needs to move to "${TO_ID}", but ${collisions.join(", ")} `
        + "already hold values for the destination. Nothing was changed: choosing which value "
        + "survives is not a decision this migration can make. Resolve those entries and restart.",
      ],
    };
  }

  return {
    config: projected,
    changed: true,
    warnings: [
      `moved provider "${FROM_ID}" to "${TO_ID}": the two registry entries were merged and `
      + `"${FROM_ID}" is now a deprecated alias. ${rewritten} reference(s) were re-pointed.`,
    ],
  };
}

export interface DevinProviderMergeStartupDeps {
  project: typeof projectDevinProviderMerge;
  /** config.json snapshot; runs only when the projection changed something. */
  backupConfig: () => void;
  /** auth.json snapshot; runs only when a `devin-cli` credential slot exists. */
  backupAuth: () => void;
  save: (config: OcxConfig) => void;
  /** Sync peek so the auth backup is not taken for a slot that is not there. */
  hasAuthSlot: (provider: string) => boolean;
  rekey: (from: string, to: string) => Promise<ProviderCredentialRekeyOutcome>;
}

const DEFAULT_DEPS: DevinProviderMergeStartupDeps = {
  project: projectDevinProviderMerge,
  backupConfig: () => { backupConfigBeforeDevinProviderMerge(); },
  backupAuth: () => { backupAuthBeforeDevinProviderMerge(); },
  save: saveConfig,
  hasAuthSlot: provider => peekAuthStore()[provider] !== undefined,
  rekey: rekeyProviderCredentials,
};

/**
 * Run the merge at startup, before `reconcileOAuthProviders` in the
 * `startServer` chain.
 *
 * The config half is synchronous and fail-closed like the Alibaba migration:
 * the snapshot is taken strictly before the save, and a backup failure throws
 * rather than writing without a rollback point.
 *
 * The auth half is deliberately detached. `startServer` is synchronous — an
 * `await` in the boot window would suspend the composition root — and
 * `mutateStore` is async-only, so the rekey is fired after its snapshot and
 * its outcome is logged when it lands. That is safe here: the credential is
 * valid under either slot name while the `devin-cli` alias exists, a conflict
 * refuses by design, and a failed rekey simply retries on the next boot.
 */
export function runDevinProviderMergeStartupMigration(
  config: OcxConfig,
  deps: DevinProviderMergeStartupDeps = DEFAULT_DEPS,
): OcxConfig {
  const projection = deps.project(config);
  // Warnings are emitted even on a no-op: the collision case IS the warning.
  for (const warning of projection.warnings) console.warn(`[devin-provider-merge] ${warning}`);
  let result = config;
  if (projection.changed) {
    deps.backupConfig();
    deps.save(projection.config);
    result = projection.config;
  }

  // The auth rekey runs even when the config half refused or had nothing to
  // do: a `devin-cli` credential slot is orphaned state regardless of whether
  // a provider row still points at it, and the conflict check inside the
  // rekey is the same refuse-on-occupied rule the config half applies.
  if (!deps.hasAuthSlot(FROM_ID)) return result;
  deps.backupAuth();
  void deps.rekey(FROM_ID, TO_ID).then(outcome => {
    if (outcome === "conflict") {
      console.warn(
        `[devin-provider-merge] auth.json already has a "${TO_ID}" credential slot; the `
        + `"${FROM_ID}" slot was left in place. Merging two credential sets is not a decision `
        + "this migration can make — remove the unused slot manually.",
      );
    }
  }).catch((error: unknown) => {
    console.warn(
      `[devin-provider-merge] credential rekey failed and will retry on the next start: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return result;
}
