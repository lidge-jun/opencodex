import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";
import { iconButton } from "./classes";

/**
 * A command or snippet people copy into a terminal: machine text in a quiet inset block,
 * with a copy button in its corner. The button is a bare icon until hovered; after a copy
 * it shows a tick for a moment and a polite live region says "Copied".
 */
export function CodeBlock({ code, className, size = "md" }: { code: string; className?: string; size?: "md" | "sm" }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  const label = state === "copied" ? t("api.copied") : t("api.copy");
  return (
    <div className={cn("ui-v2 relative min-w-0 rounded-[8px] bg-surface ring-1 ring-inset ring-line", className)}>
      <pre className={cn(
        "m-0 overflow-x-auto py-2.5 pr-11 pl-3.5 font-mono whitespace-pre text-fg",
        size === "sm" ? "text-[12px] leading-5" : "text-[13px] leading-5",
      )}><code>{code}</code></pre>
      <button
        type="button"
        className={cn(iconButton, "absolute top-1 right-1", state === "copied" && "text-success hover:text-success")}
        aria-label={label}
        title={label}
        onClick={() => { void copy(); }}
      >
        <HugeiconsIcon icon={state === "copied" ? Tick02Icon : Copy01Icon} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? t("api.copied") : state === "failed" ? t("api.key.copyFailedShort") : ""}
      </span>
    </div>
  );
}
