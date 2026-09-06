import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nContext, type TFn } from "../src/i18n/shared";
import RaycastPlanNotice from "../src/pages/integrations/RaycastPlanNotice";
import type { RaycastInstall } from "../src/pages/integrations/integration-api";

/*
 * Raycast reads providers.yaml only on a Pro plan and only from a folder it
 * creates itself, so a `current` badge can be a lie. The notice is the one place
 * that lie is corrected, and each of its three lines answers a different
 * question; a regression that drops one leaves the page green and silent.
 */

const echoT: TFn = key => key;

function render(install: RaycastInstall): string {
  return renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { locale: "en", setLocale: () => {}, t: echoT } },
      createElement(RaycastPlanNotice, { install }),
    ),
  );
}

test("a Pro install with the ai folder renders nothing", () => {
  expect(render({ plan: "pro", appPath: "/Applications/Raycast.app", aiDirPresent: true })).toBe("");
});

test("a free plan is a warning notice, never a refusal", () => {
  const markup = render({ plan: "free", appPath: "/Applications/Raycast.app", aiDirPresent: true });
  expect(markup).toContain("notice-warn");
  expect(markup).toContain("integrations.raycast.proRequired");
  expect(markup).not.toContain("notice-err");
  expect(markup).not.toContain("integrations.raycast.planUnknown");
});

test("an unreadable plan stays muted, because non-macOS hosts have no signal", () => {
  const markup = render({ plan: "unknown", appPath: null, aiDirPresent: true });
  expect(markup).toContain('data-raycast-plan="unknown"');
  expect(markup).toContain("integrations.raycast.planUnknown");
  expect(markup).not.toContain("notice-warn");
});

test("a missing ai folder adds the reveal hint independently of the plan", () => {
  const markup = render({ plan: "free", appPath: "/Applications/Raycast.app", aiDirPresent: false });
  expect(markup).toContain("integrations.raycast.proRequired");
  expect(markup).toContain('data-raycast-ai-dir="absent"');
  expect(markup).toContain("integrations.raycast.revealConfig");
});
