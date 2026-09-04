/**
 * SubagentsWorkspace — a single stacked column for the Subagents tab: the featured roster
 * (reorder + save), the model picker, then the delegation settings.
 *
 * The previous rail layout listed the featured models twice — once as a rail group, once in
 * the main pane — which read as a rendering bug rather than two views of one thing. There is
 * also nothing here that needs two panes: picking a model is one toggle, and the per-model
 * detail pane carried no information the row did not already show.
 *
 * The sticky strip is the same `SectionTabs` the Logs and Usage tabs use: every section stays
 * in the document and scrolling still works: the strip only jumps to one and reports where
 * you are.
 */
import { useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconInfo,
  IconPlus,
  IconX,
} from "../../icons";
import { useT } from "../../i18n/shared";
import { Trans } from "../../i18n/provider";
import { Tooltip } from "../../ui";
import { modelLabel } from "../../model-display";
import { SectionTabs } from "../section-tabs";
import { sectionAnchorId } from "../../section-anchors";
import SubagentDelegationSection from "./SubagentDelegationSection";
import type { DelegationPatch, DelegationModelOption, UltraModePatch, UltraModeState } from "../../pages/use-subagent-delegation";

export interface SubagentsWorkspaceProps {
  available: string[];
  chosen: string[];
  busy?: boolean;
  onToggle: (m: string) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onSave: () => void;
  delegation: {
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
}

export const FEATURED_MAX = 5;

export default function SubagentsWorkspace({
  available,
  chosen,
  busy = false,
  onToggle,
  onMove,
  onSave,
  delegation,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const full = chosen.length >= FEATURED_MAX;

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
      <div className="subagents-workspace-root">
        <section
          id={sectionAnchorId("subagents", "featured")}
          className="subagents-workspace-section"
          aria-label={t("sub.featured")}
        >
          <div className="swi-featured-head">
            <h2 className="swi-featured-title">{t("sub.featured")}</h2>
            <span className="swi-featured-count">{chosen.length}/{FEATURED_MAX}</span>
            {/* One-time teaching ("this order is the picker order") rides on a focusable
                info button beside the counter instead of a paragraph above the list. */}
            <Tooltip content={<Trans k="sub.orderHint" cmd="spawn_agent" />} side="bottom" maxWidth={380}>
              <IconInfo width={14} height={14} aria-hidden="true" />
              <span className="sr-only">{t("sub.orderHintAria")}</span>
            </Tooltip>
          </div>

          {chosen.length === 0 ? (
            <div className="swi-featured-empty">{t("sub.noneSelected")}</div>
          ) : (
            <div className="swi-featured-list">
              {chosen.map((m, i) => (
                <div key={m} className="swi-featured-row">
                  <span className="swi-featured-pos">{i + 1}</span>
                  <span className="swi-featured-name">{modelLabel(m)}</span>
                  <span className="swi-featured-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onMove(i, -1)}
                      disabled={busy || i === 0}
                      aria-label={t("sub.moveUp", { m })}
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onMove(i, 1)}
                      disabled={busy || i === chosen.length - 1}
                      aria-label={t("sub.moveDown", { m })}
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onToggle(m)}
                      disabled={busy}
                      aria-label={t("sub.removeAria", { m })}
                      style={{ color: "var(--red)" }}
                    >
                      <IconX />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="swi-save-row">
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
              {t("common.save")}
            </button>
          </div>
        </section>

        <section
          id={sectionAnchorId("subagents", "models")}
          className="subagents-workspace-section"
          aria-label={t("sub.models")}
        >
          <div className="swi-featured-head">
            <h2 className="swi-featured-title">{t("sub.models")}</h2>
            <span className="swi-featured-count">{availableFiltered.length}</span>
          </div>
          <div className="swi-picker-box">
            <div className="subagents-workspace-rail-search">
              <input
                className="input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t("sub.search")}
                aria-label={t("sub.search")}
              />
            </div>
            <div className="subagents-workspace-rail-list">
              {availableFiltered.length === 0 ? (
                <span className="subagents-workspace-rail-empty">{t("sub.noModels")}</span>
              ) : (
                availableFiltered.map(m => {
                  const isFeatured = chosenSet.has(m);
                  const priority = isFeatured ? chosen.indexOf(m) + 1 : null;
                  // A featured row can always be removed; only adding is blocked when full.
                  const blocked = !isFeatured && (full || busy);
                  return (
                    <div
                      key={m}
                      className={`subagents-workspace-rail-row${isFeatured ? " subagents-workspace-rail-row--selected" : ""}`}
                    >
                      <span className="subagents-workspace-rail-row-main">
                        <span className="swi-rail-priority">{priority ?? ""}</span>
                        <IconBot className="swi-rail-icon" aria-hidden="true" />
                        <span className="subagents-workspace-rail-name">{modelLabel(m)}</span>
                      </span>
                      <button
                        type="button"
                        className={`subagents-workspace-rail-toggle${isFeatured ? " subagents-workspace-rail-toggle--on" : ""}${blocked ? " subagents-workspace-rail-toggle--disabled" : ""}`}
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
                        {isFeatured
                          ? <IconCheck style={{ width: 14, height: 14 }} />
                          : <IconPlus style={{ width: 14, height: 14 }} />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section
          id={sectionAnchorId("subagents", "settings")}
          className="subagents-workspace-section"
          aria-label={t("sub.settings")}
        >
          <div className="swi-featured-head">
            <h2 className="swi-featured-title">{t("sub.settings")}</h2>
          </div>
          <SubagentDelegationSection
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
          />
        </section>
      </div>
    </div>
  );
}
