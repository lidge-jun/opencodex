/**
 * The Models page tab strip.
 *
 * Underline page tabs, the same vocabulary Logs, Dashboard, and Integrations use. ARIA
 * wiring follows the APG tabs pattern: `tab` elements inside a `tablist`, roving
 * tabindex (0 on the active tab, -1 on the rest), `aria-controls` to the panel, and
 * Arrow/Home/End traversal.
 */
import type { KeyboardEvent } from "react";
import { useRef } from "react";
import { useT, type TKey } from "../i18n/shared";
import {
  MODELS_TABS,
  modelsPanelDomId,
  modelsTabDomId,
  type ModelsTab,
} from "./models-tab";

const TAB_LABEL: Record<ModelsTab, TKey> = {
  catalog: "models.tab.catalog",
  combos: "models.tab.combos",
  routing: "models.tab.routing",
  compatibility: "models.tab.compatibility",
};

export function ModelsTabStrip({
  tab,
  onSelect,
  meta,
}: {
  tab: ModelsTab;
  onSelect: (next: ModelsTab) => void;
  /**
   * Quiet per-tab counts. A tab whose count is not yet known is omitted rather than
   * rendered as zero — an unknown catalog would otherwise claim "0/0" on a cold load
   * that never fetched it, and a wrong count is worse than none.
   */
  meta?: Partial<Record<ModelsTab, string>>;
}) {
  const t = useT();
  const refs = useRef<Map<ModelsTab, HTMLButtonElement> | null>(null);
  if (refs.current === null) refs.current = new Map();

  const move = (next: ModelsTab) => {
    onSelect(next);
    // Focus follows selection, so keyboard traversal lands where the eye does.
    window.requestAnimationFrame(() => {
      refs.current!.get(next)?.focus({ preventScroll: true });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = MODELS_TABS.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + MODELS_TABS.length) % MODELS_TABS.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % MODELS_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = MODELS_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    move(MODELS_TABS[nextIndex]!);
  };

  return (
    <div className="page-tabs" role="tablist" aria-label={t("models.tabsLabel")}>
      {MODELS_TABS.map(candidate => {
        const active = candidate === tab;
        const count = meta?.[candidate];
        return (
          <button
            key={candidate}
            ref={node => {
              if (node) refs.current!.set(candidate, node);
              else refs.current!.delete(candidate);
            }}
            type="button"
            role="tab"
            id={modelsTabDomId(candidate)}
            aria-selected={active}
            aria-controls={modelsPanelDomId(candidate)}
            tabIndex={active ? 0 : -1}
            className={`page-tab${active ? " page-tab--active" : ""}`}
            onClick={() => move(candidate)}
            onKeyDown={onKeyDown}
          >
            {t(TAB_LABEL[candidate])}
            {count ? <span className="section-tab-meta">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
