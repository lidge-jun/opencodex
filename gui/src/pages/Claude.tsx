import { useRef, useState, type KeyboardEvent } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import { useT } from "../i18n";

type ClaudeTab = "code" | "desktop";

export default function Claude({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<ClaudeTab>("code");
  const t = useT();
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const desktopTabRef = useRef<HTMLButtonElement>(null);

  const selectTab = (next: ClaudeTab) => {
    setTab(next);
    window.requestAnimationFrame(() => (next === "code" ? codeTabRef : desktopTabRef).current?.focus());
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "code" ? "desktop" : "code");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("code");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("desktop");
    }
  };

  return (
    <section className="claude-page">
      <div className="claude-tabs" role="tablist" aria-label={t("claude.tabsLabel")}>
        <button
          type="button"
          role="tab"
          ref={codeTabRef}
          aria-selected={tab === "code"}
          aria-controls="claude-code-panel"
          id="claude-code-tab"
          className={tab === "code" ? "active" : ""}
          tabIndex={tab === "code" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("code")}
        >
          {t("claude.tabCode")}
        </button>
        <button
          type="button"
          role="tab"
          ref={desktopTabRef}
          aria-selected={tab === "desktop"}
          aria-controls="claude-desktop-panel"
          id="claude-desktop-tab"
          className={tab === "desktop" ? "active" : ""}
          tabIndex={tab === "desktop" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("desktop")}
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
