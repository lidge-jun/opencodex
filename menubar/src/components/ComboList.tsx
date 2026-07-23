import { useState } from "react";

export interface ComboInfo {
  id: string;
  model: string;
  targets?: { provider: string; model: string }[];
}

interface ComboListProps {
  combos: ComboInfo[];
  onSwitch: (comboId: string) => void;
  stale: boolean;
}

export function ComboList({ combos, onSwitch, stale }: ComboListProps) {
  const [selected, setSelected] = useState("");

  const handleSwitch = (id: string) => {
    setSelected(id);
    onSwitch(id);
  };

  return (
    <div className="section">
      <div className="section-title">
        Active Combos {stale && <span className="stale-badge">stale</span>}
      </div>
      {combos.length === 0 && (
        <div style={{ color: "#888", fontSize: 11 }}>No combos configured</div>
      )}
      {combos.map((combo) => (
        <div key={combo.id} className="combo-item">
          <span className="combo-name">{combo.id}</span>
          <span className="combo-target">{combo.model}</span>
        </div>
      ))}
      {combos.length > 0 && (
        <select
          className="combo-select"
          value={selected}
          onChange={(e) => handleSwitch(e.target.value)}
        >
          <option value="">Switch combo…</option>
          {combos.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
