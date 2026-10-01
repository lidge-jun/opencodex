import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeMainProfilesView, type NativeMainProfilesViewProps } from "../src/components/native-main-profiles-view";
import { nativeMainTranslator } from "../src/i18n/native-main-copy";

const home = `/srv/${"long-home-segment/".repeat(12)}.codex`;
const profile = { id: "00000000-0000-4000-8000-000000000001", label: "example-profile", identityHint: "native:11111111", state: "inactive" as const };
const noop = () => {};
const props: NativeMainProfilesViewProps = {
  t: nativeMainTranslator("de"), id: "fixture", open: true, busy: false, blocked: false,
  snapshot: {
    list: { effectiveCodexHome: home, activeProfileId: null, profiles: [profile] },
    doctor: { effectiveCodexHome: home, activeProfileId: null, supported: true,
      authStatus: "ok", keyStore: "available", vaultStatus: "ok", recoveryPending: false },
  },
  label: "", action: { kind: "switch", target: profile.id, label: profile.label },
  confirmedStopped: false, previousId: null, error: null, result: null, refreshFailed: false,
  onToggle: noop, onRefresh: noop, onLabel: noop, onRegister: noop, onSelect: noop,
  onStopped: noop, onConfirm: noop,
};
const css = (await Bun.file(new URL("../src/styles.css", import.meta.url)).text()).replace(/^@import .*;$/gm, "");

test("native confirmation overrides the shared horizontal notice and permits wrapped actions", async () => {
  const window = new Window();
  try {
    window.document.head.innerHTML = `<style>${css}</style>`;
    window.document.body.innerHTML = renderToStaticMarkup(<NativeMainProfilesView {...props} />);
    const panel = window.document.querySelector<HTMLElement>('[role="group"]')!;
    // happy-dom checks the cascade, not browser geometry. Inherited notice flex
    // previously put heading, prose, path, consent and actions in one narrow row.
    expect(window.getComputedStyle(panel).display).toBe("block");
    expect(panel.querySelector("code")?.textContent).toBe(home);
    expect(window.getComputedStyle(panel.querySelector(".row")!).flexWrap).toBe("wrap");
    for (const button of panel.querySelectorAll<HTMLButtonElement>("button")) {
      const style = window.getComputedStyle(button);
      expect(style.whiteSpace).toBe("normal");
      expect(style.maxWidth).toBe("100%");
      expect(style.overflowWrap).toBe("anywhere");
    }
    expect(panel.querySelector<HTMLButtonElement>(".btn-primary")!.disabled).toBe(true);
  } finally {
    await window.happyDOM.close();
  }
});
