import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface SectionIndexItem { id: string; label: string }

/*
 * In-page index for a long settings page (React Bits Pro settings-form-1 navigation): a
 * sticky column of section names on wide screens, a scrolling strip on narrow ones. It only
 * scrolls; the URL hash stays the page route, so Back still leaves the page. The section in
 * view is marked with aria-current and the inverse-neutral selected fill.
 */
export function SectionIndex({ items, label, className }: { items: readonly SectionIndexItem[]; label: string; className?: string }) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(items[0]?.id ?? "");
  const ids = items.map(item => item.id).join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      // The topmost section that still shows its upper part wins.
      const order = ids.split("|");
      const first = order.find(id => visible.has(id));
      if (first) setActive(first);
    }, { rootMargin: "0px 0px -55% 0px", threshold: 0 });
    for (const id of ids.split("|")) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [ids]);

  const go = (id: string) => {
    const node = document.getElementById(id);
    if (!node) return;
    setActive(id);
    node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    // Move focus with the view so keyboard users continue from the section they chose.
    const heading = node.querySelector<HTMLElement>("h3, h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };

  return (
    <nav aria-label={label} className={cn("pv2-index min-w-0", className)}>
      <p className="m-0 mb-1.5 hidden px-2.5 text-xs font-medium text-fg-subtle lg:block">{label}</p>
      <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        {items.map(item => {
          const current = item.id === active;
          return (
            <li key={item.id} className="shrink-0">
              <button
                type="button"
                aria-current={current ? "location" : undefined}
                onClick={() => go(item.id)}
                className={cn(
                  "flex h-[var(--ocx-control-h-sm)] w-full cursor-pointer items-center rounded-[8px] border-0 bg-transparent px-2.5 text-left text-[13px] font-medium whitespace-nowrap text-fg-muted",
                  "transition-colors duration-150 hover:bg-surface hover:text-fg",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-highlight",
                  current && "bg-surface text-fg shadow-[inset_0_0_0_1px_var(--ocx-line)]",
                )}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
