import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import { I18nContext, DICTS, interpolate, LOCALES, type Locale, type TFn } from "../src/i18n/shared";
import { FlowDiagram } from "../src/pages/route-live/FlowDiagram";
import { RequestList } from "../src/pages/route-live/RequestList";
import { RouteSteps } from "../src/pages/route-live/RouteSteps";
import { TimeSection } from "../src/pages/route-live/TimeBar";
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

test("time bar lists each measured stage in order with its label, or a note when nothing was recorded", () => {
  const [first, last] = failover.attempts!;
  const timed = {
    ...failover, upstreamSendMs: 1010, privacyRedactionMs: 5, firstOutputMs: 1710,
    attempts: [{ ...first!, durationMs: 1000 }, { ...last!, firstOutputMs: 700 }],
  } as unknown as RouteRow;
  const doc = render(<TimeSection row={timed} />);
  expect(doc.querySelector("h4")?.textContent).toBe("时间花在哪里");
  expect([...doc.querySelectorAll(".rl-time-legend li > span:nth-child(2)")].map(s => s.textContent)).toEqual(
    ["隐私脱敏", "OpenCodex 内部", "之前的尝试", "等上游第一个字", "流式输出"]);
  expect(doc.querySelectorAll(".rl-time-seg").length).toBe(5);
  const bare = render(<TimeSection row={{ timestamp: 1, model: "m", provider: "p", status: 200, durationMs: 50 } as unknown as RouteRow} />);
  expect(bare.querySelector(".rl-time-bar")).toBeNull();
  expect(bare.querySelector("p")?.textContent).toContain("没有记录时间分布");
});

test.each(LOCALES)("every reason key the registry points at has copy in $code", ({ code }) => {
  for (const group of Object.values(ROUTE_REASONS)) {
    for (const key of Object.values(group)) expect(DICTS[code][key]?.length).toBeGreaterThan(0);
  }
});
