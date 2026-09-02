/**
 * One row model for every client the Integrations page can reach.
 *
 * The overview used to read a single route, `/api/client-integrations`, which
 * answers only for the eight file-toggle clients. A user with Claude Code
 * connected and a Grok fence written was told "applied: 0" while three
 * integrations were live one tab away. Five more sources join the grid here,
 * each with its own payload shape, mapped to the badge vocabulary the file
 * clients already established.
 *
 * `unknown` is the state that keeps this honest: an unsettled or failed source
 * is NOT "not applied", and it is counted in neither summary number.
 */

import type { TKey } from "../../i18n/shared";
import type { VisualIntegrationState } from "./IntegrationStateBadge";
import {
  FILE_INTEGRATION_CLIENTS,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";
import type { NativeIntegrationClientId, NativeStatus } from "./native-api";
import { CURSOR_SEEN_WINDOW_MS, type CursorIntegrationStatus } from "./cursor-api";

export type OverviewClientId =
  | "codex"
  | "claude"
  | "claudeDesktop"
  | "grok"
  | "cursor"
  | FileIntegrationClientId;

/** How far the `/api/keys` read has got, since the count alone cannot say. */
export type ApiKeyReadPhase = "checking" | "unavailable" | "settled";

/**
 * The credential row, deliberately NOT an `OverviewRow`.
 *
 * API keys cannot be installed, toggled, or drift from a config file, so they
 * have no `installed`, `applied`, `toggle`, or `status`. Re-adding one would
 * recreate the semantic leak this shape removes.
 *
 * `state` uses credential vocabulary rather than the client
 * `unknown|absent|current` triple, because those words carry "applied" —
 * `IntegrationStateBadge` renders them as "Applied" and "Not applied" in all
 * six locales, which is exactly the claim a credential row must never make.
 */
export interface ApiKeysOverviewRow {
  hash: "integrations/keys";
  labelKey: TKey;
  state: "checking" | "unavailable" | "none-issued" | "issued";
  detailKey: TKey | null;
  detailVars: Record<string, string> | null;
}

export interface OverviewRows {
  keysRow: ApiKeysOverviewRow;
  rows: OverviewRow[];
}

export interface OverviewRow {
  id: OverviewClientId;
  /** Tab this card opens. Claude Desktop opens Claude's nested route. */
  hash: string;
  labelKey: TKey;
  state: VisualIntegrationState;
  /** Detected on this machine — drives the "detected" summary count. */
  installed: boolean;
  /** Drives the "applied" summary count. */
  applied: boolean;
  /** Desired switch position; separate from observed application. */
  toggleOn?: boolean;
  /**
   * The one line under the title. File clients show their config path — the
   * thing a user copies when a refusal tells them to finish by hand. The other
   * five have no path, so they carry the single fact that explains their badge;
   * `detailKey` is translated by the card, `detail` is already-literal text.
   */
  detail: string | null;
  detailKey: TKey | null;
  detailVars: Record<string, string> | null;
  /**
   * The client toggled by the inline switch; null means navigation only.
   * Native clients use their wire ids (`claude-desktop`), which differ from the
   * camelCase row id (`claudeDesktop`) — the toggle names the API target.
   */
  toggle: OverviewClientId | NativeIntegrationClientId | null;
  /** A read-time refusal that disables the switch before a doomed mutation. */
  toggleBlocked: NativeStatus["disableBlocked"];
  /** Live native path used by the consequence dialog and localized refusals. */
  togglePath: string | null;
  /** Set only for a file client whose live status is still needed by the card. */
  status: IntegrationStatus | null;
}

/** Minimal reads. Each route returns far more than the overview needs. */
export interface CodexRoutingPayload {
  routingInjected?: boolean;
  status?: string;
  recommendedCommand?: string | null;
}
export interface ClaudeCodePayload {
  enabled?: boolean;
  authMode?: string;
}
export interface ClaudeDesktopPayload {
  desiredEnabled?: boolean;
  installed?: boolean;
  observedKind?: string;
  applied?: boolean;
  stale?: boolean;
  drift?: boolean;
  driftReason?: string | null;
  activeProfile?: boolean | null;
  appliedAt?: string | null;
}
export interface GrokPayload {
  present?: boolean;
  models?: unknown[];
}

export interface OverviewSources {
  /** File-client rows; an empty array means the list has not settled. */
  clients: readonly IntegrationStatus[];
  clientsSettled: boolean;
  codex: CodexRoutingPayload | null;
  keyCount: number | null;
  /**
   * Read phase for `keyCount`. Separate because a settled zero and a failed
   * read are both null-adjacent facts that must not render the same way.
   */
  keyPhase: ApiKeyReadPhase;
  claude: ClaudeCodePayload | null;
  claudeDesktop: ClaudeDesktopPayload | null;
  grok: GrokPayload | null;
  cursor: CursorIntegrationStatus | null;
  native: NativeStatus[] | null;
  nativeSettled: boolean;
}

const FILE_LABEL_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.tab.opencode",
  pi: "integrations.tab.pi",
  omp: "integrations.tab.omp",
  hermes: "integrations.tab.hermes",
  openclaw: "integrations.tab.openclaw",
  kimi: "integrations.tab.kimi",
  gajae: "integrations.tab.gajae",
  dsh: "integrations.tab.dsh",
  mcode: "integrations.tab.mcode",
  zcode: "integrations.tab.zcode",
  prime: "integrations.tab.prime",
  aside: "integrations.tab.aside",
};

/** A file client's block is in the file for both `current` and `stale`. */
/**
 * Journal operation kinds to their labels.
 *
 * Lives here rather than beside the rollback components because a module that
 * exports both a component and a constant breaks React fast refresh, and both
 * Integrations surfaces plus their tests need this map.
 */
export const JOURNAL_KIND_KEY: Record<IntegrationJournalRow["kind"], TKey> = {
  apply: "integrations.kind.apply",
  disable: "integrations.kind.disable",
  refresh: "integrations.kind.refresh",
  restore: "integrations.kind.restore",
  /*
   * Distinct from `apply` on purpose. This row is the only signal that an
   * operation replaced a block somebody else wrote, and it sits in the one list
   * a user reads after a mistake.
   */
  overwrite: "integrations.kind.overwrite",
};

export function isAppliedState(state: VisualIntegrationState): boolean {
  return state === "current" || state === "stale";
}

/**
 * Codex CLI.
 *
 * `routingInjected` — server-derived as `routingKind === "opencodex-local"` —
 * is the only field that answers "is opencodex in Codex's path right now".
 * `status` mixes in service viability and reboot safety, which is the Startup
 * page's question, so a `protected` status with no injected routing still
 * reads as not applied here.
 */
function codexRow(payload: CodexRoutingPayload | null): OverviewRow {
  const base = {
    id: "codex" as const,
    hash: "integrations/codex",
    labelKey: "integrations.tab.codex" as TKey,
    toggle: "codex" as const,
    toggleBlocked: null,
    togglePath: null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
  // The proxy answering at all means Codex CLI is present: it is the client
  // this product exists for, and there is no separate detection probe.
  if (payload.routingInjected !== true) {
    return {
      ...base,
      state: "absent",
      installed: true,
      applied: false,
      // The command that would fix it beats a restatement of the badge.
      detail: payload.recommendedCommand ?? null,
      detailKey: payload.recommendedCommand ? null : "integrations.detail.codexAbsent",
    };
  }
  return {
    ...base,
    state: payload.status === "error" ? "stale" : "current",
    installed: true,
    applied: true,
    detailKey: "integrations.detail.codexRouted",
  };
}

/** API keys are issued or not; there is no config file to drift. */
function keysRow(phase: ApiKeyReadPhase, count: number | null): ApiKeysOverviewRow {
  const base = {
    hash: "integrations/keys" as const,
    labelKey: "integrations.tab.keys" as TKey,
  };
  // Every branch names a detail key. The detail line is the ONLY state
  // expression — there is no badge — so a null one would render a row with no
  // state at all.
  if (phase === "checking") {
    return { ...base, state: "checking", detailKey: "integrations.detail.keyChecking", detailVars: null };
  }
  // `count === null` is defensive: a failed read is already `unavailable`, and
  // claiming "no keys issued" because a request failed is a statement about the
  // account of the user that we cannot support.
  if (phase === "unavailable" || count === null) {
    return { ...base, state: "unavailable", detailKey: "integrations.detail.keyUnavailable", detailVars: null };
  }
  return {
    ...base,
    state: count > 0 ? "issued" : "none-issued",
    detailKey: count > 0 ? "integrations.detail.keyCount" : "integrations.detail.keyNone",
    detailVars: count > 0 ? { count: String(count) } : null,
  };
}

/** `enabled` is the connection switch that used to live in the sidebar. */
function claudeDetailKey(payload: ClaudeCodePayload | null): TKey | null {
  if (!payload) return null;
  if (payload.enabled !== true) return "integrations.detail.claudeOff";
  return payload.authMode === "subscription"
    ? "claude.authModeSubscription"
    : payload.authMode === "proxy"
      ? "claude.authModeProxy"
      : payload.authMode === "auto"
        ? "claude.authModeAuto"
        : null;
}

function claudeRow(
  payload: ClaudeCodePayload | null,
  native: NativeStatus | undefined,
  nativeSettled: boolean | undefined,
): OverviewRow {
  const base = {
    id: "claude" as const,
    hash: "integrations/claude",
    labelKey: "integrations.tab.claude" as TKey,
    toggle: "claude" as const,
    toggleBlocked: native?.disableBlocked ?? null,
    togglePath: native?.configPath ?? null,
    status: null,
    detail: null,
    detailVars: null,
  };
  const detailKey = claudeDetailKey(payload);
  // Compatibility for non-overview callers written before the native source
  // existed. The live page always passes nativeSettled explicitly.
  if (nativeSettled === undefined) {
    if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey };
    const enabled = payload.enabled === true;
    return { ...base, state: enabled ? "current" : "absent", installed: true, applied: enabled, detailKey };
  }
  if (!nativeSettled) {
    return { ...base, state: "unknown", installed: false, applied: false, detailKey };
  }
  if (!native) {
    return { ...base, toggle: null, state: "unknown", installed: false, applied: false, detailKey };
  }
  return {
    ...base,
    state: native.state,
    installed: native.installed,
    applied: native.state === "current",
    detailKey,
  };
}

/**
 * Claude Desktop.
 *
 * `activeProfile === false` is a real applied-but-not-in-effect state: our
 * profile exists in the config library while Desktop serves a different one.
 * It folds into `stale` — the amber badge already means "our block is there
 * but is not what it should be" — rather than claiming a green connection
 * Desktop is not honoring. `null` is undeterminable and must not downgrade a
 * healthy `current`.
 */
function claudeDesktopRow(
  payload: ClaudeDesktopPayload | null,
  native: NativeStatus | undefined,
  nativeSettled: boolean,
): OverviewRow {
  const base = {
    id: "claudeDesktop" as const,
    hash: "integrations/claude/desktop",
    // "Desktop" alone is ambiguous next to ten other client names.
    labelKey: "claudeDesktop.title" as TKey,
    toggle: "claude-desktop" as const,
    toggleBlocked: native?.disableBlocked ?? null,
    togglePath: native?.configPath ?? null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload || !nativeSettled || !native || typeof payload.desiredEnabled !== "boolean") {
    return { ...base, toggle: null, state: "unknown", installed: false, applied: false, detailKey: null };
  }
  const toggleOn = payload.desiredEnabled;
  // Desired OFF keeps the switch off, but a still-selected gateway is not
  // "absent": Desktop is still routing through OpenCodex until cleanup lands.
  if (!toggleOn) {
    const gatewayStillSelected = payload.applied === true
      || payload.driftReason === "desired_off_gateway_selected";
    if (gatewayStillSelected) {
      return {
        ...base,
        state: "stale",
        installed: payload.installed === true,
        applied: true,
        toggleOn: false,
        detailKey: "integrations.detail.desktopDesiredOffCleanupPending",
      };
    }
    return {
      ...base,
      state: "absent",
      installed: payload.installed === true,
      applied: false,
      toggleOn: false,
      detailKey: "integrations.detail.desktopDesiredOff",
    };
  }
  if (payload.applied !== true) {
    return {
      ...base,
      state: "absent",
      installed: payload.installed === true,
      applied: false,
      toggleOn,
      detailKey: "integrations.detail.desktopDesiredOnNotApplied",
    };
  }
  const drifted = payload.stale === true || payload.activeProfile === false;
  return {
    ...base,
    state: drifted ? "stale" : "current",
    installed: true,
    applied: true,
    toggleOn,
    // Separate sentences: a drifted file and a profile Desktop is not serving
    // are different problems with different fixes.
    detailKey: payload.activeProfile === false
      ? "integrations.detail.desktopNotServed"
      : drifted
        ? "integrations.detail.desktopStale"
        : "integrations.detail.desktopCurrent",
  };
}

/**
 * Grok Build.
 *
 * The route answers `present: false` both when Grok is not installed and when
 * it is installed without our fence, and the payload cannot separate them.
 * Reporting "not installed" for an unfenced install is the safer error: the
 * card still navigates and the Grok tab tells the true story.
 */
function grokDetail(payload: GrokPayload | null): Pick<OverviewRow, "detailKey" | "detailVars"> {
  if (!payload) return { detailKey: null, detailVars: null };
  const present = payload.present === true;
  return {
    detailKey: present ? "integrations.detail.grokModels" : "integrations.detail.grokAbsent",
    detailVars: present ? { count: String(payload.models?.length ?? 0) } : null,
  };
}

function grokRow(
  payload: GrokPayload | null,
  native: NativeStatus | undefined,
  nativeSettled: boolean | undefined,
): OverviewRow {
  const base = {
    id: "grok" as const,
    hash: "integrations/grok",
    labelKey: "integrations.tab.grok" as TKey,
    toggle: "grok" as const,
    toggleBlocked: native?.disableBlocked ?? null,
    togglePath: native?.configPath ?? null,
    status: null,
    detail: null,
  };
  const detail = grokDetail(payload);
  if (nativeSettled === undefined) {
    if (!payload) return { ...base, state: "unknown", installed: false, applied: false, ...detail };
    const present = payload.present === true;
    return { ...base, state: present ? "current" : "absent", installed: present, applied: present, ...detail };
  }
  if (!nativeSettled) {
    return { ...base, state: "unknown", installed: false, applied: false, ...detail };
  }
  if (!native) {
    return { ...base, toggle: null, state: "unknown", installed: false, applied: false, ...detail };
  }
  return {
    ...base,
    state: native.state,
    installed: native.installed,
    applied: native.state === "current",
    ...detail,
  };
}


/**
 * Cursor has no switch: its gateway is configured inside Cursor, and this proxy never
 * writes there. "Applied" therefore means a Cursor client actually called us recently.
 */
function cursorRow(payload: CursorIntegrationStatus | null, now = Date.now()): OverviewRow {
  const base = {
    id: "cursor" as const,
    hash: "integrations/cursor",
    labelKey: "integrations.tab.cursor" as TKey,
    toggle: null,
    toggleBlocked: null,
    togglePath: null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
  if (!payload.privateInference.installed) {
    return { ...base, state: "not-installed", installed: false, applied: false, detailKey: "integrations.detail.cursorAbsent" };
  }
  const seenRecently = payload.lastSeen !== null && now - payload.lastSeen.at < CURSOR_SEEN_WINDOW_MS;
  return {
    ...base,
    state: seenRecently ? "current" : "absent",
    installed: true,
    applied: seenRecently,
    detailKey: seenRecently ? "integrations.detail.cursorSeen" : "integrations.detail.cursorNeverSeen",
  };
}

function fileRow(status: IntegrationStatus): OverviewRow {
  return {
    id: status.clientId,
    hash: `integrations/${status.clientId}`,
    labelKey: FILE_LABEL_KEY[status.clientId],
    // The badge collapses an uninstalled client to "not installed" regardless
    // of its file state; do the same here so the grid and the count agree.
    state: status.installed ? status.state : "not-installed",
    installed: status.installed,
    applied: status.installed && isAppliedState(status.state),
    detail: status.configPath,
    detailKey: null,
    detailVars: null,
    toggle: status.clientId,
    toggleBlocked: null,
    togglePath: status.configPath,
    status,
  };
}

/**
 * Catalog order: the two surfaces every user has, then the three native
 * clients, then the file clients in their existing order. It matches the tab
 * strip above the grid, so the eye moves the same way in both.
 */
export function buildOverviewRows(sources: OverviewSources): OverviewRows {
  const nativeClaude = sources.native?.find(status => status.clientId === "claude");
  const nativeGrok = sources.native?.find(status => status.clientId === "grok");
  // One lookup table, not a find per client (react-doctor js-index-maps).
  const statusByClient = new Map(sources.clients.map(status => [status.clientId, status]));
  const rows: OverviewRow[] = [
    codexRow(sources.codex),
    claudeRow(sources.claude, nativeClaude, sources.nativeSettled),
    claudeDesktopRow(
      sources.claudeDesktop,
      sources.native?.find(client => client.clientId === "claude-desktop"),
      sources.nativeSettled,
    ),
    grokRow(sources.grok, nativeGrok, sources.nativeSettled),
    cursorRow(sources.cursor),
  ];
  for (const clientId of FILE_INTEGRATION_CLIENTS) {
    const status = statusByClient.get(clientId);
    if (status) {
      rows.push(fileRow(status));
      continue;
    }
    // A file client missing from a SETTLED list is a server-side omission and
    // is dropped, as before. Before the list settles every one of them is
    // unknown rather than silently absent.
    if (!sources.clientsSettled) {
      rows.push({
        id: clientId,
        hash: `integrations/${clientId}`,
        labelKey: FILE_LABEL_KEY[clientId],
        state: "unknown",
        installed: false,
        applied: false,
        detail: null,
        detailKey: null,
        detailVars: null,
        toggle: null,
        toggleBlocked: null,
        togglePath: null,
        status: null,
      });
    }
  }
  return { keysRow: keysRow(sources.keyPhase, sources.keyCount), rows };
}

export interface OverviewCounts {
  detected: number;
  applied: number;
  stale: number;
  unknown: number;
}

export function countOverviewRows(rows: readonly OverviewRow[]): OverviewCounts {
  return {
    detected: rows.filter(row => row.installed).length,
    applied: rows.filter(row => row.applied).length,
    stale: rows.filter(row => row.state === "stale").length,
    unknown: rows.filter(row => row.state === "unknown").length,
  };
}
