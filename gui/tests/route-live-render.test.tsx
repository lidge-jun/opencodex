import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import { I18nContext, DICTS, interpolate, LOCALES, type Locale, type TFn } from "../src/i18n/shared";
import { FlowDiagram } from "../src/pages/route-live/FlowDiagram";
import { RequestList } from "../src/pages/route-live/RequestList";
import { RouteSteps } from "../src/pages/route-live/RouteSteps";
import { buildRouteFlow } from "../src/pages/route-live/flow-model";
import { ROUTE_REASONS } from "../src/pages/route-live/route-reasons";
import type { RouteRow } from "../src/pages/route-live/route-rows";

const translator = (locale: Locale): TFn => (key, vars) => interpolate(DICTS[locale][key], vars);

function render(node: ReactNode, locale: Locale = "zh") {
  const win = new Window();
  win.document.body.innerHTML = renderToStaticMarkup(
    <I18nContext.Provider value={{ locale, setLocale() {}, t: translator(locale) }}>{node}</I18nContext.Provider>,
  );
  return win.document;
}

const failover = {
  timestamp: 1_700_000_000_000, requestId: "r1", model: "gemini-3.8-flash", provider: "google-antigravity", status: 200, durationMs: 2400,
  firstOutputMs: 900, effectiveEffort: "high", requestedEffort: "medium", accountLogLabel: "obbbbbb", conversationId: "session-12345678",
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500 },
  attempts: [
    { provider: "google-antigravity", model: "gemini-3.8-flash", status: 429, errorCode: "rate_limit_exceeded", accountLogLabel: "oaaaaaa" },
    { provider: "google-antigravity", model: "gemini-3.8-flash", status: 200, accountLogLabel: "obbbbbb", durationMs: 1800 },
  ],
  routeDecision: { routeKind: "combo", selected: { reason: "some-future-reason" }, candidates: [] },
  accountRoster: { provider: "google-antigravity", accounts: [
    { label: "oaaaaaa", state: "cooldown" }, { label: "obbbbbb", state: "available" },
    { label: "occcccc", state: "needs-reauth" }, { label: "oddddd0", state: "weird-state" },
  ] },
} as unknown as RouteRow;

test("flow marks the answered account, the failed try with its reason, and a skipped account with its reason", () => {
  const flow = buildRouteFlow(failover, { "google-antigravity": { obbbbbb: "工作号" } });
  const doc = render(<FlowDiagram flow={flow} />);
  const answered = doc.querySelector(".rl-cand--answered");
  expect(answered?.textContent).toContain("工作号");
  expect(answered?.textContent).toContain("已回答");
  const failed = doc.querySelector(".rl-cand--failed");
  expect(failed?.textContent).toContain("429");
  expect(failed?.textContent).toContain("限流");
  const skipped = doc.querySelector(".rl-cand--skipped");
  expect(skipped?.textContent).toContain("需要重新登录");
});

test("steps show an unknown reason code raw, in <code>, instead of dropping it", () => {
  const flow = buildRouteFlow(failover);
  const doc = render(<RouteSteps row={failover} flow={flow} />);
  expect(doc.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
  expect([...doc.querySelectorAll("code")].map(c => c.textContent)).toContain("some-future-reason");
});

test("request list groups by session, shows dashes for unknown metrics, and marks the pinned row", () => {
  const sparse = { timestamp: 1_700_000_100_000, model: "m", provider: "p", status: 500, durationMs: 50 } as unknown as RouteRow;
  const list = (mode: "request" | "session") => render(
    <RequestList rows={[sparse, failover]} pinnedKey="r1" onPin={() => {}} mode={mode} onMode={() => {}} names={{}} />,
  );
  const flat = list("request");
  expect(flat.querySelectorAll("button.rl-row").length).toBe(2);
  expect(flat.querySelector(".rl-row--pinned")?.getAttribute("aria-pressed")).toBe("true");
  expect(flat.querySelectorAll("button.rl-row")[0]!.textContent).toContain("—");
  expect(flat.querySelector(".rl-bad")?.textContent).toBe("500");
  const grouped = list("session");
  expect(grouped.querySelectorAll(".rl-group-head").length).toBe(2);
  expect(grouped.querySelector(".rl-group-head")?.getAttribute("aria-expanded")).toBe("true");
});

test.each(LOCALES)("every reason key the registry points at has copy in $code", ({ code }) => {
  for (const group of Object.values(ROUTE_REASONS)) {
    for (const key of Object.values(group)) expect(DICTS[code][key]?.length).toBeGreaterThan(0);
  }
});
