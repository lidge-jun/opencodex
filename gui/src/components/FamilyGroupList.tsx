import { useState, type ReactNode } from "react";
import { IconChevron } from "../icons";
import { useT } from "../i18n";
import { familyGroupKey, readCollapsedFamilies, toggleCollapsedFamily } from "../model-family-groups";
import { groupByModelFamily } from "../../../src/lib/model-families";
import "../styles/model-family-groups.css";

interface FamilyGroupListProps<T> {
  items: readonly T[];
  slugOf: (item: T) => string;
  /** Namespaces the remembered collapsed state, so one provider's folds do not touch another's. */
  scope: string;
  renderItem: (item: T) => ReactNode;
  /**
   * Set when the rows are list items: each run of rows becomes its own `<ul>` with this class
   * (a family header is not a list item), and `renderItem` returns an `<li>`.
   */
  listClassName?: string;
}

/**
 * Lists models under collapsible family headers (GPT, Gemini, Claude, ...). A list that holds a
 * single family is rendered flat: one header over every row would only add a click.
 */
export function FamilyGroupList<T>({ items, slugOf, scope, renderItem, listClassName }: FamilyGroupListProps<T>) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => readCollapsedFamilies());
  const groups = groupByModelFamily(items, slugOf);
  const rowsOf = (rows: readonly T[]) => listClassName === undefined
    ? rows.map(renderItem)
    : <ul className={listClassName}>{rows.map(renderItem)}</ul>;
  if (groups.length < 2) return <>{rowsOf(items)}</>;
  return (
    <>
      {groups.map(({ family, items: rows }) => {
        const key = familyGroupKey(scope, family.id);
        const open = !collapsed.has(key);
        const name = family.id === "other" ? t("models.family.other") : family.label;
        return (
          <div key={family.id} className="model-family-group" role="group" aria-label={name}>
            <button
              type="button"
              className="model-family-head"
              aria-expanded={open}
              aria-label={t("models.family.toggleLabel", { family: name, count: rows.length })}
              onClick={() => setCollapsed(toggleCollapsedFamily(key))}
            >
              <IconChevron className="model-family-chevron" aria-hidden="true" />
              <span className="font-semibold">{name}</span>
              <span className="muted mono text-label">{rows.length}</span>
            </button>
            {open && rowsOf(rows)}
          </div>
        );
      })}
    </>
  );
}
