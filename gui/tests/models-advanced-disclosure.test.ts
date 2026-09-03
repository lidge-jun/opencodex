import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const models = readFileSync(join(import.meta.dir, "../src/pages/Models.tsx"), "utf8");
const delegation = readFileSync(join(import.meta.dir, "../src/components/subagents-workspace/SubagentDelegationSection.tsx"), "utf8");
const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/**
 * devlog/_plan/260904_dashboard_minimal/030_models_catalog.md: the catalog's control wall
 * (new-model policy, aliases, shadow-call, context cap, plus the v1/base/v2 switch and the
 * order-hint paragraph) collapses to one closed disclosure; the switch itself moves to the
 * Subagents delegation section, which already owned the /api/v2 read and write; each
 * provider's rarely-used header actions fold into a ⋯ disclosure.
 */
describe("Models catalog advanced disclosure", () => {
  test("the controls block renders inside a closed details, before the collapse controls", () => {
    const at = models.indexOf('<details className="models-advanced">');
    expect(at).toBeGreaterThan(-1);
    expect(models.slice(at, at + 400)).toContain("{controlsBlock}");
    expect(models.indexOf("{collapseControls}")).toBeGreaterThan(at);
    // Closed by default: no `open` attribute on the element.
    expect(models).not.toMatch(/<details className="models-advanced"[^>]*\bopen\b/);
  });

  test("the v1/base/v2 radiogroup left Models and lives in the Subagents delegation section", () => {
    expect(models).not.toContain("models-v2-mode-row");
    expect(models).not.toContain("const setMultiAgentMode");
    expect(models).not.toContain("v2HelpOpen");
    expect(delegation).toContain('role="radiogroup" aria-label={t("models.v2Label")}');
    expect(delegation).toContain("onUltraModeSave({ multiAgentMode: mode })");
    // The long help text is reachable from a focusable Tooltip, not a modal.
    expect(delegation).toContain('content={t("models.v2Help")}');
  });

  test("the subtitle and order hint became focusable tooltips with accessible names", () => {
    expect(models).not.toContain("models-order-hint");
    expect(models).toContain('content={t("models.subtitle")}');
    expect(models).toContain('{t("models.subtitleAria")}');
    expect(models).toContain('content={t("models.orderHint")}');
    expect(models).toContain('{t("models.orderHintAria")}');
    // Non-catalog subtitles only in the empty state.
    expect(models).toContain('{tab !== "catalog" && tabIsEmpty && <p className="page-sub">');
  });

  test("the page head no longer carries a third restart button", () => {
    const head = models.slice(models.indexOf('className="page-head"'), models.indexOf("<CodexStaleBanner"));
    expect(head).not.toContain("handleCodexRestart");
  });
});

describe("Models provider header ⋯ disclosure", () => {
  test("edit and all-on/all-off stay inline; aliases, custom model, presets and cap fold into the details", () => {
    const at = models.indexOf('<div className="row models-provider-actions">');
    const more = models.indexOf('<details className="models-group-more">', at);
    expect(more).toBeGreaterThan(at);
    const inline = models.slice(at, more);
    expect(inline).toContain("models-alias-edit");
    expect(inline).toContain('{t("models.allOn")}');
    expect(inline).toContain('{t("models.allOff")}');
    const folded = models.slice(more, models.indexOf("</details>", more));
    expect(folded).toContain('label={t("models.useDefaultAliases")}');
    expect(folded).toContain('{t("models.customAdd")}');
    expect(folded).toContain('aria-label={t("models.presetLabel")}');
    expect(folded).toContain("models-cap-cluster");
    // Labelled disclosure, never a menu role.
    expect(folded).toContain('aria-label={t("models.groupMore")}');
    expect(folded).not.toContain('role="menu"');
  });

  test("both disclosures have summary styling that hides the native marker", () => {
    expect(css).toContain(".models-advanced > summary::-webkit-details-marker { display: none; }");
    expect(css).toContain(".models-group-more > summary::-webkit-details-marker { display: none; }");
  });
});
