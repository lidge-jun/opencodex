import { useId, useState, type ReactNode } from "react";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";
import { iconButton } from "./frame-classes";
import { QuestionIcon } from "./frame";

/**
 * A "?" toggle for longer explanations. The text stays in the document while closed
 * (`hidden`), so it is still findable and testable; it simply takes no room.
 */
export function useHelpDisclosure(label: string) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = (
    <button
      type="button"
      className={cn(iconButton, "size-6 text-fg-subtle", open && "bg-surface-2 text-fg")}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={t("subagentsV2.moreAbout", { label })}
      onClick={() => setOpen(value => !value)}
    >
      <QuestionIcon aria-hidden="true" />
    </button>
  );
  const panel = (children: ReactNode, className?: string) => (
    <div
      id={panelId}
      hidden={!open}
      className={cn("rounded-[8px] bg-surface-2/60 px-3 py-2.5 text-[13px] leading-5 text-fg-muted [&_p]:m-0 [&_p+p]:mt-2", className)}
    >
      {children}
    </div>
  );
  return { open, button, panel };
}
