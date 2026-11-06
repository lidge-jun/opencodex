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

  const openSearch = useCallback(() => {
    onReveal();
    setSearching(true);
    // The input mounts (and a collapsed rail or the phone drawer opens) on this render. The
    // drawer is still sliding in, and focus() no-ops while its visibility transitions.
    requestAnimationFrame(() => inputRef.current?.focus());
    setTimeout(() => { if (document.activeElement !== inputRef.current) inputRef.current?.focus(); }, 200);
  }, [onReveal]);

  const closeSearch = useCallback((restoreFocus: boolean) => {
    setQuery("");
    setHighlight(0);
    setSearching(false);
    if (restoreFocus) requestAnimationFrame(() => searchButtonRef.current?.focus());
  }, []);

  const go = useCallback((page: Page) => {
    closeSearch(false);
    onNavigate(page);
  }, [closeSearch, onNavigate]);

  const daily = useMemo(() => NAV_GROUPS.filter(group => group.tier === "daily"), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const commandK = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K");
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
  }, [daily, desktopShell, onNavigate, openSearch, style]);

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch(true);
    } else if (event.key === "ArrowDown") {
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
                <div className="nav-search" role="search">
                  <IconSearch aria-hidden="true" />
                  <input ref={inputRef} type="search" className="nav-search-input" value={query}
                    placeholder={t("shellV2.navSearchPlaceholder")}
                    aria-label={searchLabel}
                    aria-controls={listId}
                    aria-activedescendant={results.length ? `${listId}-${Math.min(highlight, results.length - 1)}` : undefined}
                    onChange={event => { setQuery(event.target.value); setHighlight(0); }}
                    onKeyDown={onSearchKey}
                    onBlur={() => { if (!query) closeSearch(false); }} />
                  <button type="button" className="nav-search-close" onClick={() => closeSearch(true)} aria-label={t("common.close")} title={t("common.close")}>
                    <IconX />
                  </button>
                </div>
              ) : (
                <div className="nav-tier-head">
                  <div className="nav-tier-label" aria-hidden="true">{t(tierKey)}</div>
                  <button ref={searchButtonRef} type="button" className="nav-search-open" onClick={openSearch}
                    aria-label={`${searchLabel} (${searchHint})`} title={`${searchLabel} (${searchHint})`}
                    aria-keyshortcuts={searchHint === "⌘K" ? "Meta+K" : "Control+K"}>
                    <IconSearch aria-hidden="true" />
                    <kbd className="nav-kbd nav-kbd--search" aria-hidden="true">{searchHint}</kbd>
                  </button>
                </div>
              )}
              {trimmed ? (
                <div id={listId} className="nav-search-results" role="listbox" aria-label={searchLabel}>
                  {results.length === 0 && <div className="nav-search-empty">{t("shellV2.navSearchEmpty")}</div>}
                  {results.map((entry, index) => {
                    const { Icon } = entry.group;
                    return (
                      <button key={entry.page} id={`${listId}-${index}`} type="button" role="option"
                        aria-selected={index === highlight}
                        className={`nav-item nav-search-result${index === highlight ? " is-highlighted" : ""}`}
                        onMouseEnter={() => setHighlight(index)}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => go(entry.page)}>
                        <Icon /> <span className="nav-item-label">{entry.label}</span>
                        {entry.context && <span className="nav-search-context">{entry.context}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : groups.map((group, index) => row(group, index < 9 ? shortcutLabel(style, String(index + 1)) : null))}
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
