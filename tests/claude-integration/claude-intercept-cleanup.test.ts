import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Server } from "bun";
import type { OcxConfig } from "../../src/types";
import * as paths from "../../src/config/paths";
import * as desktop from "../../src/claude/desktop-first-party";
import * as pickerCa from "../../src/claude/intercept/picker-ca";
import * as runtime from "../../src/claude/intercept/runtime";
import { createClaudeInterceptLifecycle } from "../../src/server/index/claude-intercept-lifecycle";

// All effects are mocked: no key files, certificate trust, or sockets are used by this suite.
const owners: Array<ReturnType<typeof createClaudeInterceptLifecycle>> = [];
afterEach(async () => {
  try { for (const owner of owners.splice(0)) await owner.stop(); }
  finally { mock.restore(); }
});

function fixture() {
  const events: string[] = [];
  const discard = spyOn(pickerCa, "discardPickerCaKey").mockImplementation(() => { events.push("cleanup"); });
  const observe = spyOn(desktop, "observeClaudeDesktopMode").mockImplementation(() => {
    events.push("observe"); return {};
  });
  const handle: runtime.ClaudeInterceptHandle = {
    listener: {} as Server<undefined>, proxyPort: 10200, caCertPath: "synthetic-ca.pem",
    pickerProxyPort: null, stop: mock(async () => {}),
  };
  const start = spyOn(runtime, "startClaudeIntercept").mockImplementation(async () => {
    events.push("start"); return handle;
  });
  const configDir = spyOn(paths, "getConfigDir").mockReturnValue("synthetic-default-home");
  spyOn(console, "log").mockImplementation(() => {});
  const lifecycle = createClaudeInterceptLifecycle();
  owners.push(lifecycle);
  const config = { port: 10100, providers: {}, claudeCode: { enabled: true } } as OcxConfig;
  const options: runtime.StartClaudeInterceptOptions<undefined> = {
    config, publicPort: 10100, configDir: "synthetic-explicit-home", dispatch: mock(async () => new Response()),
    loadPickerRoutes: mock(async () => ({ nativeSlugs: [], routedModels: [] })),
  };
  return { events, discard, observe, handle, start, configDir, lifecycle, options };
}

const skipped = [
  ["client role", "client_role", { runtimeRole: "client" }],
  ["disabled routing", "disabled", { claudeCode: { enabled: false } }],
  ["disabled interception", "disabled", { claudeCode: { enabled: true, intercept: { enabled: false } } }],
  ["ephemeral public port", "ephemeral_port", {}],
] as const;

for (const [name, reason, config] of skipped) {
  for (const fails of [false, true]) {
    test(`legacy cleanup precedes ${name}, including cleanup failure=${fails}`, async () => {
      const f = fixture();
      Object.assign(f.options.config, config);
      if (reason === "ephemeral_port") f.options.requestedPort = 0;
      if (fails) f.discard.mockImplementation(() => { f.events.push("cleanup"); throw new Error("synthetic cleanup failure"); });
      f.lifecycle.start(f.options);
      // start remains synchronous and cleanup must happen before any eligibility return.
      expect(f.events).toEqual(["cleanup"]);
      expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason });
      expect(f.lifecycle.lastOutcome()).toEqual({ ok: false, reason });
      expect(f.discard).toHaveBeenCalledWith("synthetic-explicit-home");
      expect(f.configDir).not.toHaveBeenCalled();
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.options.dispatch).not.toHaveBeenCalled();
      expect(f.options.loadPickerRoutes).not.toHaveBeenCalled();
    });
  }
}

test("legacy cleanup resolves the default config home when no override is given", async () => {
  const f = fixture();
  delete f.options.configDir;
  f.options.config.claudeCode!.enabled = false;
  f.lifecycle.start(f.options);
  expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "disabled" });
  expect(f.discard).toHaveBeenCalledWith("synthetic-default-home");
});

test("legacy cleanup keeps config-directory resolution failure best-effort", async () => {
  const f = fixture();
  delete f.options.configDir;
  f.configDir.mockImplementation(() => { throw new Error("synthetic path failure"); });
  f.options.config.claudeCode!.enabled = false;
  f.lifecycle.start(f.options);
  expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "disabled" });
  expect(f.configDir).toHaveBeenCalled();
  expect(f.discard).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

for (const explicitPort of [false, true]) {
  test(`legacy cleanup precedes an eligible start with explicit port=${explicitPort}`, async () => {
    const f = fixture();
    if (explicitPort) {
      f.options.requestedPort = 0;
      f.options.config.claudeCode!.intercept = { port: 10200 };
    }
    f.lifecycle.start(f.options);
    const first = f.lifecycle.ensure();
    expect(f.lifecycle.ensure()).toBe(first);
    expect((await first).ok).toBe(true);
    expect(f.events).toEqual(["cleanup", "observe", "start"]);
    expect(f.lifecycle.ownsListener(f.handle.listener)).toBe(true);
    await f.lifecycle.ensure();
    expect(f.discard).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    await f.lifecycle.stop();
    expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "stopped" });
    expect(f.discard).toHaveBeenCalledTimes(1);
    expect(f.handle.stop).toHaveBeenCalledTimes(1);
  });
}

test("legacy cleanup failure does not block a later enabled start", async () => {
  const f = fixture();
  f.options.config.claudeCode!.enabled = false;
  f.discard.mockImplementation(() => { f.events.push("cleanup"); throw new Error("synthetic cleanup failure"); });
  f.lifecycle.start(f.options);
  expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "disabled" });
  f.events.length = 0;
  f.options.config.claudeCode!.enabled = true;
  expect((await f.lifecycle.ensure()).ok).toBe(true);
  expect(f.events).toEqual(["cleanup", "observe", "start"]);
  expect(f.start).toHaveBeenCalledTimes(1);
});

test("legacy cleanup is not attempted before start or after stop", async () => {
  const f = fixture();
  expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "failed" });
  await f.lifecycle.stop();
  f.lifecycle.start(f.options);
  expect(await f.lifecycle.ensure()).toEqual({ ok: false, reason: "stopped" });
  expect(f.discard).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});
