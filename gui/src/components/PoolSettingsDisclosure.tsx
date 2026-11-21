/**
 * Header-only account pool settings (#fb-2100).
 *
 * A pool card shows its title and its on/off switch; everything else sits behind the title, which is
 * a disclosure button (WAI-ARIA APG disclosure pattern: a native button with aria-expanded and
 * aria-controls). The switch is passed in as `control` and rendered beside the button, never inside
 * it, so it keeps working while the details are closed.
 *
 * The details stay mounted while closed (`hidden`), so a value the card is still loading or saving
 * keeps its state. Closing remounts them, which drops anything transient inside, such as an open
 * Select whose menu is portaled to <body> and would otherwise outlive its hidden trigger.
 *
 * Which cards a person opened is remembered per card id. Only open ids are stored, so a card nobody
 * opened starts closed. Each toggle re-reads the stored set before writing it: two cards on one page
 * would otherwise each write back the set they read at mount and drop the other's entry.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { IconChevron } from "../icons";
import { makeCollapseStore } from "../pages/collapse-store";
import "../styles/pool-settings-disclosure.css";

const OPEN_CARDS = makeCollapseStore("ocx.accountPool.openSettings.v1");

export default function PoolSettingsDisclosure({
  cardId,
  title,
  control,
  notice,
  onCollapse,
  children,
}: {
  /** Remembers the open state: the provider id for a Claude card, a fixed name for a Codex one. */
  cardId: string;
  title: ReactNode;
  /** The card's switch, shown beside the title whether or not the details are open. */
  control?: ReactNode;
  /** Lines that must stay visible while closed, such as why the switch is disabled. */
  notice?: ReactNode;
  /** Runs before the details close, so a field inside can settle an edit in progress. */
  onCollapse?: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(() => OPEN_CARDS.read()?.has(cardId) ?? false);
  const [closings, setClosings] = useState(0);

  const toggle = () => {
    const next = !open;
    if (!next) {
      onCollapse?.();
      setClosings(count => count + 1);
    }
    const stored = new Set(OPEN_CARDS.read() ?? []);
    if (next) stored.add(cardId);
    else stored.delete(cardId);
    OPEN_CARDS.write(stored);
    setOpen(next);
    // Safari does not focus a clicked button; focus left inside the details would be lost.
    if (!next) buttonRef.current?.focus();
  };

  return (
    <>
      <div className="card-row pool-disclosure__head">
        <button
          ref={buttonRef}
          type="button"
          className="pool-disclosure__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <IconChevron width={14} height={14} aria-hidden="true" className={open ? "pool-disclosure__chevron is-open" : "pool-disclosure__chevron"} />
          <strong>{title}</strong>
        </button>
        {control}
      </div>
      {notice}
      <div key={closings} id={bodyId} className="pool-disclosure__body" hidden={!open}>
        {children}
      </div>
    </>
  );
}
