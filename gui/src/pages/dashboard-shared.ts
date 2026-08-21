import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import {
  DEFAULT_VISION_TIMEOUT_MS,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
} from "../../../src/vision/timeout-bounds";
import { readJsonOrThrow } from "../fetch-json";
import type { TKey } from "../i18n/shared";
import type { StartupHealthStatus } from "../startup-health-ui";

export type DashboardSection = "overview" | "providers" | "models";

/**
 * `#dashboard/update` is the sidebar's action deep link. It is not a tab, so it resolves
 * to Overview (where the maintenance panel lives) and separately asks the dashboard to
 * open the update dialog.
 */
export const DASHBOARD_UPDATE_HASH = "dashboard/update";

export function readDashboardSectionFromHash(): DashboardSection {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (raw === "dashboard/providers") return "providers";
  if (raw === "dashboard/models") return "models";
  return "overview";
}

/** True while the location hash is the sidebar update deep link. */
export function hashRequestsUpdateDialog(): boolean {
  return window.location.hash.replace(/^#\/?/, "") === DASHBOARD_UPDATE_HASH;
}

/** Overview is the bare `#dashboard`; the other sections carry a suffix. */
export function dashboardHashForSection(section: DashboardSection): string {
  return section === "overview" ? "dashboard" : `dashboard/${section}`;
}

/** Like readJsonOrThrow, but rejects empty/204 bodies that would otherwise yield undefined. */
export async function requireJson<T>(res: Response, fallbackMessage?: string): Promise<T> {
  const data = await readJsonOrThrow<T>(res, fallbackMessage);
  if (data === undefined) throw new Error(fallbackMessage ?? "empty response");
  return data;
}

export interface HealthData { status: string; version: string; uptime: number }
export interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
export interface ModelInfo { id: string; provider: string; namespaced: string; owned_by?: string; reasoningEfforts?: string[] }
export interface SettingsData {
  codexAutoStart: boolean;
  port: number;
  hostname: string;
  /** IANA zone of the machine running the proxy, used to render log timestamps (#725). */
  timeZone?: string;
  startupHealth?: {
    status: "native" | "protected" | "at-risk";
    routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
    autostartEnabled: boolean;
    shimCoverage: "full" | "cli-only" | "none";
    diagnosticStale: boolean;
  };
}
export type SidecarBackend = "openai" | "anthropic";
export type VisionReasoning = "low" | "medium" | "high" | "xhigh" | "max";
export interface SidecarSetting {
  backend?: SidecarBackend;
  model: string;
  reasoning?: VisionReasoning;
  streamRoutedModelOutput?: boolean;
  enabled?: boolean;
  maxDescriptionsPerTurn?: number;
  timeoutMs?: number;
}
export interface VisionModelOption { value: string; label: string; backend: SidecarBackend; baseline?: boolean }
export interface WebSearchModelOption {
  value: string;
  label: string;
  backend: SidecarBackend;
  model: string;
  authSlot?: boolean;
}
export interface WebSearchPickerOption {
  value: string;
  label: string;
  backend?: SidecarBackend;
  model?: string;
}
export interface SidecarData {
  webSearch: SidecarSetting;
  vision: SidecarSetting;
  /** Server-computed eligible describers. Optional: an older server omits it and
   *  the client falls back to the legacy provider-name list rather than showing
   *  an empty picker. */
  visionModels?: VisionModelOption[];
  /** Server-computed runnable web-search models (#2188). Same undefined-vs-[]
   *  contract as visionModels: an older server omits the key and the client
   *  falls back to the legacy list; a current server's [] means none. */
  webSearchModels?: WebSearchModelOption[];
}
export interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string; streamRoutedModelOutput?: boolean };
  vision?: {
    backend?: SidecarBackend | null;
    model?: string;
    reasoning?: VisionReasoning;
    enabled?: boolean;
    maxDescriptionsPerTurn?: number;
    timeoutMs?: number;
  };
}
export interface ShadowCallData { enabled: boolean; model: string; sourceModels?: string[] }
export interface UsageSummary30d { summary: { requests: number; totalTokens: number; coverageRatio: number } }
export type UpdateChannel = "latest" | "preview";
export type Installer = "npm" | "bun" | "source";
export type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";
export interface SyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  nativeSubagentDefaultsWarning?: string;
  staleAppServerHint?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
}
export interface ProjectCodexConfigWarning {
  path: string;
  code: string;
  detail: string;
  message: string;
}
export interface ProjectCodexConfigGroup {
  path: string;
  issues: string[];
  bypass: string;
}
export interface UpdateCheckData {
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}
export interface UpdateJob {
  id: string;
  status: UpdateJobStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  restart: boolean;
  command: string;
  log: string[];
  error?: string;
  restarted?: boolean;
}

export const EFFORT_CAP_LEVELS = ["low", "medium", "high", "xhigh"];
export const UPDATE_CHECK_MAX_AUTO_RETRIES = 2;
export const UPDATE_CHECK_RETRY_BASE_MS = 800;

export function defaultUpdateChannel(version: string | undefined): UpdateChannel {
  return version?.includes("-preview.") ? "preview" : "latest";
}

export function updateReasonLabel(reason: string | undefined, t: (key: TKey) => string): string {
  switch (reason) {
    case "source_checkout": return t("dash.updateReason.source_checkout");
    case "latest_unavailable": return t("dash.updateReason.latest_unavailable");
    case "already_latest": return t("dash.updateReason.already_latest");
    default: return t("dash.updateReason.unknown");
  }
}

export function updateJobLabel(status: UpdateJobStatus, t: (key: TKey) => string): string {
  switch (status) {
    case "running": return t("dash.updateStatus.running");
    case "restarting": return t("dash.updateStatus.restarting");
    case "succeeded": return t("dash.updateStatus.succeeded");
    case "failed": return t("dash.updateStatus.failed");
  }
}

export function mergeSidecarSetting(
  current: SidecarSetting,
  update?: {
    backend?: SidecarBackend | null;
    model?: string;
    reasoning?: VisionReasoning;
    streamRoutedModelOutput?: boolean;
    enabled?: boolean;
    maxDescriptionsPerTurn?: number;
    timeoutMs?: number;
  },
): SidecarSetting {
  const merged = { ...current };
  if (update?.model !== undefined) merged.model = update.model;
  if (update?.backend === null) delete merged.backend;
  else if (update?.backend !== undefined) merged.backend = update.backend;
  if (update?.reasoning !== undefined) merged.reasoning = update.reasoning;
  if (update?.streamRoutedModelOutput !== undefined) merged.streamRoutedModelOutput = update.streamRoutedModelOutput;
  if (update?.enabled !== undefined) merged.enabled = update.enabled;
  if (update?.maxDescriptionsPerTurn !== undefined) merged.maxDescriptionsPerTurn = update.maxDescriptionsPerTurn;
  if (update?.timeoutMs !== undefined) merged.timeoutMs = update.timeoutMs;
  return merged;
}

/** Effort-only edits must not rewrite a custom model or its explicitly selected backend. */
export function visionReasoningPatch(reasoning: VisionReasoning): SidecarPatch {
  return { vision: { reasoning } };
}

export function visionEnabledPatch(enabled: boolean): SidecarPatch {
  return { vision: { enabled } };
}

export function visionMaxDescriptionsPatch(maxDescriptionsPerTurn: number): SidecarPatch {
  return { vision: { maxDescriptionsPerTurn } };
}

export function visionTimeoutPatch(timeoutMs: number): SidecarPatch {
  return { vision: { timeoutMs } };
}

/**
 * Dashboard names for the runtime timeout contract in `src/vision/timeout-bounds.ts`.
 * Pinned by `tests/vision-sidecar-timeout-bounds.test.ts`.
 */
export const VISION_TIMEOUT_MS_DEFAULT = DEFAULT_VISION_TIMEOUT_MS;
export const VISION_TIMEOUT_MS_MAX = MAX_VISION_TIMEOUT_MS;
export const VISION_TIMEOUT_MS_MIN = MIN_VISION_TIMEOUT_MS;
/** Mirrors `DEFAULT_MAX_DESCRIPTIONS_PER_TURN` and is pinned by the timeout-bounds contract test. */
export const VISION_MAX_DESCRIPTIONS_DEFAULT = 8;

export function parsePositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

export function parseVisionTimeoutMs(raw: string): number | undefined {
  const value = parsePositiveInteger(raw);
  if (value === undefined || value < VISION_TIMEOUT_MS_MIN || value > VISION_TIMEOUT_MS_MAX) return undefined;
  return value;
}

export const VISION_REASONING_LEVELS: VisionReasoning[] = ["low", "medium", "high", "xhigh", "max"];

export function visionReasoningLadder(models: ModelInfo[], modelId: string): VisionReasoning[] {
  const model = models.find(m => m.id === modelId);
  const ladder = model?.reasoningEfforts;
  if (!ladder || ladder.length === 0) return [...VISION_REASONING_LEVELS];
  const supported = VISION_REASONING_LEVELS.filter(effort => ladder.includes(effort));
  return supported.length > 0 ? supported : [...VISION_REASONING_LEVELS];
}

/** Do not keep an unsupported persisted rung in the picker; runtime will not honor it. */
export function visionReasoningOptionsFor(ladder: VisionReasoning[], persisted: VisionReasoning): VisionReasoning[] {
  const effective = clampVisionReasoningToLadder(ladder, persisted);
  return ladder.includes(effective) ? ladder : [effective, ...ladder];
}

/** Match server normalization: never escalate when a lower/equal supported rung exists. */
export function clampVisionReasoningToLadder(
  ladder: VisionReasoning[],
  persisted: VisionReasoning,
): VisionReasoning {
  if (ladder.length === 0 || ladder.includes(persisted)) return persisted;
  const requestedRank = VISION_REASONING_LEVELS.indexOf(persisted);
  let best = ladder[0];
  let bestRank = VISION_REASONING_LEVELS.indexOf(best);
  for (const effort of ladder) {
    const rank = VISION_REASONING_LEVELS.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  // When every supported rung is above the request, use the lowest supported rung.
  return best;
}

export function sidecarModelOptions(models: ModelInfo[]) {
  const out: Array<{ value: string; label: string }> = [];
  for (const model of models) {
    if (model.provider === "openai" || model.provider === "anthropic") {
      out.push({ value: model.id, label: `${model.provider}/${model.id}` });
    }
  }
  return out;
}

/**
 * Server list when present, else the legacy openai+anthropic list — the same
 * undefined-vs-[] contract visionModelOptions documents. The persisted model is
 * grandfathered into the list so the picker can DISPLAY a now-illegal setting;
 * the server still rejects new writes of it.
 */
export function webSearchModelOptionsForPicker(
  serverOptions: WebSearchModelOption[] | undefined,
  models: ModelInfo[],
  current: string | undefined,
  currentBackend?: SidecarBackend,
): WebSearchPickerOption[] {
  if (serverOptions === undefined) {
    const legacy: WebSearchPickerOption[] = sidecarModelOptions(models);
    if (current && !legacy.some(option => option.value === current)) {
      legacy.unshift({
        value: current,
        label: current,
        ...(currentBackend ? { backend: currentBackend } : {}),
        model: current,
      });
    }
    return legacy;
  }
  const out: WebSearchPickerOption[] = serverOptions.map(option => ({
    value: option.value,
    label: option.label,
    backend: option.backend,
    model: option.model,
  }));
  if (current && !out.some(option => option.value === current)) {
    out.unshift({
      value: current,
      label: current,
      ...(currentBackend ? { backend: currentBackend } : {}),
      model: current,
    });
  }
  return out;
}

/**
 * Server list when present, else the legacy openai+anthropic list.
 *
 * `undefined` and `[]` mean different things and must not be collapsed. A server that
 * predates this field sends no key at all, and falling back to the provider-name list is
 * the documented degrade path for it. A current server that sends `[]` has computed that
 * nothing is eligible, and repopulating the picker from `/api/models` would put back
 * exactly the text-only rows this feature exists to remove.
 *
 * `currentBackend` is the backend already persisted for `current`. It travels with the
 * grandfathered entry because the legacy fallback path has no server backend to read and
 * would otherwise infer one from `/api/models`, where anything not literally provided by
 * "anthropic" reads as OpenAI — silently rewriting a working Anthropic describer on the
 * next save. What is already stored is better evidence than a guess.
 */
export function visionModelOptions(
  serverOptions: VisionModelOption[] | undefined,
  models: ModelInfo[],
  current: string | undefined,
  currentBackend?: SidecarBackend,
): Array<{ value: string; label: string; backend?: SidecarBackend }> {
  const options = serverOptions
    ? serverOptions.map(option => ({ value: option.value, label: option.label, backend: option.backend }))
    : sidecarModelOptions(models);
  if (current && !options.some(option => option.value === current)) {
    options.unshift({ value: current, label: current, ...(currentBackend ? { backend: currentBackend } : {}) });
  }
  return options;
}

/** Options for shadow-call replacement models use the proxy's canonical routing id. */
export function shadowCallModelOptions(models: ModelInfo[], current: string | undefined) {
  const out = [{ value: "", label: "—" }, ...models.map(model => ({ value: model.namespaced, label: model.namespaced }))];
  if (current && !out.some(option => option.value === current)) out.push({ value: current, label: current });
  return out;
}

export function sidecarBackendForModel(models: ModelInfo[], modelId: string): SidecarBackend {
  return models.find(model => model.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai";
}

/** Server provenance wins; catalog inference supports only legacy option rows. */
export function webSearchSidecarSelectionForModel(
  models: ModelInfo[],
  options: WebSearchPickerOption[],
  modelId: string,
): { backend: SidecarBackend; model: string } {
  const option = options.find(entry => entry.value === modelId);
  return {
    backend: option?.backend ?? sidecarBackendForModel(models, modelId),
    model: option?.model ?? modelId,
  };
}

/** Server eligibility is authoritative; catalog inference only supports legacy picker entries. */
export function visionSidecarBackendForModel(
  models: ModelInfo[],
  options: Array<{ value: string; backend?: SidecarBackend }>,
  modelId: string,
): SidecarBackend {
  return options.find(option => option.value === modelId)?.backend ?? sidecarBackendForModel(models, modelId);
}

let lastInputWasKeyboard = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", () => { lastInputWasKeyboard = true; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInputWasKeyboard = false; }, { capture: true, passive: true });
}

function focusTriggerQuietly(trigger: HTMLButtonElement | null) {
  if (!trigger) return;
  if (lastInputWasKeyboard) {
    trigger.focus({ preventScroll: true });
    return;
  }
  try {
    trigger.focus({ preventScroll: true, focusVisible: false });
  } catch {
    trigger.focus({ preventScroll: true });
  }
}

export function useModalDialog(open: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }

    if (dialog.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [open, triggerRef]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [triggerRef]);

  return dialogRef;
}

export type { StartupHealthStatus };
