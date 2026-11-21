import type { ReactElement } from "react";
import { CommandRow } from "../components/v2-startup/primitives";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { useT } from "../i18n/shared";

/** The link a connected Child reports in `/api/machine/status`. */
export interface ChildLinkView { linkId: string; home: string | null }

/**
 * The way out of a Remote Link on the Child itself (#8985). The Child's listener refuses durable
 * changes from a dashboard session (a loopback session proves possession, not presence), so the page
 * names the commands instead of offering a button. `--expect-link` makes the disconnect refuse unless
 * this computer is still on the link the page shows.
 */
export function RemoteLinkChildDisconnect({ link }: { link: ChildLinkView }): ReactElement {
  const t = useT();
  const { outcomeFor, copy } = useCopyFeedback<string>();
  const steps = [
    { label: t("remoteLinkChild.stepDisconnect"), command: "ocx disconnect --expect-link " + link.linkId },
    { label: t("remoteLinkChild.stepRestart"), command: "ocx restart" },
  ];
  return (
    <section data-section="link-child-disconnect" className="remote-link-panel flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-labelledby="remote-link-child-disconnect-title">
      <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
        <h3 id="remote-link-child-disconnect-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em]">{t("remoteLinkChild.title")}</h3>
        <p className="m-0 max-w-[72ch] text-[13px] leading-5 text-fg-muted">
          {link.home ? t("remoteLinkChild.body", { home: link.home }) : t("remoteLinkChild.bodyUnnamed")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col divide-y divide-line rounded-[8px] bg-bg ring-1 ring-line">
        {steps.map(step => (
          <CommandRow key={step.command} label={step.label} command={step.command} copied={outcomeFor(step.command) === "copied"} onCopy={() => copy(step.command, step.command)} />
        ))}
      </div>
      <p className="m-0 px-4 py-2.5 text-[12.5px] leading-5 text-fg-muted">{t("remoteLinkChild.homeAlternative")}</p>
    </section>
  );
}
