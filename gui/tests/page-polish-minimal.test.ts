import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { interpolate } from "../src/i18n/shared";
import { ko } from "../src/i18n/ko";

const read = (p: string) => readFileSync(join(import.meta.dir, p), "utf8");
const providers = read("../src/components/provider-workspace/ProviderOverviewDashboard.tsx");
const logs = read("../src/pages/Logs.tsx");
const subagents = read("../src/components/subagents-workspace/SubagentsWorkspace.tsx");
const delegation = read("../src/components/subagents-workspace/SubagentDelegationSection.tsx");
const combos = read("../src/components/ComboWorkspace.tsx");
const routing = read("../src/pages/RoutingProfiles.tsx");

/** devlog/_plan/260904_dashboard_minimal/080_page_polish.md — the small items on five pages. */
describe("page polish", () => {
  test("Providers: no overview subtitle; recent-usage folds into a details", () => {
    expect(providers).not.toContain('{t("pws.dashboard.subtitle")}');
    expect(providers).toContain('<details\n          className="pws-dashboard-section pws-dashboard-section--recent"');
    expect(providers).toContain('<summary className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</summary>');
  });

  test("ko: 'checked N ago' no longer doubles 전 when the time is 방금 전", () => {
    const rendered = interpolate(ko["pws.dashboard.checkedAgo"], { time: ko["time.justNow"] });
    expect(rendered).not.toContain("전 전");
    expect(rendered).toBe("방금 전 확인");
  });

  test("Logs: no subtitle paragraph", () => {
    expect(logs).not.toContain('{t("logs.subtitle")}');
  });

  test("Subagents: order hint is a focusable named tooltip; guidance/ultra sit behind a closed details", () => {
    expect(subagents).not.toContain("swi-featured-hint");
    expect(subagents).toContain('<Tooltip content={<Trans k="sub.orderHint" cmd="spawn_agent" />}');
    expect(subagents).toContain('{t("sub.orderHintAria")}');
    const at = delegation.indexOf('<details className="swi-advanced">');
    expect(at).toBeGreaterThan(-1);
    expect(delegation).not.toMatch(/<details className="swi-advanced"[^>]*\bopen\b/);
    const inside = delegation.slice(at, delegation.indexOf("</details>", at));
    expect(inside).toContain('{t("dash.multiAgentGuidance")}');
    expect(inside).toContain('{t("sub.ultraMode")}');
    // The two daily decisions stay above the disclosure.
    expect(delegation.indexOf('{t("sub.delegation.model")}')).toBeLessThan(at);
    expect(delegation.indexOf('{t("dash.syncCodexSubagentDefaults")}')).toBeLessThan(at);
  });

  test("Combos: search renders only when combos exist", () => {
    expect(combos).toContain("{combos.length > 0 && (\n        <div className=\"cwi-search-row\">");
  });

  test("Routing: dry-run only with a draft; analytics only with profiles", () => {
    expect(routing).toContain("{draft && (\n      <div className=\"panel\"");
    expect(routing).toContain("{profiles.length > 0 && (\n      <div className=\"panel\"");
  });
});
