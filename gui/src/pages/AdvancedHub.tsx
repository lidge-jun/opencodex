import { useDeferredValue, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useT, type TKey } from "../i18n/shared";
import type { Page } from "../app-routing";
import { IconActivity, IconBot, IconClaude, IconCodex, IconHardDrive, IconList, IconSearch, IconServer, IconShuffle, IconStar, IconTerminal } from "../icons";
import { HubCard } from "@/components/ui-v2/hub-card";

/*
 * The "Fine-tuning" tier: every advanced surface as one searchable grid. A card names the
 * setting in plain words, keeps the original term underneath, says when you would change
 * it, and opens the page that owns it. Nothing is configured here.
 */

interface AdvancedHubProps {
  navigate: (page: Page, subPath?: string) => void;
}

interface Entry {
  id: string;
  title: TKey;
  when: TKey;
  /** Product term used in docs and the CLI; a proper noun, so it is not translated. */
  term: string;
  Icon: typeof IconBot;
  page: Page;
  subPath?: string;
  /** Labels of the settings this page holds, so a search for one of them finds its card. */
  finds?: readonly TKey[];
  /** Untranslated product words people type in any language (sidecar, fallback, …). */
  words?: readonly string[];
}

const ENTRIES: readonly Entry[] = [
  { id: "subagents", title: "shellV2.advSubagents", when: "shellV2.advSubagentsWhen", term: "Subagents", Icon: IconBot, page: "subagents",
    finds: ["dash.injectionLabel", "dash.multiAgent"], words: ["delegation", "agents"] },
  { id: "advisor", title: "shellV2.advAdvisor", when: "shellV2.advAdvisorWhen", term: "Advisor", Icon: IconStar, page: "advisor",
    finds: ["nav.advisor", "advisor.policy", "proxyV2.consentTitle"], words: ["consult", "preflight"] },
  { id: "proxy", title: "shellV2.advProxy", when: "shellV2.advProxyWhen", term: "Sidecars · Compaction · Memory", Icon: IconActivity, page: "dashboard",
    finds: [
      "dash.webSearchSidecar", "dash.visionSidecar", "dash.shadowCallIntercept", "compactionRouting.title",
      "memoryModels.title", "fallback.title", "dash.syncModels", "dash.codexAutoStart", "dash.codexDesktopAuthless",
      "dash.effortCapLabel", "nativeReasoningRetention.title", "reasoningRetention.title", "dash.checkUpdate",
    ],
    words: ["web search", "vision", "shadow", "fallback", "reasoning", "update", "sync"] },
  { id: "routing", title: "shellV2.advRouting", when: "shellV2.advRoutingWhen", term: "Routing profiles · Compatibility", Icon: IconShuffle, page: "models", subPath: "routing" },
  { id: "prompt", title: "shellV2.advPrompt", when: "shellV2.advPromptWhen", term: "Prompt layers", Icon: IconTerminal, page: "codex-set", subPath: "prompt" },
  { id: "claude", title: "shellV2.advClaude", when: "shellV2.advClaudeWhen", term: "Claude Code", Icon: IconClaude, page: "claude", subPath: "code" },
  { id: "providers", title: "shellV2.advProviders", when: "shellV2.advProvidersWhen", term: "Request pacing · Key rotation", Icon: IconServer, page: "providers" },
  { id: "storage", title: "shellV2.advStorage", when: "shellV2.advStorageWhen", term: "Storage · Log Guard", Icon: IconHardDrive, page: "storage" },
  { id: "diagnostics", title: "shellV2.advDiagnostics", when: "shellV2.advDiagnosticsWhen", term: "Debug", Icon: IconList, page: "logs", subPath: "debug" },
  { id: "desktop", title: "shellV2.advDesktopCompat", when: "shellV2.advDesktopCompatWhen", term: "Desktop compatibility", Icon: IconCodex, page: "codex-set", subPath: "desktop" },
];

export default function AdvancedHub({ navigate }: AdvancedHubProps) {
  const t = useT();
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const shown = ENTRIES.filter(entry => !needle
    || [t(entry.title), t(entry.when), entry.term, ...(entry.finds ?? []).map(key => t(key)), ...(entry.words ?? [])]
      .some(text => text.toLowerCase().includes(needle)));

  return (
    <div className="ui-v2 flex flex-col gap-6 font-sans text-fg">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{t("shellV2.pageAllSettings")}</h1>
          <p className="m-0 text-[15px] text-fg-muted">{t("shellV2.advancedIntro")}</p>
        </div>
        <label className="relative flex w-full items-center sm:w-72">
          <span className="pointer-events-none absolute left-3 text-fg-subtle [&_svg]:size-4"><IconSearch aria-hidden /></span>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("shellV2.advancedSearch")}
            aria-label={t("shellV2.advancedSearch")}
            className="h-[var(--ocx-control-h)] w-full rounded-control bg-surface pr-3 pl-9 text-sm text-fg ring-1 ring-line outline-none ring-inset placeholder:text-fg-subtle focus:ring-2 focus:ring-highlight"
          />
        </label>
      </header>
      {needle && (
        <p className="m-0 -mt-3 text-[13px] text-fg-muted" role="status">{t("proxyV2.hubCount", { count: shown.length })}</p>
      )}
      {shown.length === 0 ? (
        <p className="m-0 rounded-card bg-surface p-6 text-center text-[14px] text-fg-muted">{t("shellV2.advancedEmpty")}</p>
      ) : (
        <motion.div layout={!reduce} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map(entry => (
              <motion.div key={entry.id} layout={!reduce}
                initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                exit={reduce ? {} : { opacity: 0, scale: 0.97 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
                <HubCard
                  icon={<entry.Icon aria-hidden />}
                  title={t(entry.title)}
                  term={entry.term}
                  body={<><b className="font-medium text-fg">{t("shellV2.advancedWhen")}</b> · {t(entry.when)}</>}
                  onOpen={() => navigate(entry.page, entry.subPath)}
                  openLabel={t("shellV2.stepOpen")}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
