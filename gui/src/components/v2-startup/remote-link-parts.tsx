import type { KeyboardEvent, ReactNode, Ref } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Home01Icon, LaptopIcon } from "@hugeicons/core-free-icons";
import { IconCheck, IconExternal } from "../../icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";
import { IconTile } from "./primitives";

/*
 * Presentation pieces of the v2 Remote Link page (React Bits `settings-form-3` for the switch
 * row and the role radios, `integrations-6` for the link rows, `app-dialog-4` for the steps).
 * They hold no link state: RemoteLink.tsx owns every request and transition.
 */

const homeIcon = <HugeiconsIcon icon={Home01Icon} size={18} strokeWidth={1.8} aria-hidden="true" />;
const childIcon = <HugeiconsIcon icon={LaptopIcon} size={18} strokeWidth={1.8} aria-hidden="true" />;

/** The one switch: Remote Link's own drawing (bridge.css paints it like every `.switch`). */
export function LinkSwitch({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  const t = useT();
  return <button type="button" role="switch" className="remote-link-switch shrink-0" aria-checked={on} aria-label={t("link.switch")} onClick={onToggle} disabled={disabled} />;
}

/** The switch row that heads the off and role-picking states. */
export function LinkSwitchRow({ on, onToggle, hint }: { on: boolean; onToggle: () => void; hint: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
          {t("link.switch")}
          <span className={cn("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", on ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-muted")}>{t(on ? "startupV2.on" : "startupV2.off")}</span>
        </span>
        <span className="text-[13px] leading-5 text-fg-muted">{hint}</span>
      </div>
      <LinkSwitch on={on} onToggle={onToggle} />
    </div>
  );
}

/** One machine of the Remote Link intro: its icon, role and a line on what it does. */
function machine(icon: ReactNode, title: string, hint: string) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3 rounded-[10px] bg-surface px-3.5 py-3 ring-1 ring-line">
      <IconTile>{icon}</IconTile>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] leading-5 font-semibold text-fg">{title}</span>
        <span className="text-[13px] leading-5 text-fg-muted">{hint}</span>
      </div>
    </div>
  );
}

/** Off state: what Remote Link is, in two machines and one line, under the switch. */
export function LinkIntro({ onTurnOn }: { onTurnOn: () => void }) {
  const t = useT();
  return (
    <section className="remote-link-intro flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-label={t("link.switch")}>
      <LinkSwitchRow on={false} onToggle={onTurnOn} hint={t("link.switchOffHint")} />
      <div className="flex min-w-0 flex-col gap-5 rounded-[8px] bg-bg p-5 ring-1 ring-line">
        <div className="flex max-w-[68ch] flex-col gap-1.5">
          <h3 className="m-0 text-[17px] leading-6 font-semibold tracking-[-0.015em] text-fg">{t("startupV2.linkIntroTitle")}</h3>
          <p className="m-0 text-[14px] leading-[21px] text-fg-muted">{t("startupV2.linkIntroBody")}</p>
        </div>
        <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {machine(homeIcon, t("link.role.home"), t("link.role.homeHint"))}
          <div aria-hidden="true" className="flex shrink-0 items-center justify-center gap-2 px-1 text-[11px] font-medium text-fg-subtle sm:flex-col sm:gap-1">
            <span className="hidden h-px w-10 bg-line-strong sm:block" />
            {t("startupV2.sshTunnel")}
            <span className="hidden h-px w-10 bg-line-strong sm:block" />
          </div>
          {machine(childIcon, t("link.role.child"), t("link.role.childHint"))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4 text-[13px] leading-5 text-fg-muted">
          <span className="min-w-0 flex-1">{t("link.setup.requirements")}</span>
          <a href="https://opencodex.me/guides/remote-link/" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-highlight hover:underline [&_svg]:size-3.5">
            {t("link.setup.guide")}<IconExternal aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}

/** One role radio card. The selected card takes the inverse primary ring, never blue. */
export function RoleCard({ role, checked, disabled, tabIndex, onSelect, onKeyDown, buttonRef }: {
  role: "home" | "child";
  checked: boolean;
  disabled?: boolean;
  tabIndex: number;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const t = useT();
  return (
    <button ref={buttonRef} type="button" role="radio" tabIndex={tabIndex} aria-checked={checked} aria-disabled={disabled}
      onClick={onSelect} onKeyDown={onKeyDown}
      className={cn(
        "remote-link-role-card ui-v2 group flex min-w-0 cursor-pointer items-start gap-3 rounded-[10px] bg-surface p-4 text-left ring-1 ring-line transition-[box-shadow,background-color]",
        "hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
        checked && "bg-raised ring-2 ring-fg",
        disabled && "cursor-not-allowed opacity-60 hover:bg-surface",
      )}>
      <IconTile>{role === "home" ? homeIcon : childIcon}</IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] leading-5 font-semibold text-fg">{t(role === "home" ? "link.role.home" : "link.role.child")}</span>
        <span className="text-[13px] leading-5 text-fg-muted">{t(role === "home" ? "link.role.homeHint" : "link.role.childHint")}</span>
      </span>
      <span aria-hidden="true" className={cn(
        "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full ring-1 ring-line-strong [&_svg]:size-3",
        checked && "bg-fg text-bg ring-fg",
      )}>{checked && <IconCheck />}</span>
    </button>
  );
}

const DOT: Record<string, string> = {
  connected: "bg-success",
  reconnecting: "bg-warning",
  connecting: "bg-warning",
  failed: "bg-danger",
  idle: "bg-fg-subtle",
};

/** A link's state as a dot and a word; `data-state` stays on the element for tests and styles. */
export function LinkStatus({ state, children }: { state: string; children: ReactNode }) {
  return (
    <span className={cn("remote-link-status inline-flex items-center gap-1.5 text-[13px] leading-5 font-medium", state === "failed" ? "text-danger" : "text-fg")} data-state={state}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[state] ?? DOT.idle)} />
      {children}
    </span>
  );
}

/** Square monogram for a linked machine (`integrations-6` source mark). */
export function Monogram({ name }: { name: string }) {
  const mark = name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
  return <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-raised font-mono text-[12px] font-medium text-fg ring-1 ring-line-strong">{mark}</span>;
}

/** Progress through the add-a-computer sheet (`app-dialog-4`). */
export function SheetSteps({ step }: { step: 0 | 1 | 2 }) {
  const t = useT();
  const labels = [t("startupV2.stepHost"), t("startupV2.stepVerify"), t("startupV2.stepConnect")];
  return (
    <ol aria-label={t("startupV2.steps")} className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[12px] leading-4">
      {labels.map((label, index) => (
        <li key={label} aria-current={index === step ? "step" : undefined} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden="true" className="h-px w-5 bg-line-strong" />}
          <span className={cn(
            "grid size-5 place-items-center rounded-full text-[11px] font-semibold tabular-nums [&_svg]:size-3",
            index < step ? "bg-success-soft text-success" : index === step ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-muted",
          )}>{index < step ? <IconCheck aria-hidden="true" /> : index + 1}</span>
          <span className={cn(index === step ? "font-medium text-fg" : "text-fg-muted")}>{label}</span>
        </li>
      ))}
    </ol>
  );
}
