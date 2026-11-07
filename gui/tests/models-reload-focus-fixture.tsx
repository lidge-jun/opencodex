import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import "../src/design/theme.css";

export function Fixture() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const refresh = () => setEpoch(value => value + 1);
    window.addEventListener("fixture-refresh", refresh);
    return () => window.removeEventListener("fixture-refresh", refresh);
  }, []);
  return <LanguageProvider><button id="other" type="button">Other action</button>
    <Models apiBase="" restartEpoch={epoch} reportRestart={() => {}} /></LanguageProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
