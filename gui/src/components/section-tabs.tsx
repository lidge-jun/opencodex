/**
 * SectionTabs — a sticky strip of section links over a normally-scrolling page.
 *
 * These pages used to switch sections by swapping the panel, which meant only one section
 * existed at a time and the page could not be read by scrolling. Every section is rendered
 * here; the strip scrolls to one and stays pinned to the top so it is always reachable.
 *
 * The active tab follows the scroll position, so the strip reports where you are rather
 * than only where you last clicked.
 */
import { useEffect, useRef, useState } from "react";
import { sectionAnchorId, sectionAnchorPrefix } from "../section-anchors";

export interface SectionTabItem {
  id: string;
  label: string;
  /** Optional quiet suffix, such as a row count. */
  meta?: string;
}

export function SectionTabs({
  scope,
  items,
  ariaLabel,
}: {
  scope: string;
  items: SectionTabItem[];
  ariaLabel: string;
}) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Follow the scroll position. `rootMargin` biases the observer toward the top of the
  // viewport so the heading you are reading wins, not whatever is technically centred.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const nodes = items
      .map(item => document.getElementById(sectionAnchorId(scope, item.id)))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const id = visible.target.id.slice(sectionAnchorPrefix(scope).length);
        setActive(current => (current === id ? current : id));
      },
      { rootMargin: "-72px 0px -60% 0px", threshold: 0 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [items, scope]);

  const go = (id: string) => {
    const target = document.getElementById(sectionAnchorId(scope, id));
    if (!target) return;
    setActive(id);
    // `scroll-margin-top` on the target keeps the heading clear of the pinned strip.
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div
      ref={stripRef}
      className="page-tabs section-tabs"
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          aria-controls={sectionAnchorId(scope, item.id)}
          tabIndex={active === item.id ? 0 : -1}
          className={`page-tab${active === item.id ? " page-tab--active" : ""}`}
          onClick={() => go(item.id)}
        >
          {item.label}
          {item.meta ? <span className="section-tab-meta">{item.meta}</span> : null}
        </button>
      ))}
    </div>
  );
}
