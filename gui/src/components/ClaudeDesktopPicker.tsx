import { useState } from "react";
import { useI18n, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";

export type DesktopPickerReason =
  | "active"
  | "restart_required"
  | "unsupported_platform"
  | "not_first_party"
  | "integration_off"
  | "disabled"
  | "proxy_unavailable"
  | "mode_not_committed"
  | "trust_pending"
  | "trust_declined"
  | "profile_failed";

export type DesktopPickerTrust = "trusted" | "untrusted" | "unsupported" | "unknown";
export type DesktopPickerProfile = "absent" | "applied" | "not_selected" | "unsafe";

export interface DesktopPickerStatus {
  desired: boolean;
  supported: boolean;
  trust: DesktopPickerTrust;
  profile: DesktopPickerProfile;
  listenerReady: boolean;
  effective: boolean;
  reason: DesktopPickerReason;
  models: number;
  snapshotAt: number | null;
  lastBootstrapAt: number | null;
  hint?: string;
  residual?: string[];
}

function isDesktopPickerStatus(value: unknown): value is DesktopPickerStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.desired === "boolean"
    && typeof v.supported === "boolean"
    && ["trusted", "untrusted", "unsupported", "unknown"].includes(v.trust as string)
    && ["absent", "applied", "not_selected", "unsafe"].includes(v.profile as string)
    && typeof v.listenerReady === "boolean"
    && typeof v.effective === "boolean"
    && ["active", "restart_required", "unsupported_platform", "not_first_party", "integration_off", "disabled", "proxy_unavailable", "mode_not_committed", "trust_pending", "trust_declined", "profile_failed"].includes(v.reason as string)
    && typeof v.models === "number" && Number.isFinite(v.models) && v.models >= 0
    && (v.snapshotAt === null || typeof v.snapshotAt === "number")
    && (v.lastBootstrapAt === null || typeof v.lastBootstrapAt === "number")
    && (v.hint === undefined || typeof v.hint === "string")
    && (v.residual === undefined || (Array.isArray(v.residual) && v.residual.every(item => typeof item === "string")));
}

function stateKey(reason: DesktopPickerReason): TKey {
  switch (reason) {
    case "active": return "claudeDesktop.picker.state.active";
    case "restart_required": return "claudeDesktop.picker.state.restart";
    case "trust_pending": return "claudeDesktop.picker.state.trustPending";
    case "trust_declined": return "claudeDesktop.picker.state.trustDeclined";
    case "proxy_unavailable": return "claudeDesktop.picker.state.proxyUnavailable";
    case "unsupported_platform": return "claudeDesktop.picker.state.unsupported";
    case "profile_failed": return "claudeDesktop.picker.state.profileFailed";
    case "not_first_party":
    case "integration_off":
    case "disabled":
    case "mode_not_committed":
      return "claudeDesktop.picker.state.notFirstParty";
  }
}

export default function ClaudeDesktopPicker({
  apiBase,
  picker,
  onUpdated,
}: {
  apiBase: string;
  picker: DesktopPickerStatus;
  onUpdated?: (picker: DesktopPickerStatus) => void;
}) {
  const { t } = useI18n();
  const [localPicker, setLocalPicker] = useState<DesktopPickerStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = localPicker ?? picker;

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop/picker`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !current.desired, persist: true }),
      });
      let payload: { ok?: boolean; picker?: DesktopPickerStatus } | undefined;
      if (response.ok) {
        payload = await readJsonOrThrow<{ ok?: boolean; picker?: DesktopPickerStatus }>(
          response,
          t("claudeDesktop.updateFailed"),
        );
      } else {
        // A refused enable is a useful status response (not a transport failure); 503
        // carries the controller's reason so the card can explain the missing proxy.
        try {
          payload = await response.json() as { ok?: boolean; picker?: DesktopPickerStatus };
        } catch {
          throw new Error(t("claudeDesktop.updateFailed"));
        }
        if (!payload.picker) throw new Error(t("claudeDesktop.updateFailed"));
      }
      if (!payload || payload.ok !== true && !payload.picker || !payload.picker || !isDesktopPickerStatus(payload.picker)) {
        throw new Error(t("claudeDesktop.updateFailed"));
      }
      setLocalPicker(payload.picker);
      onUpdated?.(payload.picker);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("claudeDesktop.updateFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="claude-picker" aria-labelledby="claude-picker-title">
      <div className="claude-picker-header">
        <div className="claude-picker-copy">
          <h3 id="claude-picker-title" className="claude-picker-title">{t("claudeDesktop.picker.title")}</h3>
          <p className="claude-picker-hint">{t("claudeDesktop.picker.hint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          className={`toggle ${current.desired ? "on" : ""}`}
          aria-checked={current.desired}
          aria-label={t("claudeDesktop.picker.toggle")}
          disabled={pending}
          onClick={() => void toggle()}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      <p className={`claude-picker-state claude-picker-state-${current.reason}`} aria-live="polite">
        <span className="claude-picker-state-dot" aria-hidden="true" />
        <span>{t(stateKey(current.reason))}</span>
        {current.reason === "trust_pending" && current.hint && <code>{current.hint}</code>}
      </p>
      <p className="claude-picker-models">
        {t("claudeDesktop.picker.models", { count: current.models })}
      </p>
      <p className="claude-picker-offline-note" role="note">{t("claudeDesktop.picker.offlineNote")}</p>
    </section>
  );
}
