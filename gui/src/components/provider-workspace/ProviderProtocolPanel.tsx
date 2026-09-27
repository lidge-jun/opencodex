/**
 * The upstream wire one provider receives, and who decided it — a section of provider
 * settings, read from `GET /api/protocols?provider=<name>`.
 *
 * This is the format opencodex speaks TO the provider. It opens or closes no client API
 * (Responses, Chat Completions, Messages); those are the API page's cards, so nothing here is
 * a switch. The one editable input stays the adapter field of the settings form, which saves
 * through `onUpdateProvider` → `PATCH /api/providers` like every other provider field; this
 * panel only says what an unsaved change would do. An older server (404 or no `provider`
 * block) hides the panel.
 */
import { useEffect, useState } from "react";
import { upstreamWireForAdapter } from "../../../../src/protocols/contract";
import type { ProtocolAdapterSource, ProtocolProviderSummaryV1 } from "../../../../src/protocols/dto";
import { useT, type TKey } from "../../i18n/shared";
import { fetchProtocolProviderSummary } from "../../protocol-api";
import { protocolHopLabel } from "../protocols/protocol-labels";

const SOURCE_KEYS: Record<ProtocolAdapterSource, TKey> = {
  "hard-pin": "pws.protocol.source.hardPin",
  operator: "pws.protocol.source.operator",
  registry: "pws.protocol.source.registry",
  "provider-default": "pws.protocol.source.providerDefault",
};

type LoadState =
  | { key: string; kind: "summary"; summary: ProtocolProviderSummaryV1 }
  | { key: string; kind: "hidden" }
  | { key: string; kind: "error" };

function WireText({ adapter }: { adapter: string }) {
  const t = useT();
  return (
    <span className="ppp-wire">
      <code>{adapter}</code>
      <span className="muted">{protocolHopLabel(upstreamWireForAdapter(adapter), t)}</span>
    </span>
  );
}

export function ProviderProtocolPanel({
  apiBase,
  providerName,
  savedAdapter,
  draftAdapter,
  refreshKey,
}: {
  apiBase?: string;
  providerName: string;
  /** The saved adapter; a change after a PATCH refetches the summary. */
  savedAdapter: string;
  /** The settings form's unsaved adapter choice, when it differs from the saved one. */
  draftAdapter?: string;
  /** Any other saved field that can move the resolved wire (base URL, auth mode). */
  refreshKey?: string;
}) {
  const t = useT();
  const requestKey = JSON.stringify([apiBase ?? "", providerName, savedAdapter, refreshKey ?? ""]);
  const [state, setState] = useState<LoadState | null>(null);

  useEffect(() => {
    if (apiBase === undefined) return;
    const controller = new AbortController();
    fetchProtocolProviderSummary(apiBase, providerName, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setState(result.kind === "summary"
          ? { key: requestKey, kind: "summary", summary: result.summary }
          : { key: requestKey, kind: result.kind === "unavailable" ? "hidden" : "error" });
      })
      .catch(() => { /* aborted by a newer request or by unmount */ });
    return () => controller.abort();
  }, [apiBase, providerName, requestKey]);

  const current = state?.key === requestKey ? state : null;
  if (apiBase === undefined || !current || current.kind === "hidden") return null;

  const pendingAdapter = draftAdapter && draftAdapter !== savedAdapter ? draftAdapter : null;
  return (
    <section className="ppp-card" aria-labelledby="ppp-title" data-testid="provider-protocol-panel">
      <h3 id="ppp-title">{t("pws.protocol.title")}</h3>
      <p className="pwi-settings-hint">{t("pws.protocol.note")}</p>
      {current.kind === "error" ? (
        <p className="muted small" role="status">{t("pws.protocol.loadFailed")}</p>
      ) : (
        <>
          <dl className="ppp-kv">
            <div>
              <dt>{t("pws.protocol.adapterLabel")}</dt>
              <dd><WireText adapter={current.summary.adapter} /></dd>
            </div>
            <div>
              <dt>{t("pws.protocol.source")}</dt>
              <dd data-adapter-source={current.summary.adapterSource}>{t(SOURCE_KEYS[current.summary.adapterSource])}</dd>
            </div>
            {current.summary.authMode && (
              <div>
                <dt>{t("pws.authMode")}</dt>
                <dd><code>{current.summary.authMode}</code></dd>
              </div>
            )}
          </dl>
          {pendingAdapter && (
            <p className="ppp-pending" role="status">{t("pws.protocol.pending", { adapter: pendingAdapter })}</p>
          )}
          <h4>{t("pws.protocol.overrides")}</h4>
          {current.summary.modelOverrides.length === 0 ? (
            <p className="muted small">{t("pws.protocol.noOverrides")}</p>
          ) : (
            <table className="ppp-overrides">
              <thead>
                <tr>
                  <th scope="col">{t("pws.protocol.col.model")}</th>
                  <th scope="col">{t("pws.protocol.col.wire")}</th>
                  <th scope="col">{t("pws.protocol.col.source")}</th>
                </tr>
              </thead>
              <tbody>
                {current.summary.modelOverrides.map(row => (
                  <tr key={row.model}>
                    <td><code>{row.model}</code></td>
                    <td><WireText adapter={row.adapter} /></td>
                    <td data-adapter-source={row.source}>{t(SOURCE_KEYS[row.source])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {current.summary.modelOverridesTruncated && (
            <p className="muted small">{t("pws.protocol.overridesTruncated", { count: current.summary.modelOverrides.length })}</p>
          )}
        </>
      )}
    </section>
  );
}
