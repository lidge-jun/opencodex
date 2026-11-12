import { cn } from "@/lib/utils";

/*
 * A quiet switch for a polling surface (Logs auto-refresh, Debug follow). It stays a real
 * checkbox inside its label, so the click target, the accessible name and form semantics are
 * the native ones; only the box is drawn as a small track in the inverse primary.
 */
export function LiveToggle({ checked, onChange, label, title, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <label
      title={title}
      className={cn(
        "inline-flex h-[var(--ocx-control-h)] shrink-0 cursor-pointer items-center gap-2 rounded-control px-2 text-[13px] font-medium text-fg-muted transition-colors select-none hover:bg-accent-soft hover:text-fg",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 ring-1 ring-inset transition-colors duration-200",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-highlight",
          checked ? "bg-accent ring-transparent" : "bg-surface-2 ring-line-strong",
        )}
      >
        <span
          className={cn(
            "size-3 rounded-full shadow-sm transition-transform duration-200 ease-soft",
            checked ? "translate-x-3 bg-on-accent" : "translate-x-0 bg-fg-subtle",
          )}
        />
      </span>
      {label}
    </label>
  );
}
