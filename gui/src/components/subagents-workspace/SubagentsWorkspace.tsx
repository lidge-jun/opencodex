/**
 * SubagentsWorkspace — a single stacked column for the Subagents tab: the featured roster
 * (reorder; every edit saves itself), the model picker, then the settings.
 *
 * The previous rail layout listed the featured models twice — once as a rail group, once in
 * the main pane — which read as a rendering bug rather than two views of one thing. There is
 * also nothing here that needs two panes: picking a model is one toggle, and the per-model
 * detail pane carried no information the row did not already show.
 *
 * The roster reads like an editable plan (React Bits `agent-plan-2`): numbered rows with bare
 * move and remove icons, and the slots still free shown as empty rows, so "how many more can I
 * add" needs no counting. The picker is a filterable table (`data-table-1`) whose add button
 * turns into the selected (inverse) state once a model is in the order.
 *
 * The sticky strip is the same `SectionTabs` the Logs and Usage tabs use: every section stays
 * in the document and scrolling still works: the strip only jumps to one and reports where
 * you are.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconPlus,
  IconSearch,
  IconX,
} from "../../icons";
import { useT } from "../../i18n/shared";
import { Trans } from "../../i18n/provider";
import { modelLabel } from "../../model-display";
import { SectionTabs } from "../section-tabs";
import { sectionAnchorId } from "../../section-anchors";
import { cn } from "@/lib/utils";
import { CountPill, Frame, FrameBody, HelpTip } from "../v2-subagents/frame";
import { iconButton, stepIndicator } from "../v2-subagents/frame-classes";
import SubagentDelegationSection from "./SubagentDelegationSection";
import type { DelegationPatch, DelegationModelOption, UltraModePatch, UltraModeState } from "../../pages/use-subagent-delegation";

export interface SubagentsWorkspaceProps {
  available: string[];
  fallbackAvailable?: string[];
  chosen: string[];
  onToggle: (m: string) => void;
  onMove: (i: number, dir: -1 | 1) => void;
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

export const FEATURED_MAX = 5;

export default function SubagentsWorkspace({
  available,
  fallbackAvailable,
  chosen,
  onToggle,
  onMove,
  fallback, fallbackPollMs, fallbackBusy, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
  delegation,
  settingsExtra,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const full = chosen.length >= FEATURED_MAX;
  const freeSlots = Math.max(0, FEATURED_MAX - chosen.length);

  const availableFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !q || m.toLowerCase().includes(q));
  }, [available, query]);

  const tabs = useMemo(() => [
    { id: "featured", label: t("sub.featured"), meta: `${chosen.length}/${FEATURED_MAX}` },
    { id: "models", label: t("sub.models"), meta: String(availableFiltered.length) },
    { id: "settings", label: t("sub.settings") },
  ], [t, chosen.length, availableFiltered.length]);

  return (
    <div className="subagents-workspace-shell">
      <SectionTabs scope="subagents" items={tabs} ariaLabel={t("sub.sections")} />
      <div className="subagents-workspace-root flex flex-col gap-4">
        <Frame
          id={sectionAnchorId("subagents", "featured")}
          className="subagents-workspace-section"
          headClassName="swi-featured-head"
          title={<span className="swi-featured-title">{t("sub.featured")}</span>}
          meta={<>
            <CountPill><span className="swi-featured-count">{chosen.length}/{FEATURED_MAX}</span></CountPill>
            {/* One-time teaching ("this order is the picker order") rides on a focusable
                "?" beside the counter instead of a paragraph above the list. */}
            <HelpTip label={t("sub.orderHintAria")}><Trans k="sub.orderHint" cmd="spawn_agent" /></HelpTip>
          </>}
          lede={t("subagentsV2.featuredLede")}
        >
          <FrameBody as="ol">
            {chosen.map((m, i) => (
              <li key={m} className="swi-featured-row flex min-h-11 min-w-0 items-center gap-3 py-1.5 pr-2 pl-3 transition-colors hover:bg-surface/60">
                <span className={cn(stepIndicator, "bg-surface text-fg ring-line-strong")}>{i + 1}</span>
                <span className="swi-featured-name min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{modelLabel(m)}</span>
                <span className="swi-featured-actions flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className={iconButton}
                    onClick={() => onMove(i, -1)}
                    disabled={i === 0}
                    aria-label={t("sub.moveUp", { m })}
                  >
                    <IconArrowUp />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    onClick={() => onMove(i, 1)}
                    disabled={i === chosen.length - 1}
                    aria-label={t("sub.moveDown", { m })}
                  >
                    <IconArrowDown />
                  </button>
                  <button
                    type="button"
                    className={cn(iconButton, "hover:bg-danger-soft hover:text-danger")}
                    onClick={() => onToggle(m)}
                    aria-label={t("sub.removeAria", { m })}
                  >
                    <IconX />
                  </button>
                </span>
              </li>
            ))}
            {Array.from({ length: freeSlots }, (_, k) => (
              <li key={`free-${k}`} className="flex min-h-11 min-w-0 items-center gap-3 py-1.5 pr-2 pl-3 text-[13px] text-fg-subtle">
                <span className={cn(stepIndicator, "border border-dashed border-line-strong text-fg-subtle ring-0")} aria-hidden="true">{chosen.length + k + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {chosen.length === 0 && k === 0 ? t("sub.noneSelected") : t("subagentsV2.emptySlot")}
                </span>
              </li>
            ))}
          </FrameBody>
        </Frame>

        <Frame
          id={sectionAnchorId("subagents", "models")}
          className="subagents-workspace-section"
          title={t("sub.workspace.allModels")}
          meta={<CountPill>{availableFiltered.length}</CountPill>}
          lede={full ? t("sub.workspace.featuredFull") : t("subagentsV2.modelsLede", { max: FEATURED_MAX })}
          actions={
            <label className="relative flex w-full items-center sm:w-72">
              <IconSearch className="pointer-events-none absolute left-2.5 size-4 text-fg-subtle" aria-hidden="true" />
              <input
                className="input w-full pl-8"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t("sub.search")}
                aria-label={t("sub.search")}
              />
            </label>
          }
        >
          <FrameBody as="ul" className="max-h-[min(30rem,60vh)] overflow-y-auto">
            {availableFiltered.length === 0 ? (
              <li className="px-4 py-6 text-center text-[13px] text-fg-muted">{t("sub.noModels")}</li>
            ) : (
              availableFiltered.map(m => {
                const isFeatured = chosenSet.has(m);
                const priority = isFeatured ? chosen.indexOf(m) + 1 : null;
                // A featured row can always be removed; only adding is blocked when full.
                const blocked = !isFeatured && full;
                return (
                  <li key={m} className="flex min-h-11 min-w-0 items-center gap-3 py-1.5 pr-2 pl-3.5">
                    <IconBot className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                    <span className={cn("min-w-0 flex-1 truncate font-mono text-[13px]", isFeatured ? "text-fg" : "text-fg-muted")}>
                      {modelLabel(m)}
                    </span>
                    {priority !== null && (
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted tabular-nums">
                        {t("subagentsV2.rank", { n: priority })}
                      </span>
                    )}
                    <button
                      type="button"
                      className={cn(
                        "ui-v2 inline-flex h-[var(--ocx-control-h-sm)] shrink-0 cursor-pointer items-center gap-1 rounded-[8px] px-2.5 text-[12px] font-medium transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight [&_svg]:size-3.5",
                        "disabled:cursor-not-allowed disabled:opacity-40",
                        isFeatured
                          ? "bg-accent text-on-accent hover:opacity-85"
                          : "text-fg-muted ring-1 ring-inset ring-line-strong hover:bg-surface-2 hover:text-fg",
                      )}
                      onClick={() => { if (!blocked) onToggle(m); }}
                      disabled={blocked}
                      aria-pressed={isFeatured}
                      aria-label={isFeatured
                        ? t("sub.workspace.removeFromFeatured", { m })
                        : t("sub.workspace.addToFeatured", { m })}
                      title={isFeatured
                        ? t("sub.workspace.removeFromFeatured", { m })
                        : full ? t("sub.workspace.featuredFull") : t("sub.workspace.addToFeatured", { m })}
                    >
                      {isFeatured ? <IconCheck aria-hidden="true" /> : <IconPlus aria-hidden="true" />}
                      {isFeatured ? t("subagentsV2.added") : t("subagentsV2.add")}
                    </button>
                  </li>
                );
              })
            )}
          </FrameBody>
        </Frame>

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
            availableModels={fallbackAvailable ?? available}
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
