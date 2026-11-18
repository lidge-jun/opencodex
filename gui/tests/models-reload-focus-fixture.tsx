import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import { ModelsReloadFocusBoundary } from "../src/pages/models-reload-focus-boundary";
import "../src/design/theme.css";

export function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [probeStale, setProbeStale] = useState(false);
  const headRef = useRef<HTMLButtonElement>(null), bannerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const refresh = () => setEpoch(value => value + 1);
    const blurBeforeCommit = () => { setProbeStale(true); headRef.current?.blur(); };
    window.addEventListener("fixture-refresh", refresh);
    window.addEventListener("fixture-blur-before-commit", blurBeforeCommit);
    return () => { window.removeEventListener("fixture-refresh", refresh); window.removeEventListener("fixture-blur-before-commit", blurBeforeCommit); };
  }, []);
  return <LanguageProvider><button id="other" type="button">Other action</button>
    <ModelsReloadFocusBoundary stale={probeStale} headRef={headRef} bannerRef={bannerRef}>
      {probeStale ? <button ref={bannerRef} id="probe-banner">Banner</button> : <button ref={headRef} id="probe-head">Head</button>}
    </ModelsReloadFocusBoundary>
    <Models apiBase="" restartEpoch={epoch} reportRestart={() => {}} /></LanguageProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
