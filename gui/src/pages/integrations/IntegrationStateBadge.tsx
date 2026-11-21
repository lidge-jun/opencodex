import { useT, type TKey } from "../../i18n/shared";
import type { IntegrationState } from "./integration-api";

/**
 * `unknown` is not a server state: it is what the overview renders while a
 * source has not settled or its request failed. Without it an in-flight or
 * broken read paints as "not applied", which is the one thing the badge must
 * never claim on someone else's behalf.
 */
export type VisualIntegrationState = "not-installed" | "unknown" | IntegrationState;

const LABEL_KEYS: Record<VisualIntegrationState, TKey> = {
  "not-installed": "integrations.state.notInstalled",
  unknown: "integrations.state.unknown",
  absent: "integrations.state.absent",
  current: "integrations.state.current",
  stale: "integrations.state.stale",
  conflict: "integrations.state.conflict",
  unsafe: "integrations.state.unsafe",
};

const CLASSES: Record<VisualIntegrationState, string> = {
  "not-installed": "badge badge-muted",
  unknown: "badge badge-muted",
  absent: "badge badge-muted",
  current: "badge badge-green",
  stale: "badge badge-amber",
  conflict: "badge integration-badge--danger",
  unsafe: "badge integration-badge--danger-outline",
};

export default function IntegrationStateBadge({
  state,
  installed,
  id,
  onActivate,
  activateLabel,
  busy,
}: {
  state: IntegrationState | VisualIntegrationState;
  installed: boolean;
  id?: string;
  /**
   * Turns the pill into a button. Only a caller that has a safe action for this exact
   * state passes it (the overview offers a one-click re-apply for "Update needed").
   */
  onActivate?: () => void;
  /** Tooltip naming what the click does; the visible text stays the state itself. */
  activateLabel?: string;
  busy?: boolean;
}) {
  const t = useT();
  // A caller that already resolved the visual state passes it through; the
  // file-client pages still hand over the raw server state plus `installed`.
  const visual: VisualIntegrationState = state === "unknown" || state === "not-installed"
    ? state
    : installed ? state : "not-installed";
  if (onActivate) {
    return (
      <button
        type="button"
        id={id}
        className={`${CLASSES[visual]} integration-badge-action`}
        data-integration-state={visual}
        title={activateLabel}
        onClick={onActivate}
        disabled={busy}
      >
        {t(LABEL_KEYS[visual])}
      </button>
    );
  }
  return (
    <span id={id} className={CLASSES[visual]} data-integration-state={visual}>
      {t(LABEL_KEYS[visual])}
    </span>
  );
}
