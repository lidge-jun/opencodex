import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import { installApiAuthFetch } from "./api";

const isTray = window.location.hash.split("?")[0] === "#/tray";
// Entry-point component is mounted here, never imported for fast refresh.
// oxlint-disable-next-line react/only-export-components
const Screen = lazy(() => isTray ? import("./pages/Tray") : import("./App"));
if (isTray) installApiAuthFetch();
import { LanguageProvider } from "./i18n/provider";
import "./styles.css";
import "./styles/usage-chart-accessibility.css";
import "./styles/sidebar-brand.css";
import "./styles/fast-rows-setting.css";
import "./styles/claude-desktop-mode-picker.css";
import "./styles/claude-first-party-bindings.css";
import "./styles/claude-desktop-picker.css";
import "./styles/anthropic-reset-grants.css";
import "./styles/star-onboarding.css";
import "./styles/protocol-evidence.css";
import "./pages/tray.css";
import "./styles/pool-followup.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <Suspense fallback={null}><Screen /></Suspense>
    </LanguageProvider>
  </React.StrictMode>
);
