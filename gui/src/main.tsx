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
// Design system v2 entry: tokens, Tailwind utilities, and every legacy stylesheet in a lower
// `legacy` cascade layer, so migrated components win and unmigrated pages look unchanged.
import "./design/theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <Suspense fallback={null}><Screen /></Suspense>
    </LanguageProvider>
  </React.StrictMode>
);
