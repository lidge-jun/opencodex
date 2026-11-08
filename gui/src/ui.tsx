/* Shared UI primitives built on the design-system classes in styles.css. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconAlert } from "./icons";
import { IconChevron } from "./icons";
import { computeSelectMenuStyle } from "./select-position";
import { cn } from "./lib/utils";

/**
 * `label` is the accessible name. It is NOT rendered by default, which is correct
 * for a switch inside an already-labeled row and was also a defect: the two
 * provider-header switches passed a label and rendered a bare knob, so a sighted
 * user could not tell what they toggled (devlog/_fin/260830_models_provider_header/
 * 020_control_affordances.md).
 *
 * `showLabel` renders the label as visible text INSIDE the button, so the words
 * both name the control and toggle it. An earlier revision put that text in an
 * `aria-hidden` sibling span; the audit caught that clicking the visible label did
 * nothing, because the hit target stayed the 34x20 knob. Text inside the button is
 * the element's own content, so it supplies the accessible name on its own and
 * `aria-label` must be dropped — otherwise `aria-label` would override the visible
 * words and break Label-in-Name.
 *
 * `title` stays strictly opt-in. Defaulting it to `label` was rejected for the same
 * reason: HTML-AAM maps `title` to the accessible description when
 * `aria-describedby` is absent, so every untouched bare `Switch` would have been
 * announced twice with a description that repeats its own name.
 */
export function Switch({ on, mixed, onClick, disabled, label, showLabel = false, title }: { on: boolean; mixed?: boolean; onClick: () => void; disabled?: boolean; label?: string; showLabel?: boolean; title?: string }) {
  const labeled = showLabel && !!label;
  // ARIA switches are binary. Controls that can represent a mixed bulk selection
  // retain toggle-button semantics for all three states.
  const triState = mixed !== undefined;
  return (
    <button type="button"
      className={`switch${on ? " on" : ""}${mixed ? " mixed" : ""}${labeled ? " switch-labeled" : ""}`}
      onClick={onClick} disabled={disabled}
      role={triState ? undefined : "switch"}
      aria-checked={triState ? undefined : on}
      aria-pressed={triState ? (mixed ? "mixed" : on) : undefined}
      aria-label={labeled ? undefined : (label ?? (on ? "enabled" : "disabled"))}
      title={title}>
      <span className="knob" />
      {labeled ? <span className="switch-labeled-text text-label muted">{label}</span> : null}
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

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  /** Listed but not choosable, like a native `<option disabled>` (a placeholder, an unusable row). */
  disabled?: boolean;
  /** Plain text for type-ahead when `label` is not a string. */
  textValue?: string;
}

function optionText(option: SelectOption): string {
  if (option.textValue !== undefined) return option.textValue;
  return typeof option.label === "string" || typeof option.label === "number" ? String(option.label) : option.value;
}

/**
 * The app's dropdown: a select-only combobox (button + portaled listbox). It is the ONLY
 * dropdown in `src/` — native `<select>` is banned by `tests/form-controls-rule.test.ts`
 * because the browser paints it unstyled (grey, unreadable in dark mode).
 *
 * Sizing for form layouts: `fullWidth` fills the field like `.input`; `size="sm"` is the
 * compact control (`--ocx-control-h-sm`, 28px) for filter bars. `className` goes on the wrapper (layout hooks such as
 * flex sizing), `triggerClassName` on the button. `required`/`name` keep native form
 * validation and submission through a visually hidden proxy input.
 */
export function Select({
  value, options, onChange, disabled, id, label, labelledBy, describedBy, invalid, title, style, align, placement,
  dropdownStyle, portal: portalProp, className, triggerClassName, fullWidth, size, name, required,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Put on the trigger, so a sibling `<label htmlFor>` can name it — a button is labelable. */
  id?: string;
  /** Accessible name (`aria-label` on the trigger and the listbox). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
  title?: string;
  style?: CSSProperties;
  align?: "left" | "right";
  placement?: "below" | "right";
  dropdownStyle?: CSSProperties;
  /**
   * When true, the menu is portaled to `<body>` and flips above the trigger if it would leave
   * the viewport. Unset (the default) means true, except inside a `<dialog>`: a modal dialog
   * sits in the top layer and makes everything outside it inert, so a body-level menu would be
   * hidden behind it and unclickable. There the menu renders in place, under the trigger.
   */
  portal?: boolean;
  className?: string;
  triggerClassName?: string;
  /** Fill the container's width, label left and chevron right, at the `.input` field height. */
  fullWidth?: boolean;
  size?: "sm";
  name?: string;
  required?: boolean;
}) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>();
  const [inDialog, setInDialog] = useState(false);
  const portal = portalProp ?? !inDialog;
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const optionId = useCallback((index: number) => `${listboxId}-${index}`, [listboxId]);
  const current = options.find(o => o.value === value);
  const selectedIndex = options.length === 0 ? 0 : Math.max(0, options.findIndex(o => o.value === value));
  // While open, keyboard/hover highlight wins; while closed, follow the selected value.
  // Clamp so aria-activedescendant never points at a missing option after shrink/reorder.
  const activeIndex = !open || options.length === 0
    ? selectedIndex
    : Math.min(highlightIndex ?? selectedIndex, options.length - 1);

  /** The nearest choosable option from `from` (inclusive) walking by `step`; `fallback` when none. */
  const enabledFrom = (from: number, step: 1 | -1, fallback = from): number => {
    for (let i = from; i >= 0 && i < options.length; i += step) {
      if (!options[i]?.disabled) return i;
    }
    return fallback;
  };

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setHighlightIndex(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openAt = useCallback((index: number) => {
    if (disabled || options.length === 0) return;
    const clamped = Math.max(0, Math.min(options.length - 1, index));
    setInDialog(Boolean(triggerRef.current?.closest("dialog")));
    setHighlightIndex(clamped);
    setOpen(true);
  }, [disabled, options.length]);

  /** Native-select type-ahead: typed letters jump to the next option whose text starts with them. */
  const typeAhead = (key: string): boolean => {
    const now = Date.now();
    const buffer = typeahead.current;
    buffer.text = now - buffer.at > 700 ? key : buffer.text + key;
    buffer.at = now;
    // A repeated single letter ("ccc") cycles through the matches for that letter; a longer
    // prefix ("cob") refines the search from the current row.
    const cycling = [...buffer.text].every(char => char === buffer.text[0]);
    const needle = (cycling ? buffer.text[0]! : buffer.text).toLocaleLowerCase();
    const start = cycling ? activeIndex + 1 : activeIndex;
    for (let step = 0; step < options.length; step++) {
      const index = (start + step) % options.length;
      const option = options[index]!;
      if (!option.disabled && optionText(option).toLocaleLowerCase().startsWith(needle)) {
        openAt(index);
        return true;
      }
    }
    return false;
  };

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
    if (!option || option.disabled) return;
    // Unlike a native `change`, re-picking the current value still calls `onChange`: entries
    // such as "Custom…" (shown as the value for an unlisted number) rely on it to open their
    // editor. A save-on-change caller compares with its current value itself.
    onChange(option.value);
    close(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        openAt(open ? enabledFrom(Math.min(options.length - 1, activeIndex + 1), 1, activeIndex) : selectedIndex);
        break;
      case "ArrowUp":
        event.preventDefault();
        openAt(open ? enabledFrom(Math.max(0, activeIndex - 1), -1, activeIndex) : selectedIndex);
        break;
      case "Home":
        event.preventDefault();
        openAt(enabledFrom(0, 1));
        break;
      case "End":
        event.preventDefault();
        openAt(enabledFrom(options.length - 1, -1));
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
          if (option && !option.disabled) onChange(option.value);
          setOpen(false);
        }
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
          if (typeAhead(event.key)) event.preventDefault();
        }
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
          disabled={disabled || o.disabled}
          aria-disabled={o.disabled || undefined}
          aria-selected={o.value === value}
          data-value={o.value}
          className={cn(
            "select-option",
            o.value === value && "active",
            index === activeIndex && "select-option-active",
            o.disabled && "cursor-default opacity-45",
          )}
          onMouseEnter={() => { if (!o.disabled) setHighlightIndex(index); }}
          onClick={() => selectIndex(index)}
        >{o.label}</button>
      ))}
    </div>
  ) : null;

  return (
    <div
      ref={ref}
      className={cn("custom-select", fullWidth && "w-full min-w-0", className)}
      style={{ position: "relative", display: fullWidth ? "block" : "inline-block", ...style }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        title={title}
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        data-value={value}
        className={cn(
          "select-trigger",
          fullWidth && "w-full min-w-0 justify-between px-[11px] py-2 text-left",
          size === "sm" && "h-[var(--ocx-control-h-sm)] min-h-0 px-2.5 py-0 text-[13px]",
          triggerClassName,
        )}
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
        <span className={fullWidth ? "min-w-0 truncate" : undefined}>{current?.label ?? value}</span>
        <IconChevron style={{ flexShrink: 0, width: 12, height: 12, color: "var(--muted)", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
      </button>
      {(required || name !== undefined) && (
        // Keeps native constraint validation (`required` blocks submit) and form submission
        // (`name`) for a button-based control. Invisible and out of the tab order; when the
        // browser focuses it to report "please select", focus moves on to the trigger.
        <input
          className="select-form-proxy"
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          required={required}
          disabled={disabled}
          value={value}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: 1, opacity: 0, pointerEvents: "none", border: 0, padding: 0, margin: 0 }}
        />
      )}
      {portal ? (dropdown && createPortal(dropdown, document.body)) : dropdown}
    </div>
  );
}

/** A positioned Select surface for grouped, searchable choices with their own semantics. */
function SelectPopup({ open, onOpenChange, trigger, label, children, initialFocusRef, width = 354, maxHeight = 520, className, onKeyDown }: {
  open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactNode; label: string; children: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>; width?: number; maxHeight?: number; className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [inDialog, setInDialog] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      setPosition(computeSelectMenuStyle(triggerRef.current.getBoundingClientRect(), { menuWidth: width, menuHeight: maxHeight, maxMenuHeight: maxHeight }));
    };
    update();
    initialFocusRef?.current?.focus();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, width, maxHeight, initialFocusRef]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) onOpenChange(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("focusin", outside); };
  }, [open, onOpenChange]);
  const popup = open ? <div ref={popupRef} id={id} role="dialog" aria-label={label}
    className={cn("select-dropdown select-dropdown-portal", className)}
    style={inDialog ? { position: "absolute", top: "calc(100% + 4px)", left: 0, width: `min(${width}px, calc(100vw - 16px))`, maxHeight } : { ...position, width: `min(${width}px, calc(100vw - 16px))`, zIndex: "var(--z-popover)" }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onOpenChange(false); triggerRef.current?.focus(); return; }
      onKeyDown?.(event);
    }}>
    {children}
  </div> : null;
  return <div className="custom-select" style={{ position: "relative", display: "inline-block" }}>
    <button ref={triggerRef} type="button" className="select-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => { setInDialog(Boolean(triggerRef.current?.closest("dialog"))); onOpenChange(!open); }}>
      {trigger}<IconChevron style={{ flexShrink: 0, width: 12, height: 12, color: "var(--muted)" }} />
    </button>
    {inDialog ? popup : popup && createPortal(popup, document.body)}
  </div>;
}

Select.Popup = SelectPopup;

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
