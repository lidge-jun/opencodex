/* eslint-disable local-i18n/no-hardcoded-ui-strings, react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { Notice } from "../ui";
import { IconInfo } from "../icons";
import { useT } from "../i18n/shared";

export default function Orchestrator({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [available, setAvailable] = useState<string[]>([]);
  const [planner, setPlanner] = useState("root");
  const [executor, setExecutor] = useState("github-copilot/gpt-4.1-mini");
  const [judge, setJudge] = useState("anthropic/claude-opus-5");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // 1. Fetch available models from subagent-models
      const subagentRes = await fetch(`${apiBase}/api/subagent-models`).then(res => res.json());
      setAvailable(subagentRes.available ?? []);

      // 2. Fetch current orchestration settings
      const orchRes = await fetch(`${apiBase}/api/orchestration`).then(res => res.json());
      if (orchRes.planner) setPlanner(orchRes.planner);
      if (orchRes.executor) setExecutor(orchRes.executor);
      if (orchRes.judge) setJudge(orchRes.judge);
    } catch {
      setOk(false);
      setStatus("Falha ao carregar configurações de orquestração.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setStatus("Aplicando orquestração nos bastidores (isso pode levar alguns segundos)...");
    setOk(true);
    try {
      const r = await fetch(`${apiBase}/api/orchestration`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planner, executor, judge }),
      });
      const d = await r.json();
      setOk(r.ok);
      if (r.ok) {
        setStatus("Configurações de orquestração aplicadas e salvas com sucesso!");
      } else {
        setStatus(d.error || "Falha ao aplicar orquestração. Verifique os logs.");
      }
    } catch {
      setOk(false);
      setStatus("Erro de conexão ao salvar orquestração.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("sub.loading")}</div>;

  return (
    <>
      <div className="page-head"><h2>Orquestrador de Modelos</h2></div>
      <p className="page-sub">Configure os modelos e papéis da orquestração principal (planner, executor e juiz).</p>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="card panel-accent" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          
          {/* Planner Selection */}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>Planner (Planejador)</span>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Desenha o plano macro de implementação</span>
            </div>
            <select 
              className="input" 
              value={planner} 
              onChange={e => setPlanner(e.target.value)} 
              disabled={saving}
              style={{ width: 280 }}
            >
              <option value="root">Usar modelo selecionado no Chat (Root)</option>
              {available.map(m => (
                <option key={`planner-${m}`} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Executor Selection */}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>Executor</span>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Escreve o código e executa tarefas (Recomendado modelo barato)</span>
            </div>
            <select 
              className="input" 
              value={executor} 
              onChange={e => setExecutor(e.target.value)} 
              disabled={saving}
              style={{ width: 280 }}
            >
              {available.map(m => (
                <option key={`exec-${m}`} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Judge Selection */}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>Judge (Juiz / Validador)</span>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Valida e atesta se as entregas estão corretas</span>
            </div>
            <select 
              className="input" 
              value={judge} 
              onChange={e => setJudge(e.target.value)} 
              disabled={saving}
              style={{ width: 280 }}
            >
              <option value="none">Nenhum (pular validação do juiz)</option>
              {available.map(m => (
                <option key={`judge-${m}`} value={m}>{m}</option>
              ))}
            </select>
          </div>

        </div>
      </div>

      <div className="row muted text-label leading-body" style={{ alignItems: "flex-start", gap: 8, margin: "10px 0 20px", maxWidth: "80ch" }}>
        <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>Salvar esta configuração invocará o script de configuração de rotas do plugin codex-orchestration em segundo plano.</span>
      </div>

      <div>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Salvando..." : "Salvar Configuração de Orquestração"}
        </button>
      </div>
    </>
  );
}
