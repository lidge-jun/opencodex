import type { ReactNode } from "react";
import { IconChevron } from "../icons";
import type { TFn } from "../i18n/shared";

export default function CodexAuthAdvancedSettings({
  t,
  open,
  onToggle,
  children,
}: {
  t: TFn;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <section className="codex-auth-advanced">
      <button
        type="button"
        className="codex-auth-advanced__toggle"
        aria-expanded={open}
        aria-controls="codex-auth-advanced-boxes"
        onClick={onToggle}
      >
        <span>{t("codexAuth.advancedSettings")}</span>
        <IconChevron
          width={12}
          height={12}
          aria-hidden="true"
          className={open ? "codex-auth-advanced__chevron is-open" : "codex-auth-advanced__chevron"}
        />
      </button>
      {open && (
        <div id="codex-auth-advanced-boxes" className="codex-auth-advanced__boxes">
          {children}
        </div>
      )}
    </section>
  );
}
