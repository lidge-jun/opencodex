/**
 * The sidebar's rows, with a menu search beside the Everyday heading, keyboard shortcuts
 * for the rows people open most, and a Fine-tuning tier that stays folded until asked.
 *
 * Rows come from nav-groups.ts, one tier at a time; this file only decides how they are
 * shown. Search covers every page a row owns (Logs inside Usage & Logs, Startup inside
 * Home, Claude inside Route), so a page two clicks deep is one search away.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Page } from "../app-routing";
import type { TFn } from "../i18n/shared";
import { IconChevron, IconSearch, IconX } from "../icons";
import { NAV_GROUPS, NAV_TIERS, type NavGroup, type NavGroupId, type NavTier } from "../nav-groups";
import { isEditableTarget, numberModifierHeld, searchShortcutLabel, settingsShortcutLabel, shortcutLabel, shortcutStyle } from "../lib/nav-shortcuts";

const ADVANCED_OPEN_KEY = "ocx-nav-advanced-open";
/** The tier that folds. Everything in it stays reachable through search and the active row. */
const FOLDING_TIER: NavTier = "advanced";

function readAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

interface SearchEntry {
  group: NavGroup;
  page: Page;
  label: string;
  /** The row's name when the page is not the row's own first page. */
  context: string | null;
  haystack: string;
}

export function SidebarNav({ activeGroupId, pageLabel, pageAvailable, onNavigate, onReveal, desktopShell, t }: {
  activeGroupId: NavGroupId | null;
  pageLabel: (page: Page) => string;
  /** Search offers only pages that can load now (Remote Workspace needs a hub). */
  pageAvailable: (page: Page) => boolean;
  onNavigate: (page: Page) => void;
  /** Make the sidebar visible (expand a collapsed rail, open the phone drawer) before focusing search. */
  onReveal: () => void;
  desktopShell: boolean;
  t: TFn;
}) {
  const style = useMemo(() => shortcutStyle(desktopShell), [desktopShell]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchDialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openedFromButton = useRef(false);
  const listId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(ADVANCED_OPEN_KEY, advancedOpen ? "1" : "0");
    } catch {
      // A storageless context still folds for the session.
    }
  }, [advancedOpen]);

  const entries = useMemo<SearchEntry[]>(() => NAV_GROUPS.flatMap(group => {
    const groupLabel = t(group.tkey);
    return [...group.pages, ...(group.embedded ?? [])].map((page, index) => {
      const label = index === 0 ? groupLabel : pageLabel(page);
      const context = index === 0 || label === groupLabel ? null : groupLabel;
      return { group, page, label, context, haystack: `${label} ${groupLabel}`.toLowerCase() };
    }).filter(entry => pageAvailable(entry.page));
  }), [pageAvailable, pageLabel, t]);

  const trimmed = query.trim().toLowerCase();
  const results = useMemo(() => (trimmed ? entries.filter(entry => entry.haystack.includes(trimmed)) : []), [entries, trimmed]);

  const openSearch = useCallback((fromButton = false) => {
    if (searching) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openedFromButton.current = fromButton || returnFocusRef.current === searchButtonRef.current;
    onReveal();
    setSearching(true);
  }, [onReveal, searching]);

  useEffect(() => {
    if (!searching) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    // The mobile drawer may still be transitioning from visibility:hidden.
    const timer = setTimeout(() => {
      if (!searchDialogRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }, 200);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [searching]);

  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!searching || !dialog) return;
    // A modal's background must be unavailable to pointer and assistive technology too.
    const changed: Element[] = [];
    for (let node: Element | null = dialog; node?.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && !sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          changed.push(sibling);
        }
      }
      if (node.parentElement === document.body) break;
    }
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) inputRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      changed.forEach(element => element.removeAttribute("inert"));
    };
  }, [searching, trimmed]);

  const closeSearch = useCallback((restoreFocus: boolean) => {
    setQuery("");
    setHighlight(0);
    setSearching(false);
    if (restoreFocus) requestAnimationFrame(() => {
      const target = openedFromButton.current ? searchButtonRef.current : returnFocusRef.current;
      if (target?.isConnected) target.focus();
      else searchButtonRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!searching) return;
    // The drawer's Escape listener is on window; capture also covers its slide-in
    // interval before the search input can receive focus.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSearch(true);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [closeSearch, searching]);

  const go = useCallback((page: Page) => {
    closeSearch(false);
    onNavigate(page);
  }, [closeSearch, onNavigate]);

  const daily = useMemo(() => NAV_GROUPS.filter(group => group.tier === "daily"), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (searching || event.defaultPrevented || event.isComposing) return;
      const commandK = (style.endsWith("mac") ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K");
      if (commandK || (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target))) {
        event.preventDefault();
        openSearch();
        return;
      }
      // Settings live under the platform's settings shortcut in the desktop app.
      if (desktopShell && (style === "desktop-mac" ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        onNavigate("advanced");
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit || !numberModifierHeld(style, event)) return;
      // Option+digit types a character on a Mac; leave text fields alone in the browser.
      if (style.startsWith("browser") && isEditableTarget(event.target)) return;
      const group = daily[Number(digit) - 1];
      if (!group) return;
      event.preventDefault();
      onNavigate(group.pages[0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [daily, desktopShell, onNavigate, openSearch, searching, style]);

  const onDialogKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch(true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const close = searchDialogRef.current?.querySelector<HTMLButtonElement>(".nav-search-close");
      if (event.shiftKey ? document.activeElement === inputRef.current : document.activeElement !== close) close?.focus();
      else inputRef.current?.focus();
    }
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(index => (results.length ? (index + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(index => (results.length ? (index - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      const entry = results[Math.min(highlight, results.length - 1)];
      if (entry) {
        event.preventDefault();
        go(entry.page);
      }
    }
  };

  const searchLabel = t("shellV2.navSearch");
  const searchHint = searchShortcutLabel(style);

  const row = (group: NavGroup, shortcut: string | null) => {
    const { id, tkey, Icon } = group;
    const active = activeGroupId === id;
    const label = t(tkey);
    return (
      <div key={id} className="nav-entry">
        <button type="button" className={`nav-item${active ? " active" : ""}`}
          data-page={group.pages[0]}
          data-group={id}
          title={shortcut ? `${label} (${shortcut})` : undefined}
          aria-keyshortcuts={shortcut ? shortcut.replace("⌘", "Meta+").replace("⌥", "Alt+") : undefined}
          onClick={() => onNavigate(group.pages[0])}
          aria-current={active ? "page" : undefined}>
          <Icon /> <span className="nav-item-label">{label}</span>
          {shortcut && <kbd className="nav-kbd" aria-hidden="true">{shortcut}</kbd>}
        </button>
      </div>
    );
  };

  return (
    <>
      {NAV_TIERS.map(({ tier, tkey: tierKey }) => {
        const groups = NAV_GROUPS.filter(group => group.tier === tier);
        if (tier === "daily") {
          return (
            <div key={tier} className="nav-tier" data-tier={tier}>
              {searching ? (
                <div ref={searchDialogRef} role="dialog" aria-modal="true" aria-label={searchLabel} onKeyDown={onDialogKey}>
                  <div className="nav-search">
                    <IconSearch aria-hidden="true" />
                    <input ref={inputRef} type="search" className="nav-search-input" value={query}
                      placeholder={t("shellV2.navSearchPlaceholder")}
                      aria-label={searchLabel} role="combobox" aria-expanded="true" aria-autocomplete="list"
                      aria-controls={listId}
                      aria-activedescendant={results.length ? `${listId}-${Math.min(highlight, results.length - 1)}` : undefined}
                      onChange={event => { setQuery(event.target.value); setHighlight(0); }}
                      onKeyDown={onSearchKey} />
                    <button type="button" className="nav-search-close" onClick={() => closeSearch(true)} aria-label={t("common.close")} title={t("common.close")}>
                      <IconX />
                    </button>
                  </div>
                  {trimmed && results.length === 0 && <div className="nav-search-empty" role="status">{t("shellV2.navSearchEmpty")}</div>}
                  <div id={listId} className="nav-search-results" role="listbox" aria-label={searchLabel}>
                    {results.map((entry, index) => {
                      const { Icon } = entry.group;
                      return (
                        <button key={entry.page} id={`${listId}-${index}`} type="button" role="option" tabIndex={-1}
                          aria-selected={index === Math.min(highlight, results.length - 1)}
                          className={`nav-item nav-search-result${index === Math.min(highlight, results.length - 1) ? " is-highlighted" : ""}`}
                          onMouseEnter={() => setHighlight(index)}
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => go(entry.page)}>
                          <Icon /> <span className="nav-item-label">{entry.label}</span>
                          {entry.context && <span className="nav-search-context">{entry.context}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="nav-tier-head">
                  <div className="nav-tier-label" aria-hidden="true">{t(tierKey)}</div>
                  <button ref={searchButtonRef} type="button" className="nav-search-open" onClick={() => openSearch(true)}
                    aria-label={`${searchLabel} (${searchHint})`} title={`${searchLabel} (${searchHint})`}
                    aria-keyshortcuts={searchHint === "⌘K" ? "Meta+K" : "Control+K"}>
                    <IconSearch aria-hidden="true" />
                    <kbd className="nav-kbd nav-kbd--search" aria-hidden="true">{searchHint}</kbd>
                  </button>
                </div>
              )}
              {!trimmed && groups.map((group, index) => row(group, index < 9 ? shortcutLabel(style, String(index + 1)) : null))}
            </div>
          );
        }
        if (trimmed) return null;
        if (tier !== FOLDING_TIER) {
          return (
            <div key={tier} className="nav-tier" data-tier={tier}>
              <div className="nav-tier-label" aria-hidden="true">{t(tierKey)}</div>
              {groups.map(group => row(group, null))}
            </div>
          );
        }
        // Folded, the tier still shows the row you are on, so the sidebar never hides where you are.
        const visible = advancedOpen ? groups : groups.filter(group => group.id === activeGroupId);
        return (
          <div key={tier} className={`nav-tier nav-tier--folding${advancedOpen ? " is-open" : ""}`} data-tier={tier}>
            <button type="button" className="nav-tier-toggle" aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen(open => !open)}>
              <span className="nav-tier-label">{t(tierKey)}</span>
              <IconChevron aria-hidden="true" className="nav-tier-chevron" />
            </button>
            {visible.map(group => row(group, desktopShell && group.id === "advanced" ? settingsShortcutLabel(style) : null))}
          </div>
        );
      })}
    </>
  );
}
