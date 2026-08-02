/**
 * The key list, as a table (devlog 260802/020, revised after the maintainer asked
 * for a top strip instead of a side rail).
 *
 * This replaces the workspace rail. A rail and a content pane were two vertical
 * bands competing for the same width; a table is also the better surface for what
 * these rows are, which is comparative — requests and last-used sort, a rail does
 * not. Selecting a row opens the existing detail pane.
 */
import { useT } from "../../i18n/shared";
import { formatCreatedDate, type ApiKeyEntry } from "../../pages/api-keys-utils";

export default function ApiKeysListPanel({
  keys,
  keysLoading,
  keysLoadFailed,
  attributionSince,
  localeTag,
  busy,
  onSelect,
}: {
  keys: ApiKeyEntry[];
  keysLoading: boolean;
  keysLoadFailed: boolean;
  /** Absent means nothing is attributable yet — different from a counter reading zero. */
  attributionSince?: string;
  localeTag?: string;
  /** A mutation is in flight; its result is bound to one key, so navigation waits. */
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();

  return (
    <div className="panel api-panel awi-keylist-panel" aria-busy={keysLoading}>
      <div className="api-panel-head">
        <h3 className="panel-title">
          {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
        </h3>
      </div>

      {keysLoading ? (
        <div className="api-active-keys-skeleton" role="status" aria-label={t("common.loading")} />
      ) : keys.length === 0 ? (
        // Two different sentences: a catalog we could not read is not an empty one.
        <p className="muted small">{keysLoadFailed ? t("api.keysLoadFailed") : t("api.noKeys")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl awi-keylist-table">
            <thead>
              <tr>
                <th>{t("api.colName")}</th>
                <th>{t("api.colKey")}</th>
                <th>{t("api.attribution.requests7d")}</th>
                <th>{t("api.attribution.lastUsed")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td>
                    {/* A real button, not a clickable row: a `<tr>` with onClick is
                        unreachable by keyboard. */}
                    <button
                      type="button"
                      className="awi-keylist-name"
                      disabled={busy}
                      onClick={() => onSelect(k.id)}
                    >
                      {k.name}
                    </button>
                  </td>
                  <td><code>{k.prefix}</code></td>
                  <td>
                    {!attributionSince
                      ? t("api.attribution.unavailable")
                      : k.usage.ambiguous
                        ? t("api.attribution.railAmbiguous")
                        : k.usage.requests7d.toLocaleString(localeTag)}
                  </td>
                  <td>
                    {!attributionSince || k.usage.ambiguous
                      ? "—"
                      : k.usage.lastUsedAt
                        ? formatCreatedDate(k.usage.lastUsedAt, localeTag)
                        : t("api.attribution.neverUsed")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
