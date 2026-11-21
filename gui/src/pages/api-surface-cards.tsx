/**
 * Gateway endpoint cards show the state reported by the server. Closed APIs stay visible so
 * the operator can reopen them. Toggles patch protocol settings on the selected target and
 * reload the keys payload.
 */
import { useState } from "react";
import { Notice, Switch } from "../ui";
import { useI18n, type TKey } from "../i18n/shared";
import { navigateHash } from "../hash-routing";
import { patchProtocolSettings } from "../protocol-api";
import type { ApiEndpointInfo, ApiSurfaceInfo, ApiSurfaceSource, ApiSurfacesInfo } from "./api-keys-utils";
import { EndpointUrl } from "./api-keys-copy";

const CLAUDE_HASH = "claude/code";

const SOURCE_KEYS: Record<ApiSurfaceSource, TKey> = {
  fixed: "api.surface.source.fixed",
  default: "api.surface.source.default",
  "api-surfaces": "api.surface.source.explicit",
  "claude-code-legacy": "api.surface.source.inherited",
  invalid: "api.surface.source.invalid",
};

const CARDS: ReadonlyArray<{ id: keyof ApiSurfacesInfo; titleKey: TKey; url: (endpoints: ApiEndpointInfo) => string | undefined }> = [
  { id: "responses", titleKey: "api.responsesEndpoint", url: endpoints => endpoints.responses },
  { id: "chat", titleKey: "api.chatCompletionsEndpoint", url: endpoints => endpoints.chatCompletions },
  { id: "messages", titleKey: "api.messagesEndpoint", url: endpoints => endpoints.messages },
  { id: "gemini", titleKey: "api.geminiEndpoint", url: endpoints => endpoints.geminiModels },
];

const TOGGLES = {
  messages: { label: "api.surface.messagesToggle", failed: "api.surface.toggleFailed", unavailable: "api.surface.toggleUnavailable" },
  gemini: { label: "api.surface.geminiToggle", failed: "api.surface.geminiToggleFailed", unavailable: "api.surface.geminiToggleUnavailable" },
} as const satisfies Record<string, { label: TKey; failed: TKey; unavailable: TKey }>;

type SwitchableSurface = keyof typeof TOGGLES;
type ToggleError = { surface: SwitchableSurface; kind: "failed" | "unavailable" };

export function ApiSurfaceCards({
  apiBase,
  endpoints,
  surfaces,
  onChanged,
}: {
  apiBase: string;
  endpoints: ApiEndpointInfo;
  surfaces: ApiSurfacesInfo;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ToggleError | null>(null);

  const toggleSurface = async (id: SwitchableSurface, surface: ApiSurfaceInfo) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await patchProtocolSettings(apiBase, id === "messages"
        ? { messagesEnabled: !surface.enabled }
        : { geminiEnabled: !surface.enabled });
      if (result.kind === "ok") onChanged();
      else setError({ surface: id, kind: result.kind === "unavailable" ? "unavailable" : "failed" });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="api-endpoints api-surface-cards">
      {CARDS.map(card => {
        const surface = surfaces[card.id];
        const url = card.url(endpoints);
        if (!surface || !url) return null;
        const switchable = card.id === "messages" || card.id === "gemini" ? card.id : undefined;
        const toggle = switchable && TOGGLES[switchable];
        const stateLabel = surface.enabled ? t("api.surface.on") : t("api.surface.off");
        return (
          <div
            key={card.id}
            className={`api-surface-card${surface.enabled ? "" : " api-surface-card-off"}`}
            data-surface={card.id}
          >
            <div className="api-surface-card-head">
              <span className="api-surface-card-title">{t(card.titleKey)}</span>
              {switchable && toggle ? (
                <Switch
                  on={surface.enabled}
                  disabled={pending}
                  onClick={() => { void toggleSurface(switchable, surface); }}
                  label={`${t(toggle.label)}: ${stateLabel}`}
                />
              ) : null}
              <span className={`badge ${surface.enabled ? "badge-green" : "badge-muted"}`}>{stateLabel}</span>
            </div>
            <EndpointUrl url={url} />
            <span className={`small ${surface.source === "invalid" ? "api-surface-invalid" : "muted"}`}>
              {t(SOURCE_KEYS[surface.source])}
            </span>
            {toggle && !surface.enabled ? <span className="muted small">{t("api.surface.closedNote")}</span> : null}
            {card.id === "messages" ? (
              <>
                {surface.enabled ? <span className="muted small">{t("api.surface.messagesCloseNote")}</span> : null}
                <button type="button" className="btn btn-ghost btn-sm api-surface-card-link" onClick={() => navigateHash(CLAUDE_HASH)}>
                  {t("api.surface.openClaude")}
                </button>
              </>
            ) : null}
            {toggle && error?.surface === card.id ? <Notice tone="err">{t(toggle[error.kind])}</Notice> : null}
          </div>
        );
      })}
    </div>
  );
}
