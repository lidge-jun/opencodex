import { useRef, type KeyboardEvent } from "react";
import { useT, type TKey } from "../../i18n/shared";
import {
  GUARDRAILS_TABS,
  guardrailsPanelDomId,
  guardrailsTabDomId,
  type GuardrailsTab,
} from "./guardrails-tab";

const LABELS: Record<GuardrailsTab, TKey> = {
  overview: "guardrails.tab.overview",
  rules: "guardrails.tab.rules",
  tester: "guardrails.tab.tester",
  activity: "guardrails.tab.activity",
  settings: "guardrails.tab.settings",
};

export function GuardrailsTabStrip({
  tab,
  onSelect,
  meta,
}: {
  tab: GuardrailsTab;
  onSelect: (tab: GuardrailsTab) => void;
  meta?: Partial<Record<GuardrailsTab, string>>;
}) {
  const t = useT();
  const refs = useRef<Map<GuardrailsTab, HTMLButtonElement> | null>(null);
  if (refs.current === null) refs.current = new Map();

  const move = (next: GuardrailsTab) => {
    onSelect(next);
    window.requestAnimationFrame(() => refs.current?.get(next)?.focus({ preventScroll: true }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = GUARDRAILS_TABS.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = (current - 1 + GUARDRAILS_TABS.length) % GUARDRAILS_TABS.length;
    else if (event.key === "ArrowRight") next = (current + 1) % GUARDRAILS_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = GUARDRAILS_TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    move(GUARDRAILS_TABS[next]!);
  };

  return (
    <div className="page-tabs" role="tablist" aria-label={t("guardrails.tabsLabel")}>
      {GUARDRAILS_TABS.map(candidate => {
        const active = candidate === tab;
        return (
          <button
            key={candidate}
            ref={node => {
              if (node) refs.current?.set(candidate, node);
              else refs.current?.delete(candidate);
            }}
            type="button"
            role="tab"
            id={guardrailsTabDomId(candidate)}
            aria-selected={active}
            aria-controls={guardrailsPanelDomId(candidate)}
            tabIndex={active ? 0 : -1}
            className={`page-tab${active ? " page-tab--active" : ""}`}
            onClick={() => move(candidate)}
            onKeyDown={onKeyDown}
          >
            {t(LABELS[candidate])}
            {meta?.[candidate] ? <span className="section-tab-meta">{meta[candidate]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
