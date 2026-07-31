/**
 * Endpoint + auth surface for the API tab.
 *
 * Split out of api-keys-panels.tsx when the auth matrix landed: the endpoint list
 * and the per-endpoint header rules are one subject, and the model catalog is a
 * different one that happened to share a file.
 */
import { useI18n, type TKey } from "../i18n/shared";
import type { ApiAuthDisposition, ApiAuthMatrixRow, ApiEndpointInfo } from "./api-keys-utils";
import { EndpointUrl } from "./api-keys-copy";

/** The server ships the rules; the GUI only names them. */
function dispositionLabel(value: ApiAuthDisposition, t: (key: TKey) => string): string {
  if (value === "required") return t("api.auth.required");
  if (value === "accepted") return t("api.auth.accepted");
  return t("api.auth.rejected");
}

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
  authMatrix,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
  authMatrix: ApiAuthMatrixRow[];
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel">
      <h3 className="panel-title">{t("api.endpointsTitle")}</h3>
      <div className="api-endpoints">
        <div>
          <span className="muted small">{t("api.baseUrl")}</span>
          <EndpointUrl url={endpoints.baseUrl} />
        </div>
        <div>
          <span className="muted small">{t("api.responsesEndpoint")}</span>
          <EndpointUrl url={endpoints.responses} />
        </div>
        <div>
          <span className="muted small">{t("api.chatCompletionsEndpoint")}</span>
          <EndpointUrl url={endpoints.chatCompletions} />
        </div>
        {claudeCodeEnabled && (
          <div>
            <span className="muted small">{t("api.messagesEndpoint")}</span>
            <EndpointUrl url={endpoints.messages} />
          </div>
        )}
        <div>
          <span className="muted small">{t("api.modelsEndpoint")}</span>
          <EndpointUrl url={endpoints.models} />
        </div>
      </div>
      <p className="muted small">{t("api.endpointNote")}</p>
      {/* Not a disclosure. This is the one thing a user needs before their first
          request succeeds, and the prose it replaces was wrong about Chat
          Completions for as long as it existed. */}
      <div className="api-auth-matrix-block">
        <h4 className="api-auth-matrix-title">{t("api.authTitle")}</h4>
        <div className="api-auth-matrix-scroll">
          <table className="api-auth-matrix">
            <thead>
              <tr>
                <th>{t("api.auth.endpoint")}</th>
                <th><code>Authorization: Bearer</code></th>
                <th><code>x-opencodex-api-key</code></th>
                <th><code>x-api-key</code></th>
                </tr>
            </thead>
            <tbody>
              {authMatrix.map(row => (
                <tr key={row.endpoint}>
                  <td><code>{row.endpoint}</code></td>
                  <td>{dispositionLabel(row.bearer, t)}</td>
                  <td>{dispositionLabel(row.dedicated, t)}</td>
                  <td>{dispositionLabel(row.xApiKey, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t("api.authLoopback")}</p>
        <p className="muted small">{t("api.authBaseUrlNote")}</p>
      </div>
    </div>
  );
}
