/**
 * Model settings panel for the Models catalog.
 *
 * The catalog's global controls (new-model policy, aliases, shadow intercept, sub-agent
 * surface, default window, picker order, fast rows) used to sit in the model column above
 * the first provider card, so the list the page exists for started a full screen down.
 * They now fold into one panel above the rail/list workspace. Folding must never hide
 * state: the summary line names every folded control that changes behaviour and its
 * current value, and a pending warning opens the panel on its own.
 *
 * Only a user toggle is remembered. A warning-forced open is derived, never stored:
 * persisting it would keep the panel open after the warning clears. Closing the panel
 * while a warning is showing dismisses the forced open for this visit.
 */
import { useState, type ReactNode } from "react";
import { IconInfo } from "../icons";
import { Tooltip } from "../ui";
import type { StorageLike } from "./collapse-store";
import { readSettingsOpen, writeSettingsOpen, type SettingsSummaryItem } from "./models-settings-summary";

export function ModelsSettingsPanel({ title, attentionLabel, summary, warn, children, storage }: {
  title: string;
  attentionLabel: string;
  summary: SettingsSummaryItem[];
  warn: boolean;
  children: ReactNode;
  storage?: StorageLike;
}) {
  const [open, setOpen] = useState(() => readSettingsOpen(storage));
  const [warnDismissed, setWarnDismissed] = useState(false);
  const shown = open || (warn && !warnDismissed);

  return (
    <details
      className="models-settings"
      open={shown}
      onToggle={event => {
        // React writes `open` before the browser fires toggle, so an event that already
        // matches the rendered state is our own render, not a user action.
        const next = event.currentTarget.open;
        if (next === shown) return;
        setOpen(next);
        if (!next && warn) setWarnDismissed(true);
        writeSettingsOpen(next, storage);
      }}
    >
      <summary className="models-settings-summary">
        <span className="models-settings-title">{title}</span>
        {warn && <span className="models-settings-warn" role="img" aria-label={attentionLabel} title={attentionLabel} />}
        <span className="models-settings-state">
          {summary.map(item => (
            <span key={item.id} className="models-settings-kv" data-item={item.id}>
              <span className="models-settings-k">{item.label}</span>
              {item.value && <span className="models-settings-v">{item.value}</span>}
            </span>
          ))}
        </span>
      </summary>
      <div className="models-settings-body">{children}</div>
    </details>
  );
}

/** Custom-model count; describes the list, so it lives on the list toolbar. */
export function CustomModelsSummary({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return <span className="models-chip mono text-caption models-custom-summary">{label}</span>;
}

/**
 * A long explanatory hint folded behind an info glyph. The full text stays the trigger's
 * accessible name (Tooltip renders the focusable button; the visually hidden copy names
 * it), so screen readers lose nothing when the paragraph leaves the layout.
 */
export function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip content={text} side="top" maxWidth={360}>
      <span className="models-info-hint">
        <IconInfo width={14} height={14} aria-hidden="true" />
        <span className="sr-only">{text}</span>
      </span>
    </Tooltip>
  );
}
