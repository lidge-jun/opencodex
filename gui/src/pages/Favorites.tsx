/* eslint-disable local-i18n/no-hardcoded-ui-strings, react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice, EmptyState } from "../ui";
import { IconGrip, IconArrowUp, IconArrowDown, IconX, IconCheck, IconSearch, IconBot, IconInfo } from "../icons";
import { useT } from "../i18n/shared";

export default function Favorites({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [available, setAvailable] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);

  // Extract all unique providers from available models for filtering
  const providers = useMemo(() => {
    const set = new Set<string>();
    available.forEach(m => {
      const parts = m.split("/");
      if (parts.length > 1) {
        set.add(parts[0]);
      }
    });
    return ["all", ...Array.from(set).sort()];
  }, [available]);

  const load = useCallback(async () => {
    try {
      const subagentRes = await fetch(`${apiBase}/api/subagent-models`).then(res => res.json());
      const avail: string[] = subagentRes.available ?? [];
      const availSet = new Set(avail);
      setAvailable(avail);

      const favRes = await fetch(`${apiBase}/api/favorites`).then(res => res.json());
      setChosen((favRes.models ?? []).filter((m: string) => availSet.has(m)));
    } catch {
      setOk(false);
      setStatus("Falha ao carregar os favoritos.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (m: string) => {
    setStatus("");
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  };

  const move = (i: number, dir: -1 | 1) => {
    setChosen(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= chosen.length || to >= chosen.length) return;
    setChosen(prev => {
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved!);
      return copy;
    });
  };

  const save = async () => {
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/favorites`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await r.json();
      setOk(r.ok);
      setStatus(r.ok
        ? `Favoritos salvos com sucesso (${d.models?.length ?? 0} modelo(s)).`
        : (d.error || "Falha ao salvar favoritos."));
    } catch {
      setOk(false);
      setStatus("Erro de conexão ao salvar favoritos.");
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => {
      // 1. Text filter
      const matchesText = !q || m.toLowerCase().includes(q);
      
      // 2. Provider filter
      const parts = m.split("/");
      const provider = parts.length > 1 ? parts[0] : "";
      const matchesProvider = selectedProvider === "all" || provider === selectedProvider;

      return matchesText && matchesProvider;
    });
  }, [available, query, selectedProvider]);

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("sub.loading")}</div>;

  return (
    <>
      <div className="page-head"><h2>Modelos Favoritos</h2></div>
      <p className="page-sub">Lista ilimitada para prioridade no picker. Só modelos que também estão em Subagents entram no top-5 do spawn_agent; o resto é só atalho de UI.</p>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      {/* Selected Favorites Area */}
      <div className="h-section">Favoritos Selecionados <span className="count">{chosen.length}</span></div>
      <div className="row muted text-label leading-body" style={{ alignItems: "flex-start", gap: 8, margin: "-2px 0 14px", maxWidth: "80ch" }}>
        <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>Prioridade no picker apenas. Para baratear subagents, coloque os modelos baratos em Subagents — Favoritos fora dessa lista não entram no spawn_agent.</span>
      </div>

      {chosen.length === 0 ? (
        <EmptyState title="Nenhum favorito selecionado" />
      ) : (
        <div className="stack" style={{ gap: 8, marginBottom: 20 }}>
          {chosen.map((m, i) => {
            const parts = m.split("/");
            const provider = parts.length > 1 ? parts[0] : "";
            const name = parts.length > 1 ? parts.slice(1).join("/") : m;
            const dragging = dragIndex === i;
            const dropTarget = overIndex === i && dragIndex !== null && dragIndex !== i;

            return (
              <div
                key={m}
                className="card panel-accent row"
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null) reorder(dragIndex, i);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                style={{
                  padding: "10px 16px",
                  gap: 12,
                  borderRadius: 10,
                  border: dropTarget ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: dragging ? "rgba(var(--accent-rgb), 0.15)" : "rgba(255,255,255,0.02)",
                  opacity: dragging ? 0.5 : 1,
                  transition: "border 0.15s ease, background 0.15s ease",
                }}
              >
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  draggable
                  aria-label="Arrastar para reordenar"
                  title="Arrastar para reordenar"
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(i));
                  }}
                  style={{ cursor: "grab", padding: 4 }}
                >
                  <IconGrip width={16} height={16} aria-hidden="true" style={{ color: "var(--faint)" }} />
                </button>
                <span className="mono font-bold" style={{ width: 22, color: "var(--accent)", fontSize: "1rem" }}>{i + 1}</span>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 2 }}>
                  <code className="mono" style={{ color: "var(--text)", fontWeight: 650, fontSize: "0.95rem" }}>{name}</code>
                  {provider && <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--accent)" }}>{provider}</span>}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, -1)} disabled={i === 0} style={{ padding: 6 }}>
                    <IconArrowUp />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, 1)} disabled={i === chosen.length - 1} style={{ padding: 6 }}>
                    <IconArrowDown />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => toggle(m)} style={{ color: "var(--red)", padding: 6 }}>
                    <IconX />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 14, marginBottom: 32 }}>
        <button type="button" className="btn btn-primary" onClick={save} style={{ padding: "10px 24px", borderRadius: 8 }}>
          Salvar Favoritos
        </button>
      </div>

      {/* Available Models & Filtering Area */}
      <div className="h-section">Todos os Modelos Disponíveis <span className="count">{filtered.length}</span></div>
      
      {/* Search Input */}
      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
        <IconSearch width={15} height={15} aria-hidden="true" style={{ color: "var(--faint)", flexShrink: 0 }} />
        <input
          className="input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Pesquisar por nome do modelo..."
          style={{ flex: 1, borderRadius: 8, padding: "10px 14px" }}
        />
      </div>

      {/* Provider Filter Tabs/Pills */}
      <div className="row" style={{ gap: 6, marginBottom: 16, flexWrap: "wrap", overflowX: "auto", paddingBottom: 4 }}>
        {providers.map(p => (
          <button
            key={`filter-${p}`}
            type="button"
            className={`btn btn-sm ${selectedProvider === p ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setSelectedProvider(p)}
            style={{
              padding: "4px 12px",
              borderRadius: "999px",
              fontSize: "0.8rem",
              textTransform: p === "all" ? "capitalize" : "none",
              border: selectedProvider === p ? "none" : "1px solid var(--border)",
              background: selectedProvider === p ? "var(--accent)" : "transparent"
            }}
          >
            {p === "all" ? "Todos" : p}
          </button>
        ))}
      </div>

      {/* Models List Grid */}
      <div className="stack" style={{ gap: 6, maxHeight: 400, overflowY: "auto", paddingRight: 4 }}>
        {filtered.map(m => {
          const sel = chosenSet.has(m);
          const parts = m.split("/");
          const provider = parts.length > 1 ? parts[0] : "";
          const name = parts.length > 1 ? parts.slice(1).join("/") : m;

          return (
            <button
              key={m}
              type="button"
              className={`card row${sel ? " panel-accent" : ""}`}
              onClick={() => toggle(m)}
              style={{
                width: "100%",
                cursor: "pointer",
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                textAlign: "left",
                justifyContent: "space-between",
                background: sel ? "rgba(var(--accent-rgb), 0.08)" : "transparent"
              }}
            >
              <div className="row" style={{ gap: 10, flex: 1 }}>
                <span style={{ width: 16, height: 16, flexShrink: 0, color: "var(--accent)", display: "inline-flex", alignItems: "center" }}>
                  {sel && <IconCheck style={{ width: 16, height: 16 }} />}
                </span>
                <IconBot style={{ width: 15, height: 15, color: "var(--faint)", flexShrink: 0 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <code className="mono" style={{ color: "var(--text)", fontSize: "0.9rem" }}>{name}</code>
                  {provider && <span style={{ fontSize: "0.7rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.02em" }}>{provider}</span>}
                </div>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <EmptyState title={t("sub.noModels")} />
        )}
      </div>
    </>
  );
}
