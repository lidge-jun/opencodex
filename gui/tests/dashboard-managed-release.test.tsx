import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { interpolate } from "../src/i18n/shared";
import { DashboardDialogs } from "../src/pages/dashboard-dialogs";
import type { UpdateCheckData } from "../src/pages/dashboard-shared";

const managed: UpdateCheckData = {
  currentVersion: "2.95.0", latestVersion: "2.96.0", channel: "latest", installer: "source",
  command: "", reason: "managed_release", updateAvailable: true, canUpdate: false,
  releaseNotesUrl: "",
};

function renderCheck(updateCheck: UpdateCheckData, document: Window["document"]) {
  const state = {
    t: (key, vars) => interpolate(en[key], vars),
    updateOpen: true,
    updateChannel: "latest",
    updateCheck,
  } satisfies Pick<Parameters<typeof DashboardDialogs>[0], "t" | "updateOpen" | "updateChannel" | "updateCheck">;
  document.body.innerHTML = renderToStaticMarkup(
    <LanguageProvider><DashboardDialogs {...state as Parameters<typeof DashboardDialogs>[0]} /></LanguageProvider>,
  );
  return document.querySelector("#dashboard-update-dialog")!;
}

test("the managed-release dialog explains host updates and keeps installing disabled", () => {
  const win = new Window();
  try {
    const dialog = renderCheck(managed, win.document);
    expect(dialog.textContent).toContain(en["dash.updateManaged"]);
    expect(dialog.textContent).toContain(en["dash.updateAvailable"]);
    expect(dialog.textContent).not.toContain(en["dash.updateDesc"]);
    expect(dialog.textContent).not.toContain(en["dash.updateSource"]);
    expect(dialog.textContent).not.toContain(en["dash.updateRecheck"]);
    expect(dialog.querySelector(".modal-actions button.btn-primary[disabled]")).not.toBeNull();
  } finally {
    win.close();
  }
});

test("an unknown managed-release version offers retry without claiming it is current", () => {
  const win = new Window();
  try {
    const dialog = renderCheck({
      ...managed, latestVersion: null, reason: "latest_unavailable", updateAvailable: false,
    }, win.document);
    expect(dialog.textContent).toContain(en["dash.updateUnavailable"]);
    expect(dialog.textContent).not.toContain(en["dash.updateCurrent"]);
    const retry = Array.from(dialog.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === en["dash.updateRetry"]);
    expect(retry?.disabled).toBe(false);
    expect(dialog.querySelector(".modal-actions button.btn-primary[disabled]")).not.toBeNull();
  } finally {
    win.close();
  }
});
