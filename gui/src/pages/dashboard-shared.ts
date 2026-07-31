import type { RefObject } from "react";
import { useEffect, useRef } from "react";
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
export interface ModelInfo { id: string; provider: string; owned_by?: string }
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
export interface SidecarSetting { backend?: SidecarBackend; model: string }
export interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
export interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string };
  vision?: { backend?: SidecarBackend | null; model?: string };
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
  update?: { backend?: SidecarBackend | null; model?: string },
): SidecarSetting {
  const merged = { ...current };
  if (update?.model !== undefined) merged.model = update.model;
  if (update?.backend === null) delete merged.backend;
  else if (update?.backend !== undefined) merged.backend = update.backend;
  return merged;
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

export function sidecarBackendForModel(models: ModelInfo[], modelId: string): SidecarBackend {
  return models.find(model => model.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai";
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
