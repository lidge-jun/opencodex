import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { CodexAccountPoolCards } from "../src/components/codex-account-pool-cards";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { I18nContext, DICTS, interpolate, LOCALES, type Locale, type TFn } from "../src/i18n/shared";
import { formatAccountPauseTooltip } from "../src/account-pause-display";
import { ACCOUNT_PAUSE_REASONS } from "../../src/types/account-auto-pause";

const details = { reason: "subscription_expired", pausedAt: Date.UTC(2026, 0, 15, 13, 42) };
const translator = (locale: Locale): TFn => (key, vars) => interpolate(DICTS[locale][key], vars);
const handlers = {
  onLogin() {}, onLogout() {}, onReauth() {}, onSwitchAccount() {}, onPauseAccount() {},
  onRemoveAccount() {}, onAddApiKey: async () => true, onSwitchApiKey() {}, onRemoveApiKey() {}, onEditAlias() {},
} satisfies ProviderAuthHandlers;

function render(node: ReactNode, locale: Locale) {
  const win = new Window();
  win.document.body.innerHTML = renderToStaticMarkup(
    <I18nContext.Provider value={{ locale, setLocale() {}, t: translator(locale) }}>{node}</I18nContext.Provider>,
  );
  return win;
}

test.each(LOCALES)("all pause reasons and partial-success copy exist in $code", ({ code }) => {
  const t = translator(code);
  for (const reason of ACCOUNT_PAUSE_REASONS) {
    const text = formatAccountPauseTooltip(t, code, { ...details, reason });
    expect(text).toContain(new Date(details.pausedAt).toLocaleString(code));
    expect(text).not.toContain(reason);
    expect(text).not.toStartWith(`${t("codexAuth.paused")} ·`);
  }
  expect(DICTS[code]["prov.keyResumedSwitchFailed"].length).toBeGreaterThan(20);
});

test.each(["fr", "ko"] as const)("provider OAuth and key tooltips use the app locale %s", locale => {
  const t = translator(locale);
  const expected = `${t("accountPause.reason.subscriptionExpired")} · ${new Date(details.pausedAt).toLocaleString(locale)}`;
  for (const authMode of ["oauth", "key"] as const) {
    const item = { name: "fixture", authMode, adapter: "openai", hasApiKey: authMode === "key" } as WorkspaceItem;
    const win = render(<ProviderAuthPanel item={item} apiBase="" oauth={{ loggedIn: true }} authHandlers={handlers}
      accounts={[{ id: "account-fixture", alias: "Reserve account", active: false, paused: true, pauseDetails: details }]}
      keys={[{ id: "key-fixture", label: "Reserve key", masked: "****", active: false, disabled: true, pauseDetails: details }]} />, locale);
    try {
      expect(win.document.querySelector(".badge-muted[title]")?.getAttribute("title")).toBe(expected);
      if (authMode === "key") {
        expect(win.document.querySelector(".pwi-auth-row-main")?.getAttribute("aria-label"))
          .toBe(`${t("codexAuth.resume")} — Reserve key`);
      }
    } finally { void win.happyDOM.close(); }
  }
});

test("Codex tooltip shares the translated reason and app locale date", () => {
  const locale = "fr";
  const t = translator(locale);
  const noop = () => {};
  const win = render(<CodexAccountPoolCards
    pool={[{ id: "fixture", email: "fixture@example.test", isMain: false, paused: true, pauseDetails: details,
      priority: 0, autoSwitchThresholdOverride: null, hasCredential: true, quota: null }]}
    activeId={null} accountModeState={null} switchActionLabel="Switch" threshold={0}
    onOpenReset={noop} onSwitch={noop} onTogglePause={noop} pauseUpdatingId={null} pauseBusy={false}
    onPriorityChange={noop} priorityUpdatingId={null} onAutoSwitchThresholdChange={async () => true}
    autoSwitchDisabled={false} switchingId={null} onUnpin={noop} onReauth={noop} onEditAlias={noop} onRemove={noop}
  />, locale);
  try {
    expect(win.document.querySelector(".badge-muted[title]")?.getAttribute("title"))
      .toBe(`${t("accountPause.reason.subscriptionExpired")} · ${new Date(details.pausedAt).toLocaleString(locale)}`);
  } finally { void win.happyDOM.close(); }
});

test("unknown display reasons use a translated pause label", () => {
  expect(formatAccountPauseTooltip(translator("ko"), "ko", { reason: "future_reason", pausedAt: NaN }))
    .toBe(DICTS.ko["codexAuth.paused"]);
});
