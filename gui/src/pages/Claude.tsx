import { useState } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import { useT } from "../i18n";

type ClaudeTab = "code" | "desktop";

export default function Claude({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<ClaudeTab>("code");
  const t = useT();

  return (
    <section className="claude-page">
      <div className="claude-tabs" role="tablist" aria-label={t("claude.tabsLabel")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "code"}
          aria-controls="claude-code-panel"
          id="claude-code-tab"
          className={tab === "code" ? "active" : ""}
          onClick={() => setTab("code")}
        >
          {t("claude.tabCode")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "desktop"}
          aria-controls="claude-desktop-panel"
          id="claude-desktop-tab"
          className={tab === "desktop" ? "active" : ""}
          onClick={() => setTab("desktop")}
        >
          {t("claude.tabDesktop")}
        </button>
      </div>

      <div
        id="claude-code-panel"
        role="tabpanel"
        aria-labelledby="claude-code-tab"
        hidden={tab !== "code"}
      >
        {tab === "code" && <ClaudeCode apiBase={apiBase} />}
      </div>
      <div
        id="claude-desktop-panel"
        role="tabpanel"
        aria-labelledby="claude-desktop-tab"
        hidden={tab !== "desktop"}
      >
        {tab === "desktop" && <ClaudeDesktop apiBase={apiBase} />}
      </div>
    </section>
  );
}
