/**
 * SubagentsWorkspace — rail + main workspace for the Subagents tab, mirroring the
 * Providers/Combos workspace DNA. Left rail lists Featured and Available models with
 * add/remove toggles; the main pane shows either the featured roster (reorder + save)
 * or a per-model detail view.
 */
import { useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconChevron,
  IconInfo,
  IconPlus,
  IconX,
} from "../../icons";
import { useT } from "../../i18n/shared";
import { Trans } from "../../i18n/provider";
import { modelLabel } from "../../model-display";

export interface SubagentsWorkspaceProps {
  available: string[];
  chosen: string[];
  busy?: boolean;
  onToggle: (m: string) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onSave: () => void;
}

const FEATURED_MAX = 5;

export default function SubagentsWorkspace({
  available,
  chosen,
  busy = false,
  onToggle,
  onMove,
  onSave,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const full = chosen.length >= FEATURED_MAX;

  const featuredFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chosen.filter(m => !q || m.toLowerCase().includes(q));
  }, [chosen, query]);

  const availableFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !chosenSet.has(m) && (!q || m.toLowerCase().includes(q)));
  }, [available, chosenSet, query]);

  const selectedIndex = selected ? chosen.indexOf(selected) : -1;
  const selectedIsFeatured = selectedIndex !== -1;

  return (
    <div className="subagents-workspace-shell">
      <div className="subagents-workspace-root">
        <aside className="subagents-workspace-rail" aria-label={t("nav.subagents")}>
          <div className="subagents-workspace-rail-header">
            <span className="subagents-workspace-rail-title">{t("nav.subagents")}</span>
            <span className="subagents-workspace-rail-count">{chosen.length}/{FEATURED_MAX}</span>
          </div>
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
            {featuredFiltered.length === 0 && availableFiltered.length === 0 && (
              <span className="subagents-workspace-rail-empty">{t("sub.noModels")}</span>
            )}
            {featuredFiltered.length > 0 && (
              <div className="subagents-workspace-rail-group">
                <div className="subagents-workspace-rail-group-head">
                  <span>{t("sub.featured")}</span>
                  <span className="subagents-workspace-rail-group-count">{featuredFiltered.length}</span>
                </div>
                {featuredFiltered.map(m => {
                  const priority = chosen.indexOf(m) + 1;
                  return (
                    <div key={m} className={`subagents-workspace-rail-row${selected === m ? " subagents-workspace-rail-row--selected" : ""}`}>
                      <button
                        type="button"
                        className="subagents-workspace-rail-row-main"
                        onClick={() => setSelected(m)}
                        aria-current={selected === m ? "true" : undefined}
                      >
                        <span className="swi-rail-priority">{priority}</span>
                        <span className="subagents-workspace-rail-name">{modelLabel(m)}</span>
                      </button>
                      <button
                        type="button"
                        className="subagents-workspace-rail-toggle subagents-workspace-rail-toggle--on"
                        onClick={() => onToggle(m)}
                        disabled={busy}
                        aria-label={t("sub.workspace.removeFromFeatured", { m })}
                        title={t("sub.workspace.removeFromFeatured", { m })}
                      >
                        <IconCheck style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {availableFiltered.length > 0 && (
              <div className="subagents-workspace-rail-group">
                <div className="subagents-workspace-rail-group-head">
                  <span>{t("sub.workspace.allModels")}</span>
                  <span className="subagents-workspace-rail-group-count">{availableFiltered.length}</span>
                </div>
                {availableFiltered.map(m => (
                  <div key={m} className={`subagents-workspace-rail-row${selected === m ? " subagents-workspace-rail-row--selected" : ""}`}>
                    <button
                      type="button"
                      className="subagents-workspace-rail-row-main"
                      onClick={() => setSelected(m)}
                      aria-current={selected === m ? "true" : undefined}
                    >
                      <span className="swi-rail-priority" aria-hidden="true" />
                      <span className="subagents-workspace-rail-name">{modelLabel(m)}</span>
                    </button>
                    <button
                      type="button"
                      className={`subagents-workspace-rail-toggle${full || busy ? " subagents-workspace-rail-toggle--disabled" : ""}`}
                      onClick={() => { if (!full && !busy) onToggle(m); }}
                      disabled={full || busy}
                      aria-label={t("sub.workspace.addToFeatured", { m })}
                      title={full ? t("sub.workspace.featuredFull") : t("sub.workspace.addToFeatured", { m })}
                    >
                      <IconPlus style={{ width: 14, height: 14 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="subagents-workspace-main" aria-label={t("sub.workspace.mainAria")}>
          {selected ? (
            <div className="swi-detail">
              <button type="button" className="swi-detail-back" onClick={() => setSelected(null)}>
                <IconChevron className="swi-detail-back-chevron" />
                {t("modal.back")}
              </button>
              <div className="swi-detail-head">
                <span className="swi-detail-icon"><IconBot style={{ width: 24, height: 24 }} /></span>
                <h2 className="swi-detail-title">{selected}</h2>
              </div>

              <div className="swi-detail-section">
                <dl className="swi-detail-kv">
                  <div className="swi-detail-kv-row">
                    <dt>{t("sub.workspace.selector")}</dt>
                    <dd><code>{selected}</code></dd>
                  </div>
                  <div className="swi-detail-kv-row">
                    <dt>{t("sub.workspace.priority")}</dt>
                    <dd>{selectedIsFeatured ? selectedIndex + 1 : t("sub.workspace.notFeatured")}</dd>
                  </div>
                </dl>
              </div>

              <div className="swi-detail-section">
                <h3 className="swi-detail-section-title">{t("sub.featured")}</h3>
                <div className="swi-detail-actions">
                  {selectedIsFeatured ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onToggle(selected)} disabled={busy}>
                      <IconX /> {t("sub.workspace.removeFromFeatured", { m: selected })}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onToggle(selected)} disabled={full || busy}>
                      <IconPlus /> {full ? t("sub.workspace.featuredFull") : t("sub.workspace.addToFeatured", { m: selected })}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="swi-featured-head">
                <h2 className="swi-featured-title">{t("sub.featured")}</h2>
                <span className="swi-featured-count">{chosen.length}/{FEATURED_MAX}</span>
              </div>
              <p className="swi-featured-hint">
                <IconInfo width={15} height={15} aria-hidden="true" />
                <span><Trans k="sub.orderHint" cmd="spawn_agent" /></span>
              </p>

              {chosen.length === 0 ? (
                <div className="swi-featured-empty">{t("sub.noneSelected")}</div>
              ) : (
                <div className="swi-featured-list">
                  {chosen.map((m, i) => (
                    <div key={m} className="swi-featured-row">
                      <span className="swi-featured-pos">{i + 1}</span>
                      <span className="swi-featured-name">{modelLabel(m)}</span>
                      <span className="swi-featured-actions">
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onMove(i, -1)} disabled={busy || i === 0} aria-label={t("sub.moveUp", { m })}>
                          <IconArrowUp />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onMove(i, 1)} disabled={busy || i === chosen.length - 1} aria-label={t("sub.moveDown", { m })}>
                          <IconArrowDown />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onToggle(m)} disabled={busy} aria-label={t("sub.removeAria", { m })} style={{ color: "var(--red)" }}>
                          <IconX />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="swi-save-row">
                <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>{t("common.save")}</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
