/**
 * SubagentsWorkspace: a single stacked column for the Subagents tab, holding the delegation
 * settings and the fallback chain. The pinned roster is not here; it lives in the Models page
 * client model picker section, and the Subagents page only points at it.
 */
import type { ReactNode } from "react";
import { useT } from "../../i18n/shared";
import { sectionAnchorId } from "../../section-anchors";
import SubagentDelegationSection from "./SubagentDelegationSection";
import type { DelegationPatch, DelegationModelOption, UltraModePatch, UltraModeState } from "../../pages/use-subagent-delegation";

export interface SubagentsWorkspaceProps {
  fallbackAvailable?: string[];
  fallback: string[];
  fallbackPollMs: number;
  fallbackBusy: boolean;
  onFallbackChange: (models: string[]) => void;
  onFallbackPollMsChange: (pollMs: number) => void;
  onFallbackSave: () => void;
  delegation: {
    apiBase: string;
    model: string;
    effort: string;
    efforts: string[];
    available: DelegationModelOption[];
    guidanceEnabled: boolean;
    syncCodexDefaults: boolean;
    saving: boolean;
    onSave: (patch: DelegationPatch) => void;
    ultraMode: UltraModeState;
    ultraSaving: boolean;
    onUltraModeSave: (patch: UltraModePatch) => void;
    ultraLoadFailed: boolean;
    onUltraModeRetry: () => void;
  };
  /** Further settings panels (Claude Code pin, workflow limits) under the delegation panel. */
  settingsExtra?: ReactNode;
}

export default function SubagentsWorkspace({
  fallbackAvailable,
  fallback, fallbackPollMs, fallbackBusy, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
  delegation,
  settingsExtra,
}: SubagentsWorkspaceProps) {
  const t = useT();

  return (
    <div className="subagents-workspace-shell">
      <div className="subagents-workspace-root flex flex-col gap-4">
        <section
          id={sectionAnchorId("subagents", "settings")}
          className="subagents-workspace-section flex flex-col gap-4"
          aria-label={t("sub.settings")}
        >
          <SubagentDelegationSection
            id={sectionAnchorId("subagents", "delegation")}
            apiBase={delegation.apiBase}
            model={delegation.model}
            effort={delegation.effort}
            efforts={delegation.efforts}
            available={delegation.available}
            guidanceEnabled={delegation.guidanceEnabled}
            syncCodexDefaults={delegation.syncCodexDefaults}
            saving={delegation.saving}
            onSave={delegation.onSave}
            ultraMode={delegation.ultraMode}
            ultraSaving={delegation.ultraSaving}
            onUltraModeSave={delegation.onUltraModeSave}
            ultraLoadFailed={delegation.ultraLoadFailed}
            onUltraModeRetry={delegation.onUltraModeRetry}
            fallback={fallback}
            fallbackPollMs={fallbackPollMs}
            fallbackBusy={fallbackBusy}
            availableModels={fallbackAvailable ?? []}
            onFallbackChange={onFallbackChange}
            onFallbackPollMsChange={onFallbackPollMsChange}
            onFallbackSave={onFallbackSave}
          />
          {settingsExtra}
        </section>
      </div>
    </div>
  );
}
