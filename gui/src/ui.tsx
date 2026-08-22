/* Shared UI primitives built on the design-system classes in styles.css. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconAlert } from "./icons";
import { IconChevron } from "./icons";
import { computeSelectMenuStyle } from "./select-position";

export function Switch({ on, mixed = false, onClick, disabled, label }: { on: boolean; mixed?: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" className={`switch${on ? " on" : ""}${mixed ? " mixed" : ""}`} onClick={onClick} disabled={disabled}
      aria-pressed={mixed ? "mixed" : on} aria-label={label ?? (on ? "enabled" : "disabled")}>
      <span className="knob" />
    </button>
  );
}

/** Shared presentation tone for success, degraded success, and failure notices. */
export type NoticeTone = "ok" | "warn" | "err";

export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  // `warn` is degraded-but-not-failed: the action happened, something adjacent
  // did not. It must not render as the clean success the user did not get.
  const toneClass = tone === "ok" ? "notice-ok" : tone === "warn" ? "notice-warn" : "notice-err";
  return (
    <div className={`notice ${toneClass}`} role="status">
      {tone === "ok" ? <IconCheck /> : <IconAlert />}
      <span>{children}</span>
    </div>
  );
}

/**
 * Fixed-position status toast. Portaled so it never consumes page flow / shifts layout.
 * Parent owns auto-dismiss timing (success banners are typically transient).
 */
export function ToastNotice({
  tone,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: NoticeTone;
  children: ReactNode;
  onDismiss?: () => void;
  /** Required whenever onDismiss is provided — pass t("common.close"). */
  dismissLabel: string;
}) {
  return createPortal(
    <div className="toast-notice-host" role="presentation">
      <div
        className={`toast-notice notice ${tone === "ok" ? "notice-ok" : tone === "warn" ? "notice-warn" : "notice-err"}`}
        role="status"
        aria-live="polite"
      >
        {tone === "ok" ? <IconCheck /> : <IconAlert />}
        <span className="toast-notice-copy">{children}</span>
        {onDismiss && (
          <button type="button" className="toast-notice-dismiss" onClick={onDismiss} aria-label={dismissLabel}>
            ×
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface SelectOption { value: string; label: React.ReactNode }

export function Select({ value, options, onChange, disabled, id, label, describedBy, title, style, align, placement, dropdownStyle, portal = true }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Put on the trigger, so a sibling `<label htmlFor>` can name it — a button is labelable. */
  id?: string;
  label?: string;
  describedBy?: string;
  title?: string;
  style?: CSSProperties;
  align?: "left" | "right";
  placement?: "below" | "right";
  dropdownStyle?: CSSProperties;
  /** When true (default), menu is portaled and flips above the trigger if it would leave the viewport. */
  portal?: boolean;
}) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionId = useCallback((index: number) => `${listboxId}-${index}`, [listboxId]);
  const current = options.find(o => o.value === value);
  const selectedIndex = options.length === 0 ? 0 : Math.max(0, options.findIndex(o => o.value === value));
  // While open, keyboard/hover highlight wins; while closed, follow the selected value.
  // Clamp so aria-activedescendant never points at a missing option after shrink/reorder.
  const activeIndex = !open || options.length === 0
    ? selectedIndex
    : Math.min(highlightIndex ?? selectedIndex, options.length - 1);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setHighlightIndex(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openAt = useCallback((index: number) => {
    if (disabled || options.length === 0) return;
    const clamped = Math.max(0, Math.min(options.length - 1, index));
    setHighlightIndex(clamped);
    setOpen(true);
  }, [disabled, options.length]);

  const reposition = useCallback((menuHeight?: number) => {
    if (!portal) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    setMenuStyle(computeSelectMenuStyle(trigger.getBoundingClientRect(), {
      align,
      placement,
      menuHeight,
    }));
  }, [align, placement, portal]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open || !portal) return;
    reposition();
    const onViewportChange = () => reposition(menuRef.current?.offsetHeight);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, options.length, portal, reposition]);

  useLayoutEffect(() => {
    if (!open || !portal || !menuRef.current || !triggerRef.current) return;
    const nextHeight = menuRef.current.offsetHeight;
    if (!nextHeight) return;
    const nextStyle = computeSelectMenuStyle(triggerRef.current.getBoundingClientRect(), {
      align,
      placement,
      menuHeight: nextHeight,
    });
    setMenuStyle(prev => {
      if (prev?.top === nextStyle.top && prev?.bottom === nextStyle.bottom && prev?.maxHeight === nextStyle.maxHeight) return prev;
      return nextStyle;
    });
  }, [align, open, options.length, placement, portal]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const active = menuRef.current.querySelector<HTMLElement>(`[id="${optionId(activeIndex)}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, optionId]);

  const selectIndex = (index: number) => {
    if (disabled) return;
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        openAt(open ? Math.min(options.length - 1, activeIndex + 1) : selectedIndex);
        break;
      case "ArrowUp":
        event.preventDefault();
        openAt(open ? Math.max(0, activeIndex - 1) : selectedIndex);
        break;
      case "Home":
        event.preventDefault();
        openAt(0);
        break;
      case "End":
        event.preventDefault();
        openAt(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) selectIndex(activeIndex);
        else openAt(selectedIndex);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close(true);
        }
        break;
      case "Tab":
        // Select-only combobox: commit the active option, then let focus leave naturally.
        if (open) {
          const option = options[activeIndex];
          if (option) onChange(option.value);
          setOpen(false);
        }
        break;
      default:
        break;
    }
  };

  const activeDescendant = open && options[activeIndex] ? optionId(activeIndex) : undefined;

  // A shared controller can flip `disabled` while the menu is already open (for
  // example `priorityUpdatingId` starts an order write). The trigger alone being
  // disabled must not leave the rendered option buttons able to call `onChange`
  // and silently drop the second update, so the dropdown is not rendered (and the
  // option buttons are disabled) whenever `disabled` is true.
  const dropdown = open && !disabled ? (
    <div
      ref={menuRef}
      id={listboxId}
      className={`select-dropdown${portal ? " select-dropdown-portal" : ""}${!portal && align === "right" ? " select-dropdown-right" : ""}${!portal && placement === "right" ? " select-dropdown-beside" : ""}`}
      role="listbox"
      aria-label={label}
      style={portal ? { ...menuStyle, zIndex: 60, ...dropdownStyle } : dropdownStyle}
    >
      {options.map((o, index) => (
        <button
          key={o.value}
          id={optionId(index)}
          type="button"
          role="option"
          tabIndex={-1}
          disabled={disabled}
          aria-selected={o.value === value}
          className={`select-option${o.value === value ? " active" : ""}${index === activeIndex ? " select-option-active" : ""}`}
          onMouseEnter={() => setHighlightIndex(index)}
          onClick={() => selectIndex(index)}
        >{o.label}</button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={ref} className="custom-select" style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        title={title}
        aria-describedby={describedBy}
        className="select-trigger"
        onClick={() => {
          if (disabled) return;
          if (open) close();
          else openAt(selectedIndex);
        }}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-label={label}
      >
        <span>{current?.label ?? value}</span>
        <IconChevron style={{ width: 12, height: 12, color: "var(--muted)", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
      </button>
      {portal ? (dropdown && createPortal(dropdown, document.body)) : dropdown}
    </div>
  );
}

export function EmptyState({ icon, title, children, className, style }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `empty ${className}` : "empty"} style={style}>
      {icon}
      <div className="title">{title}</div>
      {children && <div className="text-control">{children}</div>}
    </div>
  );
}

/* Hover/focus tooltip — styled replacement for the native `title` attribute. */
export function Tooltip({ content, children, side = "top", maxWidth = 280 }: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 150);
  };
  const hide = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    setOpen(false);
  };
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className="ocx-tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={event => {
        if (event.key === "Escape") hide();
      }}
      aria-describedby={open ? tipId : undefined}
      style={{ display: "inline", border: 0, background: "transparent", padding: 0, margin: 0, color: "inherit", font: "inherit", cursor: "inherit" }}
    >
      {children}
      {open && (
        <span id={tipId} className={`ocx-tooltip-bubble ocx-tooltip-bubble--${side}`} role="tooltip" style={{ maxWidth }}>
          {content}
        </span>
      )}
    </button>
  );
}
