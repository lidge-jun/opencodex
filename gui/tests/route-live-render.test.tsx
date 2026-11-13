import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import { I18nContext, DICTS, interpolate, LOCALES, type Locale, type TFn } from "../src/i18n/shared";
import { ContextCard } from "../src/pages/route-live/ContextCard";
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

const withContext = (extra: Partial<RouteRow> = {}) => ({
  ...failover,
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500 },
  contextWindow: 200_000,
  contextBreakdown: {
    v: 1, toolCount: 3, turns: [100, 250],
    parts: { system: 100, tools: 200, skills: 0, memory: 50, files: 0, results: 300, chat: 350 },
  },
  ...extra,
}) as unknown as RouteRow;

test("context card shows the used/window header, labelled tiles that fill the window, the legend and the cache meter", () => {
  const doc = render(<ContextCard row={withContext()} />);
  expect(doc.querySelector("h4")?.textContent).toMatch(/^上下文用量 .+ \/ .+$/);
  expect(doc.querySelector(".rl-ctx-health")?.textContent).toContain("还很宽裕");
  expect(doc.querySelector(".rl-ctx-badge")).toBeNull();
  const labels = [...doc.querySelectorAll(".rl-ctx-tile")].map(tile => tile.getAttribute("aria-label") ?? "");
  expect(labels.some(label => label.startsWith("系统提示词 "))).toBe(true);
  expect(labels.some(label => label.startsWith("第 2 轮 "))).toBe(true);
  expect(labels.some(label => label.startsWith("剩余空间 "))).toBe(true);
  expect([...doc.querySelectorAll(".rl-ctx-legend li > span:nth-child(2)")].map(s => s.textContent)).toEqual(
    ["系统提示词", "工具", "记忆与 AGENTS.md", "工具结果", "会话内容", "剩余空间"]);
  expect(doc.querySelector(".rl-ctx-cache")?.textContent).toContain("命中 50%");
  expect(doc.querySelector(".rl-ctx-cache")?.textContent).toContain("已缓存");
  expect(doc.querySelector(".rl-ctx-meter")?.getAttribute("aria-valuenow")).toBe("50");
});

test("context card says so when the window is unknown, the sizes are estimated, the cache is unreported or the history is held", () => {
  const bare = withContext({ usage: undefined, contextWindow: undefined });
  const doc = render(<ContextCard row={{ ...bare, contextBreakdown: { ...bare.contextBreakdown!, held: true } }} />);
  expect(doc.querySelector(".rl-ctx-badge")?.textContent).toBe("估算");
  expect(doc.body.textContent).toContain("不知道这个模型的上下文窗口");
  expect(doc.body.textContent).toContain("上文由上游保存，这里看不到");
  expect(doc.querySelector(".rl-ctx-cache")?.textContent).toContain("上游没有报告缓存");
  expect(doc.querySelector(".rl-ctx-meter")).toBeNull();
  expect(doc.body.textContent).not.toContain("命中 0%");
  expect([...doc.querySelectorAll(".rl-ctx-tile")].some(tile => tile.getAttribute("aria-label")?.startsWith("剩余空间"))).toBe(false);
});

test("context card is hidden for a row without a breakdown", () => {
  expect(render(<ContextCard row={failover} />).body.innerHTML).toBe("");
});

test.each(LOCALES)("every reason key the registry points at has copy in $code", ({ code }) => {
  for (const group of Object.values(ROUTE_REASONS)) {
    for (const key of Object.values(group)) expect(DICTS[code][key]?.length).toBeGreaterThan(0);
  }
});
