/**
 * The injection plan: every byte the artifact commit will write, plus the
 * journal baseline, derived from one native config.toml text.
 *
 * This is pure transformation and read-only preflight — no filesystem
 * mutation — so the caller derives once at admission time for the write
 * witness and pre-lock checks, and then AGAIN under the write lock when the
 * v1-surface reconcile changes config.toml there. Re-deriving from the
 * post-transition bytes is what keeps the committed file from re-enabling the
 * flag the reconcile just turned off.
 */
import { websocketsEnabled } from "../../config";
import {
  HISTORY_RELABEL_STANDS_DOWN,
  preflightCodexHistoryInjection,
} from "../history-provider";
import {
  journaledInjectedOpenaiBaseUrl,
  journaledInjectedRealtimeWsBaseUrl,
} from "../journal";
import { stripJournaledOpenaiBaseUrl } from "../injected-marker";
import { CODEX_CONFIG_PATH, resolveCodexStateDbPath } from "../paths";
import { transformManagedSubagentDefaults } from "../subagent-defaults";
import type { OcxConfig } from "../../types";
import type { CodexWriteCandidate } from "../write-coordination";
import {
  applyEol,
  buildProfileFileForTarget,
  buildProviderTableBlockForTarget,
  chooseCatalogPathForInjection,
  dominantEol,
  ensureFastModeFeature,
  normalizeServiceTier,
  removeProfileSection,
  setRootModelCatalogPath,
  setRootModelProvider,
  setRootOpenaiBaseUrlForTarget,
  setRootRealtimeWsBaseUrl,
  stripExistingModelProvider,
  stripInjectedOpenaiBaseUrl,
  stripOpencodexCatalogPath,
  stripRootContextWindowOverrides,
} from "./config-toml";
import { hasOcxProviderTable, removeOcxSection } from "./remove";
import {
  configuredManagedSubagentDefaults,
  usesProviderTable,
  type CodexRoutingTarget,
} from "./routing-target";
import { applyPaginatedOpenaiCompat } from "./paginated-openai-compat";

/** Everything the plan needs that is not the config.toml input text. */
export interface CodexInjectionPlanContext {
  readonly config: OcxConfig | undefined;
  readonly routingTarget: CodexRoutingTarget;
  /** The caller's catalog path option — the RESOLVED path lands on the plan. */
  readonly catalogPathOption: string | null | undefined;
  /** Journal reads stay read-only while a client guard owns the write channel. */
  readonly journalReadOnly: boolean;
}

/** The ok-variant of the plan: every derived artifact and reportable warning. */
export interface CodexInjectionPlanOk {
  kind: "ok";
  /** The input with marker-owned residue removed — what writeJournal snapshots. */
  baselineContent: string;
  /** The exact string about to replace config.toml. */
  content: string;
  /** The exact string about to replace the profile file. */
  profileContent: string;
  /** The resolved catalog path, never the raw option. */
  catalogPath: string | null;
  providerTableMode: boolean;
  keepRootOverrideAlongsideTable: boolean;
  keptUserBaseUrl: boolean;
  keptUserRealtimeWsBaseUrl: boolean;
  nativeSubagentDefaultsWarning: string | undefined;
  managedDefaultsMessage: string;
  /**
   * Mutable: the artifact commit re-observes the history store mid-write and
   * records the outcome here so the caller's message reflects it.
   */
  historyRelabelRefusal: string | null;
  /** Read-only history preflight bound to this plan's candidate bytes. */
  historyPreflight(): string | null;
  /** The witness candidate: the bytes this plan commits. */
  candidate: CodexWriteCandidate;
}

export type CodexInjectionPlan =
  | {
      kind: "refused";
      message: string;
      historyPreflightFailureReason?: string;
    }
  | CodexInjectionPlanOk;

export function deriveCodexInjectionPlan(
  source: string,
  ctx: CodexInjectionPlanContext,
): CodexInjectionPlan {
  const { config, routingTarget } = ctx;
  const preflightTableMode = usesProviderTable(routingTarget);
  const compactionOnly = routingTarget.clientCompaction === true
    && routingTarget.desktopAuthless !== true
    && routingTarget.requiresAdmissionToken !== true;

  // Marker-owned native defaults are OpenCodex residue, never part of the
  // user's journal baseline. Clean them before either snapshotting or adding a
  // root routing key: inserting that key ahead of a marker-owned first table
  // would otherwise separate the table marker from its header. Ambiguous
  // markers fail closed without writing config, profile, or journal state.
  const nativeDefaultsBaseline = transformManagedSubagentDefaults(
    source,
    null,
  );
  if (!nativeDefaultsBaseline.ok) {
    return {
      kind: "refused",
      message:
        `Codex config injection refused: existing OpenCodex-managed native sub-agent defaults are ambiguous: ${nativeDefaultsBaseline.error}. ` +
        `No files were changed; inspect ${CODEX_CONFIG_PATH}.`,
    };
  }
  const baselineContent = nativeDefaultsBaseline.content;

  /*
   * The journal write happens inside the write lock, after this plan is
   * derived. The lock's witness hashes the CANDIDATE BYTES, and those are not
   * final until `profileContent` and the EOL-applied `content` exist.
   * Opening the lock before them would leave nothing to hash; keeping the
   * journal outside the lock would leave the first artifact-creating write
   * unserialized.
   *
   * The split is safe because derivation performs no filesystem mutation — its
   * only touch is `existsSync` on the catalog paths
   * (`chooseCatalogPathForInjection`) — and because `writeJournal` is called
   * with `configContent`, so it snapshots the baseline it is handed rather
   * than rereading config.toml underneath the transforms.
   */
  // EOL boundary: transforms below are LF-pure; preserve the file's dominant ending on write.
  const eol = dominantEol(source);
  let content = applyEol(baselineContent, "\n");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  // Design B form FIRST: removeOcxSection also keys on the marker line, so a root-level
  // marker + openai_base_url pair must be gone before it scans or it would swallow root keys.
  content = stripInjectedOpenaiBaseUrl(content);
  // #1798: after a Codex app rewrite the markers are gone but the values we recorded writing
  // are still ours. Consume them by value here, BEFORE the routing form is chosen, so a
  // Design B -> provider-table transition (hostname change, authless opt-in) cannot leave our
  // own root URLs behind as if they were the user's, and so re-inject never journals them as
  // not-ours (which would make them unrestorable).
  content = stripJournaledOpenaiBaseUrl(
    content,
    journaledInjectedOpenaiBaseUrl({ readOnly: ctx.journalReadOnly }),
    journaledInjectedRealtimeWsBaseUrl({ readOnly: ctx.journalReadOnly }),
  );
  // Whether this home already published the provider id that its thread rows may reference.
  // Design B strips the table below; it may only stay stripped if those rows can be relabeled.
  const hadOcxProviderTableOnDisk = hasOcxProviderTable(content);
  if (hadOcxProviderTableOnDisk) {
    content = removeOcxSection(content);
  }
  content = removeProfileSection(content);
  content = stripExistingModelProvider(content);
  content = stripRootContextWindowOverrides(content);
  content = normalizeServiceTier(content);
  content = ensureFastModeFeature(content, config?.fastMode);

  const catalogPath = chooseCatalogPathForInjection(
    content,
    ctx.catalogPathOption,
  );
  content = catalogPath
    ? setRootModelCatalogPath(content, catalogPath)
    : stripOpencodexCatalogPath(content);

  // Provider-table form: non-loopback admission or an explicit Desktop policy.
  const providerTableMode = usesProviderTable(routingTarget);
  // Client compaction is the one table form that must not orphan existing threads. It changes
  // the DEFAULT provider to `opencodex`, but a thread already tagged `openai` keeps resolving
  // to Codex's built-in entry, and without the root override that entry is api.openai.com —
  // the thread would resume outside this proxy and outside configured routing. Keeping the
  // marker-owned root override alongside the table fixes that at the source: codex builds its
  // provider map as merge_configured_model_providers(built_in_model_providers(openai_base_url),
  // model_providers), so the override lands on the built-in `openai` entry when the map is
  // built, independent of which id is the default, and the merge leaves that entry alone for
  // every id except the two Amazon Bedrock ones. With the managed override in place both
  // entries point at this proxy. That is a guarantee about the line we own: when the user owns
  // the root line we inject nothing, and the built-in entry keeps whatever destination they
  // chose, so an `openai`-tagged thread follows their configuration rather than this proxy.
  //
  // Re-tagging history was the alternative and it cannot be made durable: the length-preserving
  // first-line repair cannot grow "openai" into "opencodex" without pre-existing padding, and
  // codex re-appends that stale first line whenever it writes git or memory-mode metadata.
  //
  // Authless is excluded on purpose: its whole point is a provider that carries
  // requires_openai_auth = false, and admission-token forms cannot use the root key at all.
  // Those two forms therefore keep their existing behaviour, forward-tagging resume history with
  // originals backed up, and that includes the case where a user enables authless and client
  // compaction together. Only the compaction-only form skips the history unit.
  let keepRootOverrideAlongsideTable = providerTableMode
    && routingTarget.clientCompaction === true
    && routingTarget.desktopAuthless !== true
    && routingTarget.requiresAdmissionToken !== true;
  let keptUserBaseUrl = false;
  let keptUserRealtimeWsBaseUrl = false;
  if (providerTableMode) {
    // Legacy (non-loopback) injection: the built-in openai provider cannot carry the
    // x-opencodex-api-key env header, so keep the opencodex provider table + root re-tag.
    // The authless opt-in needs the same table because only a dedicated provider can carry
    // requires_openai_auth = false.
    // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
    content = setRootModelProvider(content);
    // 2) Provider table appended at EOF (position-independent).
    content =
      content.trimEnd() +
      "\n" +
      buildProviderTableBlockForTarget(routingTarget, websocketsEnabled(config ?? {}), config?.codexProviderDisplayName);
    // 3) Keep existing `openai`-tagged threads reaching the proxy (see above). Ownership rules
    // are the Design B ones: a user's own root line is never replaced.
    if (keepRootOverrideAlongsideTable) {
      content = stripInjectedOpenaiBaseUrl(content);
      const rootFallback = setRootOpenaiBaseUrlForTarget(content, routingTarget);
      content = rootFallback.content;
      keptUserBaseUrl = rootFallback.keptUserBaseUrl;
    }
  } else {
    // Design B (loopback): a single root override; codex keeps its native `openai` provider id
    // so thread history is never remapped. Any legacy form was already stripped above.
    content = stripInjectedOpenaiBaseUrl(content); // normalize before idempotent re-insert
    const result = setRootOpenaiBaseUrlForTarget(content, routingTarget);
    content = result.content;
    keptUserBaseUrl = result.keptUserBaseUrl;
    // Voice sideband override rides on the routing override: same value, same ownership rule,
    // and never when the user owns the routing line (we inject nothing in that case).
    if (!keptUserBaseUrl) {
      const realtime = setRootRealtimeWsBaseUrl(content, routingTarget);
      content = realtime.content;
      keptUserRealtimeWsBaseUrl = realtime.keptUserRealtimeWsBaseUrl;
    }
  }

  const desiredSubagentDefaults = configuredManagedSubagentDefaults(config);
  const routingOwnershipWarning =
    keptUserBaseUrl && desiredSubagentDefaults
      ? "Native Codex sub-agent defaults were not injected: a user-owned root openai_base_url prevents OpenCodex from managing active Codex routing."
      : undefined;
  const managedDefaults = transformManagedSubagentDefaults(
    content,
    keptUserBaseUrl ? null : desiredSubagentDefaults,
  );
  let nativeSubagentDefaultsWarning = routingOwnershipWarning;
  let managedDefaultsMessage = routingOwnershipWarning
    ? `  ⚠️ ${routingOwnershipWarning}\n`
    : "";
  if (managedDefaults.ok) {
    content = managedDefaults.content;
    if (desiredSubagentDefaults && managedDefaults.conflicts.length > 0) {
      const keys = managedDefaults.conflicts
        .map((conflict) => `agents.${conflict.key}`)
        .join(", ");
      nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults were not injected: user-owned ${keys} preserved.`;
      managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
    }
  } else {
    const action =
      desiredSubagentDefaults && !keptUserBaseUrl
        ? "were not injected"
        : "could not be safely removed";
    nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults ${action}: ${managedDefaults.error}.`;
    managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
  }

  const profileContent = buildProfileFileForTarget(
    routingTarget,
    catalogPath,
    websocketsEnabled(config ?? {}),
    config?.fastMode,
    config?.codexProviderDisplayName,
  );
  content = applyEol(content, eol);

  // Resolve storage from the normalized candidate. Owned duplicate catalog keys
  // are repairable above and must not make this read-only preflight throw.
  const historyPreflight = (): string | null => {
    try {
      return preflightCodexHistoryInjection(
        preflightTableMode,
        config?.syncResumeHistory !== false && !compactionOnly,
        resolveCodexStateDbPath({ readConfig: () => content }),
      );
    } catch {
      return "history_injection_preflight_unavailable";
    }
  };
  /*
   * ONE refusal stands the relabel unit down instead of vetoing the config transition, and
   * only because it is permanent. Codex allocates paginated rollout ordinals in its own
   * writer, so `assertLegacyHistoryRecord` refuses every rollout on a current install and no
   * amount of retrying changes that. While it vetoed the write, `model_catalog_json` never
   * reached config.toml, so the app and the CLI both fell back to their built-in model list
   * while `ocx sync` still reported success.
   *
   * Every other reason — an unreadable state database, a rollout whose identity changed, a
   * preflight that could not run — describes a store that may well be relabelable on the next
   * attempt. Treating those as a stand-down would record the transition as converged and
   * suppress the relabel permanently, so they keep the hard refusal and the rollback.
   */
  /*
   * Re-observed inside the artifact transaction. A store that migrates to paginated history
   * mid-write can retire the relabel unit while its already-admitted candidate leaves
   * existing provider references resolvable. Existing provider definitions are retained
   * before the witness; no post-commit compensation may overwrite a newer native write.
   */
  const compat = applyPaginatedOpenaiCompat(historyPreflight(), routingTarget, content, eol);
  content = compat.content;
  keepRootOverrideAlongsideTable ||= compat.retainedRootOverride;
  const observedHistoryRefusal = compat.refusal;
  if (observedHistoryRefusal && observedHistoryRefusal !== HISTORY_RELABEL_STANDS_DOWN) {
    return {
      kind: "refused",
      historyPreflightFailureReason: observedHistoryRefusal,
      message: compat.message,
    };
  }

  /*
   * Rows this home may have tagged `opencodex` resolve only through a provider table. Design B
   * selects built-in `openai` for new work, but background relabel and native publication are
   * not atomic. Codex can paginate after the final check or when the worker starts. Retain
   * an existing definition BEFORE the witness regardless of preflight, so worker failure
   * cannot orphan old references. Explicit restoration keeps its removal and history guards.
   */
  if (hadOcxProviderTableOnDisk && !providerTableMode) {
    content = applyEol(
      content.trimEnd() + "\n" + buildProviderTableBlockForTarget(routingTarget, websocketsEnabled(config ?? {}), config?.codexProviderDisplayName),
      eol,
    );
  }

  return {
    kind: "ok",
    baselineContent,
    content,
    profileContent,
    catalogPath,
    providerTableMode,
    keepRootOverrideAlongsideTable,
    keptUserBaseUrl,
    keptUserRealtimeWsBaseUrl,
    nativeSubagentDefaultsWarning,
    managedDefaultsMessage,
    historyRelabelRefusal: observedHistoryRefusal,
    historyPreflight,
    candidate: {
      configBytes: content,
      profileBytes: profileContent,
      catalogPath,
    },
  };
}
