import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StrategySeg } from "../src/components/combo-workspace-controls";
import type { ComboStrategy } from "../src/combo-workspace-data";
import { DICTS, I18nContext, LOCALES, interpolate, type Locale, type TFn } from "../src/i18n/shared";
import "../src/design/theme.css";

const requested = new URLSearchParams(location.search).get("locale");
document.documentElement.dataset.locales = JSON.stringify(LOCALES.map(entry => entry.code));
const locale: Locale = LOCALES.find(entry => entry.code === requested)?.code ?? "en";
document.documentElement.lang = LOCALES.find(entry => entry.code === locale)!.htmlLang;
const t: TFn = (key, vars) => interpolate(DICTS[locale][key], vars);

export function Fixture() {
  const [strategy, setStrategy] = useState<ComboStrategy>("failover");
  return <I18nContext.Provider value={{ locale, setLocale: () => {}, t }}>
    <main style={{ padding: 24 }}><h1>Strategy geometry</h1>
      <div className="cwi-form-grid" style={{ width: "calc(100% - 200px)" }}><div className="cwi-field"><StrategySeg value={strategy} onChange={setStrategy} /></div></div>
      <div id="models-panel-combos" style={{ width: 180 }}>
        <div className="combos-workspace-rail-header">
          <div className="combos-workspace-rail-heading"><div className="combos-workspace-rail-title">{t("nav.combos")}</div><div className="combos-workspace-rail-count">0</div></div>
          <button type="button" className="btn btn-primary btn-sm" style={{ fontSize: 20 }}>{t("cws.add")}</button>
        </div>
      </div>
    </main>
  </I18nContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
