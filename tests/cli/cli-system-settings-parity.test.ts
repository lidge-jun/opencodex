import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleSystemCommand } from "../../src/cli/system-command";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let token: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-system-parity-"); token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {}); errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
type Call = { method: string; path: string; body: Record<string, unknown> | null };
function fixture(reply: (call: Call) => unknown = call => ({ ok: true, ...call.body, catalogRefreshPending: false })) {
  const calls: Call[] = []; let resolutions = 0;
  const deps: RuntimeApiDeps = { findLiveProxy: async () => ({ pid: null, port: 15100 + ++resolutions, source: "runtime" }),
    fetchImpl: async (input, init) => {
      expect(new URL(String(input)).port).toBe("15101"); expect(init?.redirect).toBe("error");
      const call = { method: init?.method ?? "GET", path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call); const body = reply(call); return body instanceof Response ? body : Response.json(body);
    } };
  return { calls, deps, resolutions: () => resolutions };
}
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));

describe("new system settings use exact fields and observed results", () => {
  for (const [flag, field] of Object.entries({ "--show-codex-credits": "showCodexCredits", "--account-picker": "codexAccountPickerEnabled",
    "--main-account-hard-lock": "codexMainAccountHardLock", "--fast-rows": "fastRows" })) {
    test.each([true, false])(`${flag} preserves the explicit boolean`, async enabled => {
      const f = fixture(call => ({ ok: true, ...call.body, catalogRefreshPending: false, startupHealth: { private: "fixture-private-value" } }));
      expect(await handleSystemCommand(["settings", flag, enabled ? "on" : "off", "--json"], f.deps)).toBe(0);
      expect(f.calls).toEqual([{ method: "PUT", path: "/api/settings", body: { [field]: enabled } }]);
      expect(f.resolutions()).toBe(1);
      expect(json()).toEqual({ ok: true, settings: { [field]: enabled }, catalogRefreshPending: false });
      expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
    });
  }
  test.each([true, false])("ultra Fast reads its actual state back from the same target", async enabled => {
    const f = fixture(call => call.method === "PUT" ? { ok: true, catalogRefreshPending: false } : { ultraFastTier: enabled });
    expect(await handleSystemCommand(["settings", "--ultra-fast-tier", enabled ? "on" : "off", "--json"], f.deps)).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["PUT", "GET"]); expect(f.resolutions()).toBe(1);
    expect(json().settings).toEqual({ ultraFastTier: enabled });
  });
  test.each([{}, { ultraFastTier: false }, Response.json({ error: "fixture-private-value" }, { status: 503 })])("accepted ultra Fast without confirming evidence stays unverified", async readBack => {
    const f = fixture(call => call.method === "PUT" ? { ok: true, catalogRefreshPending: false } : readBack);
    expect(await handleSystemCommand(["settings", "--ultra-fast-tier", "on", "--json"], f.deps)).toBe(1);
    expect(json().verification).toBe("unverified"); expect(json().unverifiedFields).toEqual(["ultraFastTier"]);
    expect(f.calls).toHaveLength(2); expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
  test("pending and missing pending are not successful application", async () => {
    for (const pending of [true, undefined]) {
      output.mockClear();
      const f = fixture(call => ({ ok: true, ...call.body, ...(pending === undefined ? {} : { catalogRefreshPending: pending }) }));
      expect(await handleSystemCommand(["settings", "--account-picker", "off", "--json"], f.deps)).toBe(1);
      expect(json().settings.codexAccountPickerEnabled).toBe(false);
      expect(json().catalogRefreshPending).toBe(pending === undefined ? null : true);
    }
  });
  test("mixed native switches preserve stored/effective and deferred apply without private detail", async () => {
    const f = fixture(call => ({ ok: true, ...call.body, catalogRefreshPending: false,
      codexDesktopSwitches: { codexDesktopAuthless: { stored: true, effective: null },
        apply: { applied: false, reason: "ownership_undetermined", retryable: false, detail: "fixture-private-value" } } }));
    expect(await handleSystemCommand(["settings", "--show-codex-credits", "on", "--desktop-authless", "on", "--json"], f.deps)).toBe(1);
    expect(f.calls[0]?.body).toEqual({ showCodexCredits: true, codexDesktopAuthless: true });
    expect(json().desktop.codexDesktopAuthless).toEqual({ stored: true, effective: null });
    expect(json().desktop.apply).not.toHaveProperty("detail");
    expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
  test.each([
    ["--fast-rows", "on", "--fast-rows", "off"], ["--show-codex-credits", "fixture-private-value"],
    ["--main-account-hard-lock", "off", "--unknown", "fixture-private-value"],
    ["--account-picker", "off", "--stream-mode", "fixture-private-value"],
  ])("invalid options refuse before discovery", async (...args) => {
    const f = fixture(); expect(await handleSystemCommand(["settings", ...args, "--json"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
});
