import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { Page } from "../app-routing";
import "../styles/section-switcher.css";

export interface SectionSwitcherItem {
  page: Page;
  label: string;
}

/**
 * Moves between the pages of one sidebar group (Usage & Logs, Remote Link).
 *
 * This is page navigation, so it is a named <nav> whose current entry carries
 * aria-current="page" - not a tablist, which would claim a tabpanel relationship and
 * nest a second tab strip above the pages' own. Every button stays in Tab order;
 * Left/Right/Home/End additionally move focus along the row.
 *
 * App renders it outside the page-keyed error boundary so it survives navigation
 * between members and the activated button keeps focus. When the item set shrinks
 * under a focused button (Remote Workspace going away), focus moves to a survivor
 * instead of falling to <body>. When it shrinks to one item, App hides the switcher
 * altogether; if focus was inside at that moment, `onFocusOrphaned` lets App put it
 * somewhere meaningful, since there is no surviving button left to receive it.
 */
export function SectionSwitcher({ items, currentPage, onNavigate, ariaLabel, onFocusOrphaned }: {
  items: readonly SectionSwitcherItem[];
  currentPage: Page;
  onNavigate: (page: Page) => void;
  ariaLabel: string;
  onFocusOrphaned?: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const focusedPage = useRef<Page | null>(null);
  const orphanedRef = useRef(onFocusOrphaned);
  useLayoutEffect(() => { orphanedRef.current = onFocusOrphaned; });

  // Unmount with focus still inside: React runs this cleanup before it removes the nav,
  // so the check sees the focused button and the handler can move focus before it drops.
  useLayoutEffect(() => {
    const nav = navRef.current;
    return () => {
      if (nav && nav.contains(nav.ownerDocument.activeElement)) orphanedRef.current?.();
    };
  }, []);

  // Runs after any item change; every branch below is a cheap check, so a new array
  // identity from the parent on each render costs nothing.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const lost = focusedPage.current;
    if (!nav || lost === null) return;
    if (nav.contains(nav.ownerDocument.activeElement)) return;
    if (items.some(item => item.page === lost)) return;
    const fallback = nav.querySelector<HTMLButtonElement>('[aria-current="page"]')
      ?? nav.querySelector<HTMLButtonElement>("button");
    fallback?.focus();
  }, [items]);

  const buttons = () => [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const list = buttons();
    const index = list.indexOf(event.currentTarget);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % list.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  };

  return (
    <nav
      ref={navRef}
      className="section-switcher"
      aria-label={ariaLabel}
      onFocus={event => {
        focusedPage.current = (event.target as HTMLElement).dataset.sectionPage as Page | undefined ?? null;
      }}
      onBlur={event => {
        if (navRef.current?.contains(event.relatedTarget as Node | null)) return;
        /*
         * Focus left the switcher. If the button is still in the document this was a
         * real move (Tab out, a click on the page), so forget it. A button React removed
         * mid-commit is disconnected by then; keeping its memory is what lets the layout
         * effect above, which runs in the same task, put focus on a survivor.
         */
        const left = event.target as HTMLElement;
        window.setTimeout(() => { if (left.isConnected) focusedPage.current = null; }, 0);
      }}
    >
      {items.map(item => (
        <button
          key={item.page}
          type="button"
          className="section-switcher-btn"
          data-section-page={item.page}
          aria-current={item.page === currentPage ? "page" : undefined}
          onClick={() => { if (item.page !== currentPage) onNavigate(item.page); }}
          onKeyDown={onKeyDown}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
