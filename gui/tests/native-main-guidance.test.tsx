import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeMainProfilesView } from "../src/components/native-main-profiles-view";
import { nativeMainTranslator } from "../src/i18n/native-main-copy";
import { NativeMainProfileSession } from "../src/native-main-profile-session";
import type { NativeMainErrorCode } from "../src/native-main-profiles";

const home = "/srv/fixture/.codex";
const a = { id: "profile-a", label: "Example A", identityHint: "native:11111111" };
const b = { id: "profile-b", label: "Example B", identityHint: "native:22222222" };
const action = { kind: "switch" as const, target: b.id, label: b.label };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture() {
  let active = a.id;
  let failure: NativeMainErrorCode | null = null;
  let restartRequired = false;
  let loseResponse = false;
  let accountRefresh: () => unknown | Promise<unknown> = () => true;
  const calls: { method: string; body?: unknown }[] = [];
  const session = new NativeMainProfileSession("/fixture", undefined, async (_input, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") {
      if (failure) return json({ code: failure, message: "private-server-detail" }, 409);
      active = JSON.parse(String(init.body)).target;
      if (loseResponse) throw new Error("private-server-detail");
      return json({ ok: true, effectiveCodexHome: home,
        activeProfile: { ...(active === a.id ? a : b), state: "active" }, restartRequired });
    }
    return json(String(_input).endsWith("/doctor")
      ? { effectiveCodexHome: home, activeProfileId: active, supported: true,
        authStatus: "ok", keyStore: "available", vaultStatus: "ok", recoveryPending: false }
      : { effectiveCodexHome: home, activeProfileId: active,
        profiles: [a, b].map(p => ({ ...p, state: p.id === active ? "active" : "inactive" })) });
  });
  session.updateOptions(false, () => accountRefresh());
  const stop = session.attach(() => {});
  const window = new Window();
  const render = (locale: "en" | "de" = "en") => {
    const t = nativeMainTranslator(locale);
    window.document.body.innerHTML = renderToStaticMarkup(<NativeMainProfilesView t={t} id="fixture"
      {...session.state} previousId={session.state.previous?.id ?? null}
      onToggle={() => {}} onRefresh={() => {}} onLabel={() => {}} onRegister={() => {}}
      onSelect={() => {}} onStopped={() => {}} onConfirm={() => {}} />);
    return window.document.body;
  };
  return { session, render, calls, failure: (code: NativeMainErrorCode | null) => { failure = code; },
    restart: (value: boolean) => { restartRequired = value; },
    loseResponse: () => { loseResponse = true; },
    accountRefresh: (callback: typeof accountRefresh) => { accountRefresh = callback; },
    async close() { stop(); await window.happyDOM.close(); } };
}

test("CODEX_BUSY guides a status read and fresh stopped confirmation, without replaying the write", async () => {
  const f = fixture();
  try {
    await f.session.toggle(); f.session.select(action); f.session.setStopped(true);
    f.failure("CODEX_BUSY"); await f.session.confirm();
    const alert = f.render().querySelector('[role="alert"]')!;
    expect(alert.classList.contains("native-main-notice")).toBe(true);
    expect(alert.textContent).toContain("Close it for the displayed CODEX_HOME");
    expect(alert.textContent).toContain("Refresh the status and review the active profile");
    expect(alert.textContent).toContain("select the action again and confirm that Codex is closed");
    expect(alert.textContent).not.toContain("private-server-detail");
    expect(f.session.state.snapshot?.doctor.activeProfileId).toBe(a.id);
    expect(f.session.state.confirmedStopped).toBe(false);
    const afterRefusal = f.calls.length;
    await f.session.refresh();
    expect(f.calls.slice(afterRefusal).every(call => call.method === "GET")).toBe(true);
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    f.failure(null); f.session.select(action);
    expect(f.render().querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
    await f.session.confirm();
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    f.session.setStopped(true); await f.session.confirm();
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(f.session.state.snapshot?.doctor.activeProfileId).toBe(b.id);
  } finally { await f.close(); }
});

test("confirmation presents close, checkbox and result steps in English and German", async () => {
  const f = fixture();
  try {
    await f.session.toggle(); f.session.select(action);
    for (const locale of ["en", "de"] as const) {
      const t = nativeMainTranslator(locale);
      const panel = f.render(locale).querySelector('[role="group"]')!;
      expect([...panel.querySelectorAll("ol li")].map(item => item.textContent)).toEqual([
        t("nativeMain.stepClose"), t("nativeMain.stepConfirm"), t("nativeMain.stepResult"),
      ]);
      const steps = panel.querySelector("ol")!;
      const checkbox = panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const confirm = panel.querySelector<HTMLButtonElement>('.btn-primary')!;
      expect(steps.compareDocumentPosition(checkbox) & 4).toBe(4);
      expect(checkbox.compareDocumentPosition(confirm) & 4).toBe(4);
      expect(checkbox.checked).toBe(false);
      expect(confirm.disabled).toBe(true);
    }
  } finally { await f.close(); }
});

test("success instructions wait for existing account refresh, for both restart outcomes", async () => {
  for (const restart of [false, true]) {
    const f = fixture();
    try {
      let finish!: (value: boolean) => void;
      let entered!: () => void;
      const pendingRefresh = new Promise<boolean>(resolve => { finish = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      f.accountRefresh(() => { entered(); return pendingRefresh; });
      f.restart(restart);
      await f.session.toggle(); f.session.select(action); f.session.setStopped(true);
      const change = f.session.confirm(); await started;
      expect(f.session.state.snapshot?.doctor.activeProfileId).toBe(b.id);
      expect(f.render().textContent).not.toContain(nativeMainTranslator("en")("nativeMain.reopenHint"));
      finish(true); await change;
      expect(f.render().textContent).toContain(nativeMainTranslator("en")(restart ? "nativeMain.restart" : "nativeMain.done"));
      expect(f.render().textContent).toContain(nativeMainTranslator("en")("nativeMain.reopenHint"));
      expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    } finally { await f.close(); }
  }
});

test("failed account refresh shows completed outcome but withholds reopen advice until refreshed", async () => {
  const f = fixture();
  try {
    f.restart(true); f.accountRefresh(() => false);
    await f.session.toggle(); f.session.select(action); f.session.setStopped(true); await f.session.confirm();
    const t = nativeMainTranslator("en");
    expect(f.render().textContent).toContain(t("nativeMain.restart"));
    expect(f.render().textContent).toContain(t("nativeMain.refreshFailed"));
    expect(f.render().textContent).not.toContain(t("nativeMain.reopenHint"));
    f.accountRefresh(() => true); await f.session.refresh();
    expect(f.render().textContent).toContain(t("nativeMain.reopenHint"));
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  } finally { await f.close(); }
});

test("a new confirmation does not show the previous change's reopen instruction", async () => {
  const f = fixture();
  try {
    f.restart(true);
    await f.session.toggle(); f.session.select(action); f.session.setStopped(true); await f.session.confirm();
    const t = nativeMainTranslator("en");
    expect(f.render().textContent).toContain(t("nativeMain.reopenHint"));
    f.session.select({ kind: "switch", target: a.id, label: a.label });
    expect(f.render().querySelector('[role="group"]')).not.toBeNull();
    expect(f.render().textContent).toContain(t("nativeMain.stepClose"));
    expect(f.render().textContent).not.toContain(t("nativeMain.reopenHint"));
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  } finally { await f.close(); }
});

test("a retained restart result is labelled as last confirmed after an uncertain later attempt", async () => {
  const f = fixture();
  try {
    f.restart(true);
    await f.session.toggle(); f.session.select(action); f.session.setStopped(true); await f.session.confirm();
    f.loseResponse();
    f.session.select({ kind: "switch", target: a.id, label: a.label });
    f.session.setStopped(true); await f.session.confirm();
    expect(f.session.state.error).toBe("NETWORK_ERROR");
    expect(f.render().textContent).not.toContain(nativeMainTranslator("en")("nativeMain.reopenHint"));
    await f.session.refresh();
    // Existing refresh clears the error but preserves a previous restart requirement.
    // It is a readback, not confirmation of the lost-response transaction.
    expect(f.session.state.error).toBeNull();
    expect(f.session.state.snapshot?.doctor.activeProfileId).toBe(a.id);
    expect(f.render().querySelector('[role="status"] strong')?.textContent).toBe("Last confirmed result");
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
  } finally { await f.close(); }
});

test("process uncertainty, running operations, storage and rollback have distinct retry guidance", async () => {
  const f = fixture();
  try {
    await f.session.toggle();
    for (const [code, phrase] of [
      ["CODEX_PROCESS_CHECK_UNAVAILABLE", "could not verify whether native Codex is running"],
      ["MAIN_REQUESTS_ACTIVE", "Wait for them to finish"],
      ["SWITCH_ROLLED_BACK", "original login was restored"],
      ["NETWORK_ERROR", "A missing response does not mean the original login was restored"],
      ["NATIVE_PROFILE_BUSY", "Another native-login operation is running"],
      ["PROFILE_STORAGE_UNSAFE", "The server cannot safely access the login folder or profile storage"],
    ] as const) {
      f.failure(code); f.session.select(action); f.session.setStopped(true); await f.session.confirm();
      const alert = f.render().querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain(phrase);
      expect(alert.textContent).toContain("To retry a login change, select the action again and confirm that Codex is closed.");
      expect(alert.textContent).toContain("Nothing is retried automatically.");
      expect(alert.classList.contains("native-main-notice")).toBe(true);
      expect(f.render().textContent).not.toContain(nativeMainTranslator("en")("nativeMain.reopenHint"));
    }
  } finally { await f.close(); }
});
