/**
 * One card per public API (Responses, Chat Completions, Messages): whether it is served, where
 * it lives, and who decided that. The server resolves every state
 * (`resolveApiSurfaceSettings`); this component only names it.
 *
 * Messages is the one switchable surface. Its card stays visible while closed, so the operator
 * can see the endpoint that is being refused and reopen it. The toggle writes through
 * `PATCH /api/protocols/settings` on the target `apiBase` names, then asks the page to reload
 * the keys payload rather than predicting the new state.
 */
import { useState } from "react";
import { Notice, Switch } from "../ui";
import { useI18n, type TKey } from "../i18n/shared";
import { navigateHash } from "../hash-routing";
import { patchProtocolSettings } from "../protocol-api";
import type { GatewayInboundProtocol } from "../api-access-models";
import type { ApiEndpointInfo, ApiSurfaceInfo, ApiSurfaceSource, ApiSurfacesInfo } from "./api-keys-utils";
import { EndpointUrl } from "./api-keys-copy";

const CLAUDE_HASH = "integrations/claude";

const SOURCE_KEYS: Record<ApiSurfaceSource, TKey> = {
  fixed: "api.surface.source.fixed",
  "api-surfaces": "api.surface.source.explicit",
  "claude-code-legacy": "api.surface.source.inherited",
  invalid: "api.surface.source.invalid",
};

const CARDS: ReadonlyArray<{ id: GatewayInboundProtocol; titleKey: TKey; url: (endpoints: ApiEndpointInfo) => string }> = [
  { id: "responses", titleKey: "api.responsesEndpoint", url: endpoints => endpoints.responses },
  { id: "chat", titleKey: "api.chatCompletionsEndpoint", url: endpoints => endpoints.chatCompletions },
  { id: "messages", titleKey: "api.messagesEndpoint", url: endpoints => endpoints.messages },
];

type ToggleError = "failed" | "unavailable" | null;

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
  const [error, setError] = useState<ToggleError>(null);

  const toggleMessages = async (messages: ApiSurfaceInfo) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await patchProtocolSettings(apiBase, { messagesEnabled: !messages.enabled });
      if (result.kind === "ok") onChanged();
      else setError(result.kind === "unavailable" ? "unavailable" : "failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="api-endpoints api-surface-cards">
      {CARDS.map(card => {
        const surface = surfaces[card.id];
        const stateLabel = surface.enabled ? t("api.surface.on") : t("api.surface.off");
        return (
          <div
            key={card.id}
            className={`api-surface-card${surface.enabled ? "" : " api-surface-card-off"}`}
            data-surface={card.id}
          >
            <div className="api-surface-card-head">
              <span className="api-surface-card-title">{t(card.titleKey)}</span>
              {card.id === "messages" ? (
                <Switch
                  on={surface.enabled}
                  disabled={pending}
                  onClick={() => { void toggleMessages(surface); }}
                  label={`${t("api.surface.messagesToggle")}: ${stateLabel}`}
                />
              ) : null}
              <span className={`badge ${surface.enabled ? "badge-green" : "badge-muted"}`}>{stateLabel}</span>
            </div>
            <EndpointUrl url={card.url(endpoints)} />
            <span className={`small ${surface.source === "invalid" ? "api-surface-invalid" : "muted"}`}>
              {t(SOURCE_KEYS[surface.source])}
            </span>
            {card.id === "messages" ? (
              <>
                {!surface.enabled ? <span className="muted small">{t("api.surface.closedNote")}</span> : null}
                {surface.enabled ? <span className="muted small">{t("api.surface.messagesCloseNote")}</span> : null}
                <button type="button" className="btn btn-ghost btn-sm api-surface-card-link" onClick={() => navigateHash(CLAUDE_HASH)}>
                  {t("api.surface.openClaude")}
                </button>
                {error ? (
                  <Notice tone="err">{t(error === "unavailable" ? "api.surface.toggleUnavailable" : "api.surface.toggleFailed")}</Notice>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
