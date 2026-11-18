import { useId, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { HelpCircleIcon } from "@hugeicons/core-free-icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";
import { iconButton } from "./classes";

/**
 * A "?" beside a heading that opens a longer explanation underneath it. The text stays in
 * the document while closed (`hidden`), so it is still findable and testable; it simply
 * takes no room until someone asks for it.
 */
export function useHelpToggle(label: string) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = (
    <button
      type="button"
      className={cn(iconButton, open && "bg-surface-2 text-fg")}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={t("connectV2.moreAbout", { label })}
      onClick={() => setOpen(value => !value)}
    >
      <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
  const panel = (children: ReactNode, className?: string) => (
    <div
      id={panelId}
      hidden={!open}
      className={cn("ui-v2 rounded-[8px] bg-surface px-3.5 py-3 text-[13px] leading-5 text-fg-muted [&_p]:m-0 [&_p+p]:mt-2", className)}
    >
      {children}
    </div>
  );
  return { open, button, panel };
}
