import { useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import CodexSetMultiauth from "./codex-set-multiauth";
import CodexSetPrompt from "./codex-set-prompt";
import CodexDesktopCompatibility from "./codex-desktop-compatibility";
import { codexSetTabKeyDown, readCodexSetTabFromHash, selectCodexSetTab } from "./codex-set-tab";

/**
 * Codex Set — the page that configures Codex as a whole, not just its accounts.
 *
 * Exclusive tabpanels shaped like Logs/Debug rather than the scrolling
 * SectionTabs strip: Multi-auth and Prompt are unrelated surfaces, and Multi-auth
 * polls /api/codex-auth/* on a 30s timer that has no business running while the
 * user is editing prompts. Prompt lazy-mounts on first visit and stays mounted
 * afterwards, so hopping between tabs does not refetch either side.
 */
export default function CodexSet({ apiBase, machineApiBase = apiBase, connected = false }: { apiBase: string; machineApiBase?: string; connected?: boolean }) {
  const t = useT();
  const [tab, setTab] = useState(readCodexSetTabFromHash);
  const [promptMounted, setPromptMounted] = useState(() => readCodexSetTabFromHash() === "prompt");
  // Multi-auth lazy-mounts too. It used to mount unconditionally, which meant a
  // direct visit to #codex-set/prompt still started its /api/config fetch and 30s
  // account poll behind a hidden panel - exactly the cost this shell was shaped to
  // avoid. Both panels now mount on first selection and stay mounted after.
  const [multiauthMounted, setMultiauthMounted] = useState(() => readCodexSetTabFromHash() === "multiauth");
  const [desktopMounted, setDesktopMounted] = useState(() => readCodexSetTabFromHash() === "desktop");

  useEffect(() => {
    const onHash = () => setTab(readCodexSetTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Latch during render, not in an effect. Setting state from a prop/state change
  // costs an extra render pass and is what React Compiler flags; the latch is
  // pure - it only ever goes false -> true - so computing it here is both
  // cheaper and the same value.
  const showPrompt = promptMounted || tab === "prompt";
  const showMultiauth = multiauthMounted || tab === "multiauth";
  if (showPrompt !== promptMounted) setPromptMounted(true);
  if (showMultiauth !== multiauthMounted) setMultiauthMounted(true);
  const showDesktop = desktopMounted || tab === "desktop";
  if (showDesktop !== desktopMounted) setDesktopMounted(true);

  return (
    <>
      <div className="page-tabs" role="tablist" aria-label={t("nav.codexSet")}>
        <button
          type="button"
          role="tab"
          id="codex-set-tab-multiauth"
          aria-selected={tab === "multiauth"}
          aria-controls="codex-set-panel-multiauth"
          tabIndex={tab === "multiauth" ? 0 : -1}
          className={`page-tab${tab === "multiauth" ? " page-tab--active" : ""}`}
          onClick={() => selectCodexSetTab("multiauth")}
          onKeyDown={codexSetTabKeyDown}
        >
          {t("codexSet.tab.multiauth")}
        </button>
        <button
          type="button"
          role="tab"
          id="codex-set-tab-prompt"
          aria-selected={tab === "prompt"}
          aria-controls="codex-set-panel-prompt"
          tabIndex={tab === "prompt" ? 0 : -1}
          className={`page-tab${tab === "prompt" ? " page-tab--active" : ""}`}
          onClick={() => selectCodexSetTab("prompt")}
          onKeyDown={codexSetTabKeyDown}
        >
          {t("codexSet.tab.prompt")}
        </button>
        <button type="button" role="tab" id="codex-set-tab-desktop" aria-selected={tab === "desktop"}
          aria-controls="codex-set-panel-desktop" tabIndex={tab === "desktop" ? 0 : -1}
          className={`page-tab${tab === "desktop" ? " page-tab--active" : ""}`}
          onClick={() => selectCodexSetTab("desktop")} onKeyDown={codexSetTabKeyDown}>{t("desktopCompat.title")}</button>
      </div>

      {showPrompt && (
        <div
          role="tabpanel"
          id="codex-set-panel-prompt"
          aria-labelledby="codex-set-tab-prompt"
          hidden={tab !== "prompt"}
        >
          <CodexSetPrompt apiBase={apiBase} />
        </div>
      )}

      {showMultiauth && (
        <div
          role="tabpanel"
          id="codex-set-panel-multiauth"
          aria-labelledby="codex-set-tab-multiauth"
          hidden={tab !== "multiauth"}
        >
          <CodexSetMultiauth apiBase={apiBase} />
        </div>
      )}
      {showDesktop && <div role="tabpanel" id="codex-set-panel-desktop" aria-labelledby="codex-set-tab-desktop" hidden={tab !== "desktop"}>
        <CodexDesktopCompatibility apiBase={machineApiBase} active={tab === "desktop"} connected={connected} />
      </div>}
    </>
  );
}
