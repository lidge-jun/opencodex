/**
 * The Codex settings a Remote Link Home decides for its Children (#6957).
 *
 * A link Child relays every model request to its Home, so everything the Home's proxy applies
 * per request already follows the Home: effort caps, the sub-agent roster and fallback, the
 * injection prompt, sidecar and compaction routing, and the catalog itself (served by
 * `/v1/catalog`). What does NOT follow is the part of the Home's OpenCodex config that the
 * injector writes into the Child's own Codex `config.toml`. This module carries exactly that
 * part, which is every OpenCodex config field the Codex injection plan reads that is a policy
 * decision rather than a fact about the Child's own listener:
 *
 * - `fastMode` -> `[features] fast_mode`
 * - `multiAgentMode` -> the native `features.multi_agent_v2` reconcile (v1 mode)
 * - `webSearchSidecar.enabled` -> the root `web_search` switch
 * - `syncCodexSubagentDefaults` + `injectionModel` + `injectionEffort` -> the managed
 *   `[agents]` defaults
 *
 * Root `model_reasoning_effort` and the `desktop.*` picker keys are Codex app settings that
 * OpenCodex never writes on any machine, so they are deliberately not part of this document.
 * Listener facts (port, hostname, Desktop authless and client compaction routing forms, resume
 * history) stay the Child's own because they describe how the Child's Codex reaches the Child.
 *
 * It rides on its own authenticated link read rather than inside the catalog because the
 * catalog bytes are written verbatim to `model_catalog_json`, which Codex parses itself.
 */
import { hostname } from "node:os";
import type { OcxConfig } from "../types";

export const HOME_CODEX_SETTINGS_VERSION = 1;
const MULTI_AGENT_MODES = ["v1", "default", "v2"] as const;
type MultiAgentMode = (typeof MULTI_AGENT_MODES)[number];

export interface HomeCodexSettings {
  /** null: the Home leaves `fast_mode` alone. */
  fastMode: boolean | null;
  /** null: the Home has no explicit mode. */
  multiAgentMode: MultiAgentMode | null;
  webSearchSidecarEnabled: boolean;
  subagentDefaults: { model: string; reasoningEffort: string | null } | null;
}

export interface HomeCodexSettingsDocument {
  version: typeof HOME_CODEX_SETTINGS_VERSION;
  home: { name: string; version: string };
  settings: HomeCodexSettings;
}

const NAME_MAX = 255;
const VALUE_MAX = 256;

function safeLabel(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return null;
  }
  return trimmed;
}

export function projectHomeCodexSettings(config: OcxConfig, version: string): HomeCodexSettingsDocument {
  const mode = config.multiAgentMode;
  // Same predicate as `subagentDefaultSyncEffective` (src/config/diagnostics.ts), inlined so
  // this module stays inside the src/link import boundary.
  const sync = config.syncCodexSubagentDefaults === true && Boolean(config.injectionModel?.trim());
  const effort = config.injectionEffort?.trim();
  return {
    version: HOME_CODEX_SETTINGS_VERSION,
    home: { name: safeLabel(hostname(), NAME_MAX) ?? "Home", version },
    settings: {
      fastMode: typeof config.fastMode === "boolean" ? config.fastMode : null,
      multiAgentMode: mode && (MULTI_AGENT_MODES as readonly string[]).includes(mode) ? mode : null,
      webSearchSidecarEnabled: config.webSearchSidecar?.enabled !== false,
      subagentDefaults: sync
        ? { model: config.injectionModel!.trim(), reasoningEffort: effort ? effort : null }
        : null,
    },
  };
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

/** Strict parse: an unknown field, a wrong type or an unsafe label rejects the whole document. */
export function parseHomeCodexSettingsDocument(value: unknown): HomeCodexSettingsDocument | null {
  if (!exactKeys(value, ["version", "home", "settings"]) || value.version !== HOME_CODEX_SETTINGS_VERSION) return null;
  const home = value.home;
  if (!exactKeys(home, ["name", "version"]) || typeof home.name !== "string" || typeof home.version !== "string") return null;
  const name = safeLabel(home.name, NAME_MAX);
  const homeVersion = safeLabel(home.version, 64);
  if (!name || !homeVersion) return null;
  const s = value.settings;
  if (!exactKeys(s, ["fastMode", "multiAgentMode", "webSearchSidecarEnabled", "subagentDefaults"])) return null;
  if (s.fastMode !== null && typeof s.fastMode !== "boolean") return null;
  if (s.multiAgentMode !== null && !(MULTI_AGENT_MODES as readonly unknown[]).includes(s.multiAgentMode)) return null;
  if (typeof s.webSearchSidecarEnabled !== "boolean") return null;
  let subagentDefaults: HomeCodexSettings["subagentDefaults"] = null;
  if (s.subagentDefaults !== null) {
    const d = s.subagentDefaults;
    if (!exactKeys(d, ["model", "reasoningEffort"]) || typeof d.model !== "string") return null;
    const model = safeLabel(d.model, VALUE_MAX);
    if (!model) return null;
    let reasoningEffort: string | null = null;
    if (d.reasoningEffort !== null) {
      if (typeof d.reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(d.reasoningEffort)) return null;
      reasoningEffort = d.reasoningEffort;
    }
    subagentDefaults = { model, reasoningEffort };
  }
  return {
    version: HOME_CODEX_SETTINGS_VERSION,
    home: { name, version: homeVersion },
    settings: {
      fastMode: s.fastMode as boolean | null,
      multiAgentMode: s.multiAgentMode as MultiAgentMode | null,
      webSearchSidecarEnabled: s.webSearchSidecarEnabled,
      subagentDefaults,
    },
  };
}

/** The Child's config as the Codex injector should see it: local listener facts, Home policy. */
export function overlayHomeCodexSettings(config: OcxConfig, settings: HomeCodexSettings): OcxConfig {
  const next: OcxConfig = {
    ...config,
    webSearchSidecar: { ...(config.webSearchSidecar ?? {}), enabled: settings.webSearchSidecarEnabled },
  };
  if (settings.fastMode === null) delete next.fastMode;
  else next.fastMode = settings.fastMode;
  if (settings.multiAgentMode === null) delete next.multiAgentMode;
  else next.multiAgentMode = settings.multiAgentMode;
  if (settings.subagentDefaults) {
    next.injectionModel = settings.subagentDefaults.model;
    next.syncCodexSubagentDefaults = true;
    if (settings.subagentDefaults.reasoningEffort) next.injectionEffort = settings.subagentDefaults.reasoningEffort;
    else delete next.injectionEffort;
  } else {
    next.syncCodexSubagentDefaults = false;
  }
  return next;
}

/** One line per applied value, for `ocx sync`, `ocx status` and the dashboard. */
export function describeHomeCodexSettings(settings: HomeCodexSettings): string[] {
  const d = settings.subagentDefaults;
  return [
    `fast mode: ${settings.fastMode === null ? "unset" : settings.fastMode ? "on" : "off"}`,
    `multi-agent mode: ${settings.multiAgentMode ?? "default"}`,
    `web search sidecar: ${settings.webSearchSidecarEnabled ? "on" : "off"}`,
    `native sub-agent defaults: ${d ? `${d.model}${d.reasoningEffort ? ` (${d.reasoningEffort})` : ""}` : "not synced"}`,
  ];
}
