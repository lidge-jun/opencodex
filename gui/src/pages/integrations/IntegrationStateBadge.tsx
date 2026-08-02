import { useT, type TKey } from "../../i18n/shared";
import type { IntegrationState } from "./integration-api";

export type VisualIntegrationState = "not-installed" | IntegrationState;

const LABEL_KEYS: Record<VisualIntegrationState, TKey> = {
  "not-installed": "integrations.state.notInstalled",
  absent: "integrations.state.absent",
  current: "integrations.state.current",
  stale: "integrations.state.stale",
  conflict: "integrations.state.conflict",
  unsafe: "integrations.state.unsafe",
};

const CLASSES: Record<VisualIntegrationState, string> = {
  "not-installed": "badge badge-muted",
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
}: {
  state: IntegrationState;
  installed: boolean;
  id?: string;
}) {
  const t = useT();
  const visual: VisualIntegrationState = installed ? state : "not-installed";
  return (
    <span id={id} className={CLASSES[visual]} data-integration-state={visual}>
      {t(LABEL_KEYS[visual])}
    </span>
  );
}
