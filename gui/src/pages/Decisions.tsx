import { useCallback, useState } from "react";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { readJsonOrThrow } from "../fetch-json";
import { Notice, EmptyState } from "../ui";
import { useT, type TKey } from "../i18n/shared";
import { IconRefresh } from "../icons";

/**
 * Decision destinations.
 *
 * One list for everything the JEV Combo strategy can decide through: the hosted decision services
 * (TypeSafe, OpenCode's zen gateway) and a self-hosted endpoint on this machine or the LAN. The
 * strategy resolves which row it calls from config — the row named `jev` first, otherwise the first
 * enabled row that resolves a credential — so this page mirrors that rule and marks the row that is
 * actually in use.
 *
 * Below the destinations sits the capability check and the bounded job catalog of the
 * `Sun-Season/jev-codex` skill, whose modes are what a destination has to be able to serve:
 * calibrated `choice` answers everywhere, plus `score` for search ranking.
 */

interface ProviderRow {
  name: string;
  adapter: string;
  baseUrl: string;
  hasApiKey?: boolean;
  disabled?: boolean;
}

interface PresetRow {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
}

type DecisionPayload = { providers: ProviderRow[]; presets: PresetRow[] };

type KindSupport = { supported: boolean; reason?: string; confidence?: number };
type ContractResult = {
  ok: boolean;
  gate?: string;
  latencyMs?: number;
  providerId?: string | null;
  model?: string | null;
  answeredBy?: string;
  kinds?: Record<string, KindSupport>;
  error?: string;
};

/**
 * The bounded decision jobs of the `Sun-Season/jev-codex` skill, mirrored so operators can see what
 * a destination is expected to serve. Question kinds and budgets are the skill's own defaults
 * (`choice` throughout, `score` where ranking needs a scale; 12 calls / 25s for the browser loop,
 * 1 call / 15s for the single-request data modes).
 */
const DECISION_MODES: Array<{ id: string; tkey: TKey; kinds: string; budget: string }> = [
  { id: "browser", tkey: "dec.modeBrowser", kinds: "choice", budget: "≤12 / ≤25s" },
  { id: "context", tkey: "dec.modeContext", kinds: "choice", budget: "1 / ≤15s" },
  { id: "search", tkey: "dec.modeSearch", kinds: "choice + score", budget: "1 / ≤15s" },
  { id: "supervisor", tkey: "dec.modeSupervisor", kinds: "choice", budget: "1 / ≤15s" },
  { id: "review", tkey: "dec.modeReview", kinds: "choice", budget: "1 / ≤15s" },
];

const DECISION_ADAPTER = "jev-decision";
const SKILL_URL = "https://github.com/Sun-Season/jev-codex";
/** Loopback or RFC1918 host: a decision service running on this machine or the local network. */
const LOCAL_ENDPOINT = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|$)/i;

const isLocal = (baseUrl: string) => LOCAL_ENDPOINT.test(baseUrl ?? "");

/** Mirrors `resolveJevDecisionDestination`: the `jev` row first, else an enabled row with a key. */
function activeDecisionRow(rows: ProviderRow[]): string | undefined {
  const decision = rows.filter(row => row.adapter === DECISION_ADAPTER);
  const preferred = decision.find(row => row.name === "jev");
  if (preferred && preferred.disabled !== true) return preferred.name;
  return decision.find(row => row.disabled !== true && row.hasApiKey === true)?.name;
}

const kindLabel = (kind: string, support: KindSupport | undefined) => {
  if (!support) return `${kind} ?`;
  if (!support.supported) return `${kind} ✗${support.reason ? ` (${support.reason})` : ""}`;
  const confidence = typeof support.confidence === "number" ? ` ${support.confidence.toFixed(2)}` : "";
  return `${kind} ✓${confidence}`;
};

export default function Decisions({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<{ kind: "connect" | "contract"; name: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<DecisionPayload> => {
    const [providersRes, presetsRes] = await Promise.all([
      fetch(`${apiBase}/api/providers`, { signal }),
      fetch(`${apiBase}/api/provider-presets`, { signal }),
    ]);
    const providers = await readJsonOrThrow<ProviderRow[]>(providersRes, t("dec.loadFail"));
    const presetPayload = await readJsonOrThrow<{ providers?: PresetRow[] }>(presetsRes, t("dec.loadFail"));
    return { providers: providers ?? [], presets: presetPayload?.providers ?? [] };
  }, [apiBase, t]);

  const resource = useDataSurface<DecisionPayload>(
    `ocx.decisions.v1:${apiBase}`,
    [apiBase],
    load,
    {
      isEmpty: data => data.providers.filter(row => row.adapter === DECISION_ADAPTER).length === 0,
      staleAfterMs: 30_000,
    },
  );

  const probe = async (name: string) => {
    setBusy({ kind: "connect", name });
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/test?name=${encodeURIComponent(name)}`, { method: "POST" });
      const data = await readJsonOrThrow<{ ok?: boolean; message?: string; error?: string; applicable?: boolean }>(res, t("dec.probeFail"));
      setNotice({
        tone: data?.ok === true ? "ok" : "err",
        text: data?.message ?? data?.error ?? (data?.applicable === false ? t("dec.probeSkipped") : t("dec.probeFail")),
      });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error && error.message ? error.message : t("dec.probeFail") });
    } finally {
      setBusy(null);
    }
  };

  const contract = async (name: string) => {
    setBusy({ kind: "contract", name });
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/decision-probe?name=${encodeURIComponent(name)}`, { method: "POST" });
      const data = await readJsonOrThrow<ContractResult>(res, t("dec.probeFail"));
      const kinds = data?.kinds ?? {};
      const parts = ["choice", "score"].map(kind => kindLabel(kind, kinds[kind]));
      const latency = typeof data?.latencyMs === "number"
        ? ` · ${t("dec.latencySeconds", { seconds: (data.latencyMs / 1000).toFixed(1) })}`
        : "";
      const answered = data?.answeredBy ? ` · ${data.answeredBy}` : "";
      setNotice({
        tone: data?.ok === true ? "ok" : "err",
        text: `${name}: ${parts.join(" · ")}${latency}${answered}`,
      });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error && error.message ? error.message : t("dec.probeFail") });
    } finally {
      setBusy(null);
    }
  };

  if (resource.state.showSkeleton) return <DataSurfaceSkeleton label={t("common.loading")} rows={3} />;

  const providers = resource.data?.providers ?? [];
  const presets = resource.data?.presets ?? [];
  const decisionRows = providers.filter(row => row.adapter === DECISION_ADAPTER);
  const presetsById = new Map(presets.map(preset => [preset.id, preset]));
  const configured = new Set(providers.map(row => row.name));
  const addable = presets.filter(preset => preset.adapter === DECISION_ADAPTER && !configured.has(preset.id));
  const active = activeDecisionRow(providers);

  const statusCell = (row: ProviderRow) => {
    if (row.disabled === true) return <span className="badge badge-disabled">{t("dec.disabled")}</span>;
    if (row.hasApiKey !== true) return <span className="badge badge-amber">{t("dec.keyMissing")}</span>;
    return <span className="badge">{t("dec.keySet")}</span>;
  };

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.decisions")}</h2>
        <div className="page-head-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>
            <IconRefresh /> {t("dec.refresh")}
          </button>
        </div>
      </div>
      <p className="muted">{t("dec.subtitle")}</p>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {resource.state.showError && <Notice tone="err">{t("dec.loadFail")}</Notice>}

      <div className="h-section">{t("dec.configured")} <span className="count">{decisionRows.length}</span></div>
      {decisionRows.length === 0 ? (
        <EmptyState title={t("dec.empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("dash.col.name")}</th>
                <th>{t("dec.colKind")}</th>
                <th>{t("dash.col.baseUrl")}</th>
                <th>{t("dec.colStatus")}</th>
                <th>{t("dash.col.model")}</th>
                <th>{t("dec.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {decisionRows.map(row => (
                <tr key={row.name}>
                  <td className="font-semibold">
                    {presetsById.get(row.name)?.label ?? row.name}
                    {row.name === active && <span className="badge badge-green" style={{ marginLeft: 8 }}>{t("dec.active")}</span>}
                  </td>
                  <td>
                    <span className="chip">{isLocal(row.baseUrl) ? t("dec.kindLocal") : t("dec.kindRemote")}</span>
                  </td>
                  <td className="muted mono text-label">{row.baseUrl}</td>
                  <td>{statusCell(row)}</td>
                  <td className="muted">{presetsById.get(row.name)?.defaultModel ?? "—"}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void probe(row.name)} disabled={busy?.kind === "connect" && busy.name === row.name}>
                      {busy?.kind === "connect" && busy.name === row.name ? t("dec.probing") : t("dec.probe")}
                    </button>{" "}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void contract(row.name)} disabled={busy?.kind === "contract" && busy.name === row.name}>
                      {busy?.kind === "contract" && busy.name === row.name ? t("dec.contractProbing") : t("dec.contractProbe")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addable.length > 0 && (
        <>
          <div className="h-section">{t("dec.available")} <span className="count">{addable.length}</span></div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("dash.col.name")}</th>
                  <th>{t("dec.colKind")}</th>
                  <th>{t("dash.col.baseUrl")}</th>
                  <th>{t("dash.col.model")}</th>
                </tr>
              </thead>
              <tbody>
                {addable.map(preset => (
                  <tr key={preset.id}>
                    <td className="font-semibold">{preset.label}</td>
                    <td>
                      <span className="chip">{isLocal(preset.baseUrl) ? t("dec.kindLocal") : t("dec.kindRemote")}</span>
                    </td>
                    <td className="muted mono text-label">{preset.baseUrl}</td>
                    <td className="muted">{preset.defaultModel ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{t("dec.addHint")}</p>
        </>
      )}

      <div className="h-section">{t("dec.capTitle")} <span className="count">{DECISION_MODES.length}</span></div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("dec.colMode")}</th>
              <th>{t("dec.colDelegates")}</th>
              <th>{t("dec.colKinds")}</th>
              <th>{t("dec.colBudget")}</th>
            </tr>
          </thead>
          <tbody>
            {DECISION_MODES.map(mode => (
              <tr key={mode.id}>
                <td className="mono text-label">{mode.id}</td>
                <td>{t(mode.tkey)}</td>
                <td className="muted mono text-label">{mode.kinds}</td>
                <td className="muted mono text-label">{mode.budget}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {t("dec.capSource")} <a href={SKILL_URL} target="_blank" rel="noreferrer">{SKILL_URL}</a>
      </p>
    </>
  );
}
