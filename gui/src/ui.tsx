/* Shared UI primitives built on the design-system classes in styles.css. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconAlert } from "./icons";
import { IconChevron } from "./icons";
import { computeSelectMenuStyle } from "./select-position";

export function Switch({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" className={`switch${on ? " on" : ""}`} onClick={onClick} disabled={disabled}
      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")}>
      <span className="knob" />
    </button>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "err"; children: ReactNode }) {
  return (
    <div className={`notice ${tone === "ok" ? "notice-ok" : "notice-err"}`} role="status">
      {tone === "ok" ? <IconCheck /> : <IconAlert />}
      <span>{children}</span>
    </div>
  );
}

export interface SelectOption { value: string; label: React.ReactNode }

export function Select({ value, options, onChange, disabled, label, style, align, placement, dropdownStyle, portal = false }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  style?: CSSProperties;
  align?: "left" | "right";
  placement?: "below" | "right";
  dropdownStyle?: CSSProperties;
  portal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

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
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

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

  const dropdown = open ? (
    <div
      ref={menuRef}
      className={`select-dropdown${portal ? " select-dropdown-portal" : ""}${align === "right" ? " select-dropdown-right" : ""}${placement === "right" ? " select-dropdown-beside" : ""}`}
      role="listbox"
      aria-label={label}
      style={portal ? { ...menuStyle, zIndex: 60, ...dropdownStyle } : dropdownStyle}
    >
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="option"
          aria-selected={o.value === value}
          className={`select-option${o.value === value ? " active" : ""}`}
          onClick={() => { onChange(o.value); setOpen(false); }}
        >{o.label}</button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={ref} className="custom-select" style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
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
